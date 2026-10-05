import { hashPassword, verifyPassword, type Database } from "@aerowise/db";
import {
  acceptInvitationInput,
  canInviteRole,
  invitationInput,
  invitationPreview,
  invitationSent,
  invitationStatus,
  USER_MIN_PASSWORD,
  usersOverview,
} from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { createSession, SESSION_COOKIE } from "../auth/sessions.ts";
import { audit } from "../lib/audit.ts";
import { forbidden, HttpError, notFound } from "../lib/errors.ts";
import {
  createInvitation,
  emailInvitation,
  hashInviteToken,
  inviteUrlFor,
  listInvitations,
  renewInvitationToken,
  type InvitationMail,
} from "../lib/invitations.ts";
import { loadMe, meResponse } from "./auth.ts";

const params = z.object({ id: z.uuid() });
const tokenParams = z.object({ token: z.string().min(16).max(200) });
// Per IP and token, like the other public links.
const publicLimit = { max: 20, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => `${req.ip}:${(req.params as { token?: string }).token ?? ""}` };
const iso = (d: Date) => d.toISOString();

export const userRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; production: boolean; invitations: InvitationMail }> = async (
  app,
  { db, now, production, invitations },
) => {
  const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: production };

  async function inviterName(userId: string) {
    return (await db.selectFrom("users").select("name").where("id", "=", userId).executeTakeFirstOrThrow()).name;
  }

  async function openInvitation(organizationId: string, id: string) {
    const row = await db
      .selectFrom("invitations")
      .select(["id", "role", "acceptedAt", "revokedAt"])
      .where("organizationId", "=", organizationId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) throw notFound("Invitation");
    return row;
  }

  app.get(
    "/users",
    {
      config: { permission: "users:read" },
      schema: { tags: ["users"], summary: "People in the organization and open invitations", response: { 200: usersOverview } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const at = now();
      const members = await db
        .selectFrom("memberships as m")
        .innerJoin("users as u", "u.id", "m.userId")
        .select(["u.id as userId", "u.name", "u.email", "m.role", "m.active", "u.active as userActive", "m.createdAt"])
        .where("m.organizationId", "=", organizationId)
        .orderBy("u.name")
        .execute();
      const invitationsList = (await listInvitations(db, organizationId, at)).filter((i) => i.status === "pending" || i.status === "expired");
      return {
        members: members.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role, active: m.active && m.userActive, joinedAt: iso(m.createdAt) })),
        invitations: invitationsList,
      };
    },
  );

  app.post(
    "/invitations",
    {
      config: { permission: "users:invite" },
      schema: {
        tags: ["users"],
        summary: "Invite someone by email",
        description: "Emails a single-use link and also returns it once, to share another way if the email does not arrive.",
        body: invitationInput,
        response: { 201: invitationSent },
      },
    },
    async (req, reply) => {
      const { organizationId, userId, role } = req.requireAuth();
      if (!canInviteRole(role, req.body.role)) throw forbidden();
      const at = now();
      const created = await db.transaction().execute(async (trx) => {
        const inv = await createInvitation(trx, { organizationId, email: req.body.email, name: req.body.name ?? null, role: req.body.role, by: { userId }, now: at });
        await audit(trx, req, { action: "invitation.sent", entityType: "invitation", entityId: inv.id, changes: { email: req.body.email, role: req.body.role } });
        return inv;
      });
      const emailed = await emailInvitation(db, invitations, req.log, { organizationId, invitationId: created.id, token: created.token, inviterName: await inviterName(userId) });
      const [invitation] = await listInvitations(db, organizationId, at, [created.id]);
      return reply.status(201).send({ invitation: invitation!, url: inviteUrlFor(invitations.appUrl, created.token), emailed });
    },
  );

  app.post(
    "/invitations/:id/resend",
    {
      config: { permission: "users:invite" },
      schema: {
        tags: ["users"],
        summary: "Send an invitation again with a fresh link",
        description: "The previous link stops working and the expiry restarts.",
        params,
        response: { 201: invitationSent },
      },
    },
    async (req, reply) => {
      const { organizationId, userId, role } = req.requireAuth();
      const existing = await openInvitation(organizationId, req.params.id);
      if (!canInviteRole(role, existing.role)) throw forbidden();
      const at = now();
      const token = await db.transaction().execute(async (trx) => {
        const t = await renewInvitationToken(trx, organizationId, req.params.id, at);
        await audit(trx, req, { action: "invitation.resent", entityType: "invitation", entityId: req.params.id });
        return t;
      });
      const emailed = await emailInvitation(db, invitations, req.log, { organizationId, invitationId: req.params.id, token, inviterName: await inviterName(userId) });
      const [invitation] = await listInvitations(db, organizationId, at, [req.params.id]);
      return reply.status(201).send({ invitation: invitation!, url: inviteUrlFor(invitations.appUrl, token), emailed });
    },
  );

  app.post(
    "/invitations/:id/revoke",
    {
      config: { permission: "users:invite" },
      schema: { tags: ["users"], summary: "Cancel an invitation", params, body: z.object({}).optional(), response: { 204: z.null() } },
    },
    async (req, reply) => {
      const { organizationId, role } = req.requireAuth();
      const existing = await openInvitation(organizationId, req.params.id);
      if (!canInviteRole(role, existing.role)) throw forbidden();
      if (existing.acceptedAt) throw new HttpError(409, "invitation_closed", "This invitation was already accepted");
      if (!existing.revokedAt) {
        await db.transaction().execute(async (trx) => {
          await trx.updateTable("invitations").set({ revokedAt: now() }).where("organizationId", "=", organizationId).where("id", "=", req.params.id).execute();
          await audit(trx, req, { action: "invitation.revoked", entityType: "invitation", entityId: req.params.id });
        });
      }
      return reply.status(204).send(null);
    },
  );

  // ---- The invited person's side (no sign-in; the link is the key) ----

  async function invitationFor(token: string) {
    const row = await db
      .selectFrom("invitations as i")
      .innerJoin("organizations as o", "o.id", "i.organizationId")
      .select(["i.id", "i.organizationId", "i.email", "i.name", "i.role", "i.expiresAt", "i.acceptedAt", "i.revokedAt", "o.name as organizationName"])
      .where("i.tokenHash", "=", hashInviteToken(token))
      .executeTakeFirst();
    if (!row) throw new HttpError(404, "invitation_not_found", "This invitation link is not valid. Ask for a new one.");
    const status = invitationStatus(row, now());
    if (status === "accepted") throw new HttpError(410, "invitation_used", "This invitation was already used. Sign in instead.");
    if (status === "revoked") throw new HttpError(410, "invitation_revoked", "This invitation was cancelled. Ask for a new one.");
    if (status === "expired") throw new HttpError(410, "invitation_expired", "This invitation has expired. Ask for a new one.");
    return row;
  }

  const userByEmail = (email: string) =>
    db.selectFrom("users").select(["id", "passwordHash", "active"]).where(sql`lower(email)`, "=", email.toLowerCase()).executeTakeFirst();

  app.get(
    "/invitations/accept/:token",
    {
      config: { public: true, rateLimit: publicLimit },
      schema: { tags: ["users"], summary: "What an invitation link is for", params: tokenParams, response: { 200: invitationPreview } },
    },
    async (req) => {
      const inv = await invitationFor(req.params.token);
      const user = await userByEmail(inv.email);
      return { organizationName: inv.organizationName, email: inv.email, name: inv.name, role: inv.role, existingUser: !!user };
    },
  );

  app.post(
    "/invitations/accept/:token",
    {
      config: { public: true, rateLimit: publicLimit },
      schema: {
        tags: ["users"],
        summary: "Accept an invitation and sign in",
        description: "A new person chooses a password. Someone who already has an Aerowise login confirms with that password instead.",
        params: tokenParams,
        body: acceptInvitationInput,
        response: { 200: meResponse },
      },
    },
    async (req, reply) => {
      const inv = await invitationFor(req.params.token);
      const { password } = req.body;
      const existing = await userByEmail(inv.email);
      if (existing) {
        if (!existing.active || !existing.passwordHash || !(await verifyPassword(password, existing.passwordHash))) {
          throw new HttpError(401, "invalid_credentials", "That is not the password for this email's Aerowise login");
        }
      } else if (password.length < USER_MIN_PASSWORD) {
        throw new HttpError(422, "weak_password", `Choose a password of at least ${USER_MIN_PASSWORD} characters`);
      }
      const name = req.body.name ?? inv.name;
      if (!existing && !name) throw new HttpError(422, "name_required", "Enter your name");
      const passwordHash = existing ? null : await hashPassword(password);

      const userId = await db.transaction().execute(async (trx) => {
        // Single use, even with two tabs racing: the row is locked and re-checked.
        const locked = await trx
          .selectFrom("invitations")
          .select(["acceptedAt", "revokedAt", "expiresAt"])
          .where("id", "=", inv.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (invitationStatus(locked, now()) !== "pending") throw new HttpError(410, "invitation_used", "This invitation was already used. Sign in instead.");

        const id =
          existing?.id ??
          (await trx.insertInto("users").values({ name: name!, email: inv.email, phone: null, passwordHash }).returning("id").executeTakeFirstOrThrow()).id;
        const membership = await trx
          .selectFrom("memberships")
          .select("active")
          .where("organizationId", "=", inv.organizationId)
          .where("userId", "=", id)
          .executeTakeFirst();
        if (membership?.active) throw new HttpError(409, "already_member", "You are already a member of this organization. Sign in instead.");
        if (membership) {
          await trx.updateTable("memberships").set({ role: inv.role, active: true }).where("organizationId", "=", inv.organizationId).where("userId", "=", id).execute();
        } else {
          await trx.insertInto("memberships").values({ organizationId: inv.organizationId, userId: id, role: inv.role, technicianLicense: null }).execute();
        }
        await trx.updateTable("invitations").set({ acceptedAt: now(), acceptedUserId: id }).where("id", "=", inv.id).execute();
        await trx
          .insertInto("auditEvents")
          .values({
            organizationId: inv.organizationId,
            actorUserId: id,
            action: "invitation.accepted",
            entityType: "invitation",
            entityId: inv.id,
            changes: JSON.stringify({ role: inv.role, newUser: !existing }),
            requestId: req.id,
          })
          .execute();
        return id;
      });

      const session = await createSession(db, inv.organizationId, userId);
      reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
      return loadMe(db, { userId, organizationId: inv.organizationId, role: inv.role });
    },
  );
};
