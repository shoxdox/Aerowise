import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@aerowise/db";
import type { Role, SubscriptionState } from "@aerowise/domain";
import type { SupportContext } from "./support-sessions.ts";

export const SESSION_COOKIE = "aw_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthContext {
  sessionId: string;
  userId: string;
  organizationId: string;
  role: Role;
  /** The organization's Aerowise plan state; `read_only` refuses every write. */
  subscriptionState: SubscriptionState;
  /** Set when a platform admin is looking at the organization read-only for support. */
  support?: SupportContext;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest();

/** `endsAt`: an earlier end than the usual 30 days (a visitor's demo ends with its company). */
export async function createSession(db: Database, organizationId: string, userId: string, endsAt?: Date) {
  const token = randomBytes(32).toString("base64url");
  const usual = new Date(Date.now() + SESSION_TTL_MS);
  const expiresAt = endsAt && endsAt < usual ? endsAt : usual;
  await db
    .insertInto("sessions")
    .values({ tokenHash: hashToken(token), organizationId, userId, expiresAt })
    .execute();
  return { token, expiresAt };
}

/** Resolves a session token to an active user + active membership, or null. */
export async function findSession(db: Database, token: string): Promise<AuthContext | null> {
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.userId")
    .innerJoin("memberships as m", (join) =>
      join.onRef("m.organizationId", "=", "s.organizationId").onRef("m.userId", "=", "s.userId"),
    )
    .innerJoin("organizations as o", "o.id", "s.organizationId")
    .select(["s.id as sessionId", "s.userId", "s.organizationId", "m.role", "o.subscriptionState"])
    .where("s.tokenHash", "=", hashToken(token))
    .where("s.revokedAt", "is", null)
    .where("s.expiresAt", ">", new Date())
    .where("u.active", "=", true)
    .where("m.active", "=", true)
    // A visitor's demo company (W10.2) lets no one in once it has ended, whatever the session says.
    .where((eb) => eb.or([eb("o.demoExpiresAt", "is", null), eb("o.demoExpiresAt", ">", new Date())]))
    .executeTakeFirst();
  return row ?? null;
}

export async function revokeSession(db: Database, sessionId: string) {
  await db.updateTable("sessions").set({ revokedAt: new Date() }).where("id", "=", sessionId).execute();
}
