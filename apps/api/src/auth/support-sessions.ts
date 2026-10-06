import { createHash, randomBytes } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import type { Transaction } from "kysely";
import type { AuthContext } from "./sessions.ts";

// Read-only support access. A platform admin opens one organization and sees it as its
// owner does, under a separate cookie, for at most an hour. The auth plugin refuses every
// write made with it, so support can look but never change anything.

export const SUPPORT_SESSION_COOKIE = "aw_support_session";
export const SUPPORT_SESSION_TTL_MS = 60 * 60 * 1000;

export interface SupportContext {
  supportSessionId: string;
  adminId: string;
  adminName: string;
  adminEmail: string;
  expiresAt: Date;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest();

/** The organization's longest-standing active owner: whose view support sees. */
export async function supportViewUser(db: Database, organizationId: string) {
  return db
    .selectFrom("memberships as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select("m.userId")
    .where("m.organizationId", "=", organizationId)
    .where("m.role", "=", "owner")
    .where("m.active", "=", true)
    .where("u.active", "=", true)
    .orderBy("m.createdAt")
    .orderBy("m.userId")
    .executeTakeFirst();
}

export async function createSupportSession(db: Database | Transaction<DB>, input: { adminId: string; organizationId: string; reason: string }) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SUPPORT_SESSION_TTL_MS);
  const row = await db
    .insertInto("supportSessions")
    .values({ tokenHash: hashToken(token), adminId: input.adminId, organizationId: input.organizationId, reason: input.reason, expiresAt })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, token, expiresAt };
}

/**
 * Resolves a support token to a tenant context with the owner's role, marked as support.
 * The admin must still be active, and the organization must still have an active owner.
 */
export async function findSupportSession(db: Database, token: string): Promise<(AuthContext & { support: SupportContext }) | null> {
  const row = await db
    .selectFrom("supportSessions as s")
    .innerJoin("platformAdmins as a", "a.id", "s.adminId")
    .innerJoin("organizations as o", "o.id", "s.organizationId")
    .select(["s.id", "s.adminId", "s.organizationId", "s.expiresAt", "a.name as adminName", "a.email as adminEmail", "o.subscriptionState"])
    .where("s.tokenHash", "=", hashToken(token))
    .where("s.endedAt", "is", null)
    .where("s.expiresAt", ">", new Date())
    .where("a.active", "=", true)
    .executeTakeFirst();
  if (!row) return null;
  const owner = await supportViewUser(db, row.organizationId);
  if (!owner) return null;
  return {
    sessionId: row.id,
    userId: owner.userId,
    organizationId: row.organizationId,
    role: "owner",
    subscriptionState: row.subscriptionState,
    support: { supportSessionId: row.id, adminId: row.adminId, adminName: row.adminName, adminEmail: row.adminEmail, expiresAt: row.expiresAt },
  };
}
