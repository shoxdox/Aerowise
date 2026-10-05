import { verifyPassword, type Database } from "@aerowise/db";
import { isReadOnly, LEGAL_DOCUMENTS, organizationSubscription, ROLES } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createSession, revokeSession, SESSION_COOKIE, type AuthContext } from "../auth/sessions.ts";
import { HttpError } from "../lib/errors.ts";
import { loadLegalStatus } from "../lib/legal.ts";

// Used when the email is unknown so a failed login takes the same time either way.
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export const meResponse = z.object({
  user: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
  organization: z.object({ id: z.uuid(), name: z.string(), timezone: z.string(), subscription: organizationSubscription }),
  role: z.enum(ROLES),
  organizations: z.array(z.object({ id: z.uuid(), name: z.string(), role: z.enum(ROLES) })),
  /** Documents this owner must accept before using the office screens (W8.3). Empty for other roles. */
  legalDue: z.array(z.enum(LEGAL_DOCUMENTS)),
});

export async function loadMe(db: Database, auth: Pick<AuthContext, "userId" | "organizationId" | "role">) {
  const user = await db.selectFrom("users").select(["id", "name", "email"]).where("id", "=", auth.userId).executeTakeFirstOrThrow();
  const organizations = await db
    .selectFrom("memberships as m")
    .innerJoin("organizations as o", "o.id", "m.organizationId")
    .select(["o.id", "o.name", "o.timezone", "o.subscriptionState", "o.subscriptionEndsOn", "m.role"])
    .where("m.userId", "=", auth.userId)
    .where("m.active", "=", true)
    .orderBy("o.name")
    .execute();
  const current = organizations.find((o) => o.id === auth.organizationId);
  if (!current) throw new Error("session organization missing from memberships");
  return {
    user,
    organization: {
      id: current.id,
      name: current.name,
      timezone: current.timezone,
      subscription: { state: current.subscriptionState, endsOn: current.subscriptionEndsOn, readOnly: isReadOnly(current.subscriptionState) },
    },
    role: auth.role,
    organizations: organizations.map((o) => ({ id: o.id, name: o.name, role: o.role })),
    legalDue: (await loadLegalStatus(db, auth)).due,
  };
}

export const authRoutes: FastifyPluginAsyncZod<{ db: Database; production: boolean; loginRateLimit: number }> = async (
  app,
  { db, production, loginRateLimit },
) => {
  const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: production };

  app.post(
    "/auth/login",
    {
      config: {
        public: true,
        rateLimit: {
          max: loginRateLimit,
          timeWindow: "1 minute",
          // After the body is parsed: the key includes the email, which onRequest cannot see.
          hook: "preHandler",
          keyGenerator: (req) => `${req.ip}:${String((req.body as { email?: unknown } | undefined)?.email ?? "").toLowerCase()}`,
        },
      },
      schema: {
        tags: ["auth"],
        summary: "Sign in with email and password",
        body: z.object({
          email: z.string().trim().max(320),
          password: z.string().max(200),
          organizationId: z.uuid().optional(),
        }),
        response: { 200: meResponse },
      },
    },
    async (req, reply) => {
      const { email, password, organizationId } = req.body;
      const user = await db
        .selectFrom("users")
        .select(["id", "passwordHash", "active"])
        .where((eb) => eb(eb.fn("lower", ["email"]), "=", email.toLowerCase()))
        .executeTakeFirst();
      const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !user.active || !user.passwordHash || !valid) {
        throw new HttpError(401, "invalid_credentials", "Email or password is incorrect");
      }

      let query = db
        .selectFrom("memberships")
        .select(["organizationId", "role"])
        .where("userId", "=", user.id)
        .where("active", "=", true)
        .orderBy("createdAt");
      if (organizationId) query = query.where("organizationId", "=", organizationId);
      const membership = await query.executeTakeFirst();
      if (!membership) throw new HttpError(401, "no_membership", "This account has no access to that organization");

      const session = await createSession(db, membership.organizationId, user.id);
      reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
      return loadMe(db, { userId: user.id, organizationId: membership.organizationId, role: membership.role });
    },
  );

  app.post(
    "/auth/logout",
    { config: { public: true }, schema: { tags: ["auth"], summary: "Sign out", response: { 204: z.null() } } },
    async (req, reply) => {
      if (req.auth) await revokeSession(db, req.auth.sessionId);
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/auth/me",
    { config: { permission: "self:read" }, schema: { tags: ["auth"], summary: "Current user and organization", response: { 200: meResponse } } },
    async (req) => loadMe(db, req.requireAuth()),
  );
};
