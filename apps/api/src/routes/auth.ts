import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyPassword, type Database } from "@aerowise/db";
import { INTROS, isReadOnly, LEGAL_DOCUMENTS, organizationSubscription, ROLES } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "kysely";
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
  /** The first-run intros this person has closed (W10.4). */
  introsDismissed: z.array(z.enum(INTROS)),
  /** Present when a platform admin is looking at the organization read-only for support. */
  support: z.object({ adminName: z.string(), expiresAt: z.iso.datetime() }).optional(),
  /**
   * Demo companies only: proof that this id is a demo company, which the technician app keeps
   * so it can later learn that the company was removed (STG-03). Says nothing else.
   */
  demoTicket: z.string().optional(),
});

const demoTicket = (key: string, organizationId: string) => createHmac("sha256", key).update(`demo-ticket.${organizationId}`).digest("base64url");

function verifyDemoTicket(key: string, organizationId: string, ticket: unknown) {
  if (typeof ticket !== "string") return false;
  const expected = Buffer.from(demoTicket(key, organizationId));
  const given = Buffer.from(ticket);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function loadMe(db: Database, auth: Pick<AuthContext, "userId" | "organizationId" | "role" | "support">) {
  if (auth.support) return loadSupportMe(db, auth.organizationId, auth.support);
  const { introsDismissed, ...user } = await db.selectFrom("users").select(["id", "name", "email", "introsDismissed"]).where("id", "=", auth.userId).executeTakeFirstOrThrow();
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
    introsDismissed: knownIntros(introsDismissed),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const knownIntros = (keys: string[]) => INTROS.filter((k) => keys.includes(k));

/** Support sees the organization as its owner does, but signed in as themselves. */
async function loadSupportMe(db: Database, organizationId: string, support: NonNullable<AuthContext["support"]>) {
  const o = await db
    .selectFrom("organizations")
    .select(["id", "name", "timezone", "subscriptionState", "subscriptionEndsOn"])
    .where("id", "=", organizationId)
    .executeTakeFirstOrThrow();
  return {
    user: { id: support.adminId, name: `Aerowise support (${support.adminName})`, email: support.adminEmail },
    organization: {
      id: o.id,
      name: o.name,
      timezone: o.timezone,
      subscription: { state: o.subscriptionState, endsOn: o.subscriptionEndsOn, readOnly: isReadOnly(o.subscriptionState) },
    },
    role: "owner" as const,
    organizations: [{ id: o.id, name: o.name, role: "owner" as const }],
    legalDue: [],
    // Support is looking, not learning the screens.
    introsDismissed: [...INTROS],
    support: { adminName: support.adminName, expiresAt: support.expiresAt.toISOString() },
  };
}

export const authRoutes: FastifyPluginAsyncZod<{ db: Database; production: boolean; loginRateLimit: number; demoTicketKey: string }> = async (
  app,
  { db, production, loginRateLimit, demoTicketKey },
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
    {
      config: { public: true },
      schema: {
        tags: ["auth"],
        summary: "Sign out",
        body: z
          .object({
            /**
             * The technician app signed out with no signal, at this time: once it has signal it ends the
             * session it had then, but not one signed in since on that phone (by the same person or another).
             */
            signedInBefore: z.iso.datetime().optional(),
          })
          .optional(),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const before = req.body?.signedInBefore;
      if (req.auth && before) {
        const session = await db.selectFrom("sessions").select("createdAt").where("id", "=", req.auth.sessionId).executeTakeFirst();
        if (session && session.createdAt > new Date(before)) return reply.status(204).send(null);
      }
      if (req.auth) await revokeSession(db, req.auth.sessionId);
      reply.clearCookie(SESSION_COOKIE, cookieOptions);
      return reply.status(204).send(null);
    },
  );

  // The technician app asks this after its sign-in is refused, to tell a demo that has ended
  // (its data can leave the phone) from an expired session (its queued work must stay). Ending
  // a demo deletes its sessions, so the refused cookie cannot say which. "ended" means: a demo
  // company past its end, or, with that company's demo ticket (handed out by /auth/me only to
  // demo companies), a demo company that no longer exists at all (the nightly reset removes
  // the public ones). Every other id, live, deleted, unknown or malformed, answers "unknown"
  // the same way, so this says nothing about whether any real company exists.
  app.post(
    "/auth/access-status",
    {
      config: { public: true, rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: (req) => req.ip } },
      schema: {
        tags: ["auth"],
        summary: "Whether a demo company's access has ended, so a phone can clear its saved copy",
        body: z.object({ organizationId: z.unknown(), demoTicket: z.unknown() }).partial(),
        response: { 200: z.object({ state: z.enum(["ended", "unknown"]) }) },
      },
    },
    async (req) => {
      const { organizationId: id, demoTicket } = req.body;
      if (typeof id !== "string" || !UUID.test(id)) return { state: "unknown" as const };
      const org = await db.selectFrom("organizations").select(["demo", "demoExpiresAt"]).where("id", "=", id).executeTakeFirst();
      const pastEnd = org?.demo === true && org.demoExpiresAt !== null && org.demoExpiresAt <= new Date();
      // A company is demo or real from the moment it is made, so an id that was a demo
      // company and no longer exists can only be a removed demo.
      const removedDemo = !org && verifyDemoTicket(demoTicketKey, id, demoTicket);
      return { state: pastEnd || removedDemo ? ("ended" as const) : ("unknown" as const) };
    },
  );

  app.get(
    "/auth/me",
    { config: { permission: "self:read" }, schema: { tags: ["auth"], summary: "Current user and organization", response: { 200: meResponse } } },
    async (req) => {
      const auth = req.requireAuth();
      const me = await loadMe(db, auth);
      const org = await db.selectFrom("organizations").select("demo").where("id", "=", auth.organizationId).executeTakeFirstOrThrow();
      return org.demo ? { ...me, demoTicket: demoTicket(demoTicketKey, auth.organizationId) } : me;
    },
  );

  app.put(
    "/auth/me/intros/:intro",
    {
      // Anyone signed in closes or reopens their own intro, also while the plan is read-only.
      config: { permission: "self:read", allowedWhenReadOnly: true },
      schema: {
        tags: ["auth"],
        summary: "Close or reopen a first-run intro for yourself",
        params: z.object({ intro: z.enum(INTROS) }),
        body: z.object({ dismissed: z.boolean() }),
        response: { 200: z.object({ introsDismissed: z.array(z.enum(INTROS)) }) },
      },
    },
    async (req) => {
      const { userId } = req.requireAuth();
      const { intro } = req.params;
      const row = await db
        .updateTable("users")
        .set({
          introsDismissed: req.body.dismissed
            ? sql<string[]>`array_append(array_remove(intros_dismissed, ${intro}), ${intro})`
            : sql<string[]>`array_remove(intros_dismissed, ${intro})`,
        })
        .where("id", "=", userId)
        .returning("introsDismissed")
        .executeTakeFirstOrThrow();
      return { introsDismissed: knownIntros(row.introsDismissed) };
    },
  );
};
