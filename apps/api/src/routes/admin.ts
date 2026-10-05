import { verifyPassword, type Database } from "@aerowise/db";
import { adminOrganization, adminOrganizationInput, platformAdminMe } from "@aerowise/domain";
import { sql } from "kysely";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ADMIN_SESSION_COOKIE, createAdminSession, findAdminSession, revokeAdminSession } from "../auth/admin-sessions.ts";
import { HttpError } from "../lib/errors.ts";
import { platformAudit } from "../lib/platform-audit.ts";

// Same shape as a real hash so an unknown email costs the same time as a wrong password.
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * The platform-admin console API. Every route except sign-in and sign-out is
 * `config.platformAdmin`, and every action writes a platform audit event.
 */
export const adminRoutes: FastifyPluginAsyncZod<{ db: Database; production: boolean; loginRateLimit: number; now: () => Date }> = async (
  app,
  { db, production, loginRateLimit, now },
) => {
  const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: production };

  async function loadAdmin(adminId: string) {
    return db.selectFrom("platformAdmins").select(["id", "name", "email"]).where("id", "=", adminId).executeTakeFirstOrThrow();
  }

  app.post(
    "/admin/auth/login",
    {
      config: {
        public: true,
        rateLimit: {
          max: loginRateLimit,
          timeWindow: "1 minute",
          keyGenerator: (req) => `admin:${req.ip}:${String((req.body as { email?: unknown } | undefined)?.email ?? "").toLowerCase()}`,
        },
      },
      schema: {
        tags: ["admin"],
        summary: "Platform admin sign-in",
        body: z.object({ email: z.string().trim().max(320), password: z.string().max(200) }),
        response: { 200: platformAdminMe },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const admin = await db
        .selectFrom("platformAdmins")
        .select(["id", "passwordHash", "active"])
        .where((eb) => eb(eb.fn("lower", ["email"]), "=", email.toLowerCase()))
        .executeTakeFirst();
      const valid = await verifyPassword(password, admin?.passwordHash ?? DUMMY_HASH);
      if (!admin || !admin.active || !valid) throw new HttpError(401, "invalid_credentials", "Email or password is incorrect");

      const session = await createAdminSession(db, admin.id);
      await platformAudit(db, req, { adminId: admin.id, action: "admin.signed_in", entityType: "platform_admin", entityId: admin.id });
      reply.setCookie(ADMIN_SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
      return loadAdmin(admin.id);
    },
  );

  app.post(
    "/admin/auth/logout",
    { config: { public: true }, schema: { tags: ["admin"], summary: "Platform admin sign-out", response: { 204: z.null() } } },
    async (req, reply) => {
      const token = req.cookies[ADMIN_SESSION_COOKIE];
      const session = token ? await findAdminSession(db, token) : null;
      if (session) {
        await revokeAdminSession(db, session.sessionId);
        await platformAudit(db, req, { adminId: session.adminId, action: "admin.signed_out", entityType: "platform_admin", entityId: session.adminId });
      }
      reply.clearCookie(ADMIN_SESSION_COOKIE, cookieOptions);
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/admin/auth/me",
    { config: { platformAdmin: true }, schema: { tags: ["admin"], summary: "Signed-in platform admin", response: { 200: platformAdminMe } } },
    async (req) => loadAdmin(req.requireAdmin().adminId),
  );

  app.get(
    "/admin/organizations",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Every organization with its usage",
        response: { 200: z.object({ items: z.array(adminOrganization) }) },
      },
    },
    async () => {
      const at = now();
      const rows = await db
        .selectFrom("organizations as o")
        .select([
          "o.id",
          "o.name",
          "o.timezone",
          "o.createdAt",
          // In force today in the organization's own time zone; cancelled contracts never count.
          sql<number>`(select count(*)::int from contracts c
            where c.organization_id = o.id and c.status = 'active'
              and (${at}::timestamptz at time zone o.timezone)::date between c.start_on and c.end_on)`.as("activeContracts"),
          sql<number>`(select count(*)::int from memberships m join users u on u.id = m.user_id
            where m.organization_id = o.id and m.active and u.active)`.as("users"),
          sql<Date | null>`greatest(
            (select max(a.occurred_at) from audit_events a where a.organization_id = o.id),
            (select max(s.created_at) from sessions s where s.organization_id = o.id))`.as("lastActivityAt"),
        ])
        .orderBy("o.name")
        .execute();
      return {
        items: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt).toISOString() : null,
        })),
      };
    },
  );

  app.post(
    "/admin/organizations",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Create an organization",
        body: adminOrganizationInput,
        response: { 201: adminOrganization },
      },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      const input = req.body;
      const org = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("organizations")
          .values({
            name: input.name,
            timezone: input.timezone,
            email: input.email ?? null,
            phone: input.phone ?? null,
            addressLine1: null,
            addressLine2: null,
            city: null,
            state: null,
            postalCode: null,
            logoUrl: null,
          })
          .returning(["id", "name", "timezone", "createdAt"])
          .executeTakeFirstOrThrow();
        await platformAudit(trx, req, {
          adminId,
          action: "organization.created",
          entityType: "organization",
          entityId: created.id,
          organizationId: created.id,
          changes: input,
        });
        return created;
      });
      return reply
        .status(201)
        .send({ ...org, createdAt: org.createdAt.toISOString(), activeContracts: 0, users: 0, lastActivityAt: null });
    },
  );
};
