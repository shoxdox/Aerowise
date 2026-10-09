import type { Database } from "@aerowise/db";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createSupportSession, SUPPORT_SESSION_COOKIE, supportViewUser } from "../auth/support-sessions.ts";
import { endOpenSupportSessions } from "../lib/support.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { platformAudit } from "../lib/platform-audit.ts";

/**
 * Read-only support access from /admin. Starting and ending a support session each write
 * a platform audit event and an event in the organization's own audit log, so the
 * company can see when Aerowise looked and why.
 */
export const adminSupportRoutes: FastifyPluginAsyncZod<{ db: Database; production: boolean }> = async (app, { db, production }) => {
  const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: production };


  app.post(
    "/admin/organizations/:id/support",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Open an organization read-only for support",
        description: "Sets a support cookie good for an hour. Every write made with it is refused.",
        params: z.object({ id: z.uuid() }),
        body: z.object({ reason: z.string().trim().min(3).max(500) }),
        response: { 201: z.object({ expiresAt: z.iso.datetime() }) },
      },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      const organizationId = req.params.id;
      const org = await db.selectFrom("organizations").select("id").where("id", "=", organizationId).executeTakeFirst();
      if (!org) throw notFound("Organization");
      if (!(await supportViewUser(db, organizationId))) {
        throw new HttpError(409, "no_owner", "This company has no active owner yet, so there is nothing to look at as them.");
      }
      const session = await db.transaction().execute(async (trx) => {
        // One support view at a time: opening another company ends the previous one.
        await endOpenSupportSessions(trx, req, adminId, "replaced");
        const s = await createSupportSession(trx, { adminId, organizationId, reason: req.body.reason });
        const changes = { reason: req.body.reason, expiresAt: s.expiresAt.toISOString() };
        await platformAudit(trx, req, { adminId, action: "support.started", entityType: "support_session", entityId: s.id, organizationId, changes });
        await trx
          .insertInto("auditEvents")
          .values({ organizationId, actorUserId: null, action: "support.started", entityType: "support_session", entityId: s.id, changes: JSON.stringify(changes), requestId: req.id })
          .execute();
        return s;
      });
      reply.setCookie(SUPPORT_SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
      return reply.status(201).send({ expiresAt: session.expiresAt.toISOString() });
    },
  );

  app.post(
    "/admin/support/end",
    {
      config: { platformAdmin: true },
      schema: { tags: ["admin"], summary: "End read-only support access", body: z.object({}).optional() },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      await db.transaction().execute((trx) => endOpenSupportSessions(trx, req, adminId, "ended"));
      reply.clearCookie(SUPPORT_SESSION_COOKIE, cookieOptions);
      return reply.status(204).send();
    },
  );
};
