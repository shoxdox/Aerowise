import { createHash, randomBytes } from "node:crypto";
import type { EmailTransport } from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import { INVITE_DAYS, invitationStatus, type Invitation, type Role } from "@aerowise/domain";
import type { FastifyBaseLogger } from "fastify";
import type { Transaction } from "kysely";
import { sql } from "kysely";
import { HttpError } from "./errors.ts";

type Executor = Database | Transaction<DB>;

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest();
export const inviteUrlFor = (appUrl: string, token: string) => `${appUrl.replace(/\/$/, "")}/invite/${token}`;

const newToken = () => randomBytes(32).toString("base64url");

export interface InvitationMail {
  mail: EmailTransport;
  appUrl: string;
  from: string;
}

type Inviter = { userId: string } | { adminId: string };

/**
 * Makes an invitation and returns its token, which only the caller ever sees. An open
 * invitation for the same email is revoked first, so each person has one live link.
 */
export async function createInvitation(
  trx: Executor,
  i: { organizationId: string; email: string; name: string | null; role: Role; by: Inviter; now: Date },
) {
  const email = i.email.trim().toLowerCase();
  const member = await trx
    .selectFrom("memberships as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select(["m.userId", "m.active"])
    .where("m.organizationId", "=", i.organizationId)
    .where(sql`lower(u.email)`, "=", email)
    .executeTakeFirst();
  if (member?.active) throw new HttpError(409, "already_member", "That person is already a member of this organization");
  // Bringing back someone an owner deactivated is the owner's call, not a new invitation.
  if (member) throw new HttpError(409, "deactivated_member", "That person was deactivated. An owner can reactivate them on the Users page.");

  await trx
    .updateTable("invitations")
    .set({ revokedAt: i.now })
    .where("organizationId", "=", i.organizationId)
    .where(sql`lower(email)`, "=", email)
    .where("acceptedAt", "is", null)
    .where("revokedAt", "is", null)
    .execute();

  const token = newToken();
  const row = await trx
    .insertInto("invitations")
    .values({
      organizationId: i.organizationId,
      email,
      name: i.name,
      role: i.role,
      tokenHash: hashInviteToken(token),
      invitedByUserId: "userId" in i.by ? i.by.userId : null,
      invitedByAdminId: "adminId" in i.by ? i.by.adminId : null,
      sentAt: i.now,
      expiresAt: new Date(i.now.getTime() + INVITE_DAYS * 86_400_000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, token };
}

/** A fresh link for an open invitation: the old link stops working and the expiry restarts. */
export async function renewInvitationToken(trx: Executor, organizationId: string, invitationId: string, now: Date) {
  const token = newToken();
  const updated = await trx
    .updateTable("invitations")
    .set({ tokenHash: hashInviteToken(token), sentAt: now, expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000) })
    .where("organizationId", "=", organizationId)
    .where("id", "=", invitationId)
    .where("acceptedAt", "is", null)
    .where("revokedAt", "is", null)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) === 0) throw new HttpError(409, "invitation_closed", "This invitation was already accepted or cancelled");
  return token;
}

/** Invitations of an organization as the office sees them. */
export async function listInvitations(db: Executor, organizationId: string, now: Date, ids?: string[]): Promise<Invitation[]> {
  let q = db
    .selectFrom("invitations as i")
    .leftJoin("users as u", "u.id", "i.invitedByUserId")
    .select(["i.id", "i.email", "i.name", "i.role", "i.sentAt", "i.expiresAt", "i.acceptedAt", "i.revokedAt", "u.name as userName", "i.invitedByAdminId"])
    .where("i.organizationId", "=", organizationId)
    .orderBy("i.sentAt", "desc");
  if (ids) q = q.where("i.id", "in", ids);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    status: invitationStatus(r, now),
    invitedBy: r.userName ?? "Aerowise",
    sentAt: r.sentAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/**
 * Emails the link. Sent after the invitation is saved; if the provider fails, the
 * invitation stands and the inviter still has the link to share another way.
 */
export async function emailInvitation(
  db: Database,
  m: InvitationMail,
  log: FastifyBaseLogger,
  inv: { organizationId: string; invitationId: string; token: string; inviterName: string },
): Promise<boolean> {
  const row = await db
    .selectFrom("invitations as i")
    .innerJoin("organizations as o", "o.id", "i.organizationId")
    .select(["i.email", "i.name", "i.role", "i.expiresAt", "o.name as orgName"])
    .where("i.organizationId", "=", inv.organizationId)
    .where("i.id", "=", inv.invitationId)
    .executeTakeFirstOrThrow();
  const role = { owner: "an owner", office: "office staff", technician: "a technician", read_only: "a read-only user" }[row.role];
  try {
    await m.mail.send({
      organizationId: inv.organizationId,
      // One email per link: a new link (resend) is a new message.
      idempotencyKey: `invitation-${inv.invitationId}-${hashInviteToken(inv.token).toString("hex").slice(0, 16)}`,
      from: `"Aerowise" <${m.from}>`,
      to: row.email,
      subject: `${inv.inviterName} invited you to ${row.orgName} on Aerowise`,
      text: [
        row.name ? `Hello ${row.name},` : "Hello,",
        "",
        `${inv.inviterName} invited you to join ${row.orgName} on Aerowise as ${role}. Open this link to set your password and sign in:`,
        "",
        inviteUrlFor(m.appUrl, inv.token),
        "",
        `The link works once and expires on ${row.expiresAt.toUTCString()}. If you were not expecting this, you can ignore this email.`,
      ].join("\n"),
      attachments: [],
    });
    return true;
  } catch (err) {
    log.warn({ err, invitationId: inv.invitationId }, "invitation email failed");
    return false;
  }
}
