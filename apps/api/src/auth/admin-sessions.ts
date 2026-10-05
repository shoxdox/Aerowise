import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@aerowise/db";

// Platform-admin sessions live in their own table under their own cookie. A tenant
// session token is never looked up here, and an admin token never in `sessions`, so
// neither kind of sign-in can stand in for the other.

export const ADMIN_SESSION_COOKIE = "aw_admin_session";
/** Shorter than a tenant session: the console reaches every organization. */
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AdminContext {
  sessionId: string;
  adminId: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest();

export async function createAdminSession(db: Database, adminId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_TTL_MS);
  await db.insertInto("platformAdminSessions").values({ tokenHash: hashToken(token), adminId, expiresAt }).execute();
  return { token, expiresAt };
}

/** Resolves a token to an active platform admin's live session, or null. */
export async function findAdminSession(db: Database, token: string): Promise<AdminContext | null> {
  const row = await db
    .selectFrom("platformAdminSessions as s")
    .innerJoin("platformAdmins as a", "a.id", "s.adminId")
    .select(["s.id as sessionId", "s.adminId"])
    .where("s.tokenHash", "=", hashToken(token))
    .where("s.revokedAt", "is", null)
    .where("s.expiresAt", ">", new Date())
    .where("a.active", "=", true)
    .executeTakeFirst();
  return row ?? null;
}

export async function revokeAdminSession(db: Database, sessionId: string) {
  await db.updateTable("platformAdminSessions").set({ revokedAt: new Date() }).where("id", "=", sessionId).execute();
}
