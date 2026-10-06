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

export async function createSession(db: Database, organizationId: string, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
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
    .executeTakeFirst();
  return row ?? null;
}

export async function revokeSession(db: Database, sessionId: string) {
  await db.updateTable("sessions").set({ revokedAt: new Date() }).where("id", "=", sessionId).execute();
}
