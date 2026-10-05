import { hashPassword, type Database } from "@aerowise/db";
import { passwordResetInput, passwordResetRequest, USER_MIN_PASSWORD } from "@aerowise/domain";
import { enqueue, hashResetToken, PASSWORD_RESET_EMAIL } from "@aerowise/tasks";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "kysely";
import { z } from "zod";
import { HttpError } from "../lib/errors.ts";

/** At most one reset email per person in this window, however often it is asked for. */
const EMAIL_EVERY_MS = 15 * 60_000;
const tokenParams = z.object({ token: z.string().min(16).max(200) });
const invalidLink = () => new HttpError(404, "invalid_reset_link", "This reset link is not valid or has expired. Ask for a new one.");

export const passwordResetRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; rateLimit: number }> = async (app, { db, now, rateLimit }) => {
  const perAddress = {
    // After the body is parsed, so the key really includes the email.
    hook: "preHandler" as const,
    max: rateLimit,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `reset:${req.ip}:${String((req.body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase()}`,
  };
  const perLink = { max: 20, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => `reset:${req.ip}:${(req.params as { token?: string }).token ?? ""}` };

  app.post(
    "/auth/password-reset",
    {
      config: { public: true, rateLimit: perAddress },
      schema: {
        tags: ["auth"],
        summary: "Email a password reset link",
        description: "Always answers 202, whether or not the email has a login, so the form cannot be used to find out who uses Aerowise.",
        body: passwordResetRequest,
        response: { 202: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase();
      const at = now();
      // A login without an active membership cannot sign in anywhere, so it gets no email either.
      const target = await db
        .selectFrom("users as u")
        .innerJoin("memberships as m", "m.userId", "u.id")
        .select(["u.id", "m.organizationId"])
        .where(sql`lower(u.email)`, "=", email)
        .where("u.active", "=", true)
        .where("m.active", "=", true)
        .orderBy("m.createdAt")
        .executeTakeFirst();
      if (target) {
        const bucket = Math.floor(at.getTime() / EMAIL_EVERY_MS);
        await enqueue(db, {
          kind: PASSWORD_RESET_EMAIL,
          organizationId: target.organizationId,
          payload: { userId: target.id },
          dedupeKey: `password-reset-${target.id}-${bucket}`,
          runAt: at,
        });
      }
      return reply.status(202).send({ ok: true });
    },
  );

  async function liveToken(token: string) {
    const row = await db
      .selectFrom("passwordResetTokens as t")
      .innerJoin("users as u", "u.id", "t.userId")
      .select(["t.id", "t.userId", "t.expiresAt", "t.usedAt", "u.email", "u.active"])
      .where("t.tokenHash", "=", hashResetToken(token))
      .executeTakeFirst();
    if (!row || row.usedAt || row.expiresAt <= now() || !row.active) throw invalidLink();
    return row;
  }

  app.get(
    "/auth/password-reset/:token",
    {
      config: { public: true, rateLimit: perLink },
      schema: { tags: ["auth"], summary: "Check a reset link", params: tokenParams, response: { 200: z.object({ email: z.string() }) } },
    },
    async (req) => ({ email: (await liveToken(req.params.token)).email }),
  );

  app.post(
    "/auth/password-reset/:token",
    {
      config: { public: true, rateLimit: perLink },
      schema: {
        tags: ["auth"],
        summary: "Choose a new password",
        description: "Spends every open reset link of the person and signs them out everywhere. They sign in again with the new password.",
        params: tokenParams,
        body: passwordResetInput,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const found = await liveToken(req.params.token);
      if (req.body.password.length < USER_MIN_PASSWORD) {
        throw new HttpError(422, "weak_password", `Choose a password of at least ${USER_MIN_PASSWORD} characters`);
      }
      const passwordHash = await hashPassword(req.body.password);
      const at = now();
      await db.transaction().execute(async (trx) => {
        // Single use, even when two tabs race: only one update finds the link unused.
        const spent = await trx
          .updateTable("passwordResetTokens")
          .set({ usedAt: at })
          .where("id", "=", found.id)
          .where("usedAt", "is", null)
          .executeTakeFirst();
        if (Number(spent.numUpdatedRows) === 0) throw invalidLink();
        await trx.updateTable("passwordResetTokens").set({ usedAt: at }).where("userId", "=", found.userId).where("usedAt", "is", null).execute();
        await trx.updateTable("users").set({ passwordHash }).where("id", "=", found.userId).execute();
        await trx.updateTable("sessions").set({ revokedAt: new Date() }).where("userId", "=", found.userId).where("revokedAt", "is", null).execute();
        const orgs = await trx.selectFrom("memberships").select("organizationId").where("userId", "=", found.userId).execute();
        for (const { organizationId } of orgs) {
          await trx
            .insertInto("auditEvents")
            .values({ organizationId, actorUserId: found.userId, action: "user.password_reset", entityType: "user", entityId: found.userId, changes: "{}", requestId: req.id })
            .execute();
        }
      });
      return reply.status(204).send(null);
    },
  );
};
