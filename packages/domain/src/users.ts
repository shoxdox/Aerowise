import { z } from "zod";
import { ROLES, type Role } from "./roles.ts";

// Company users: invitations, and the people in an organization.

/** How long an invitation link works. Sending it again makes a fresh link. */
export const INVITE_DAYS = 7;
export const USER_MIN_PASSWORD = 10;
/** How long a password reset link works. */
export const PASSWORD_RESET_MINUTES = 60;

/**
 * Who may invite whom. An owner may invite anyone; office staff may invite anyone but an
 * owner. Platform admins invite owners from /admin, outside these tenant roles.
 */
export function canInviteRole(inviter: Role, role: Role): boolean {
  if (inviter === "owner") return true;
  if (inviter === "office") return role !== "owner";
  return false;
}

export const invitationInput = z.object({
  email: z.email().max(320).transform((e) => e.trim().toLowerCase()),
  name: z.string().trim().min(1).max(200).optional(),
  role: z.enum(ROLES),
});
export type InvitationInput = z.infer<typeof invitationInput>;

/** An owner invitation sent from /admin: the role is always owner. */
export const ownerInvitationInput = invitationInput.omit({ role: true });

export const INVITATION_STATUSES = ["pending", "expired", "accepted", "revoked"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export function invitationStatus(i: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: Date): InvitationStatus {
  if (i.acceptedAt) return "accepted";
  if (i.revokedAt) return "revoked";
  return i.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
}

export const invitation = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.enum(ROLES),
  status: z.enum(INVITATION_STATUSES),
  invitedBy: z.string(),
  sentAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type Invitation = z.infer<typeof invitation>;

/** Returned once when an invitation is sent: the link to copy, and whether the email went out. */
export const invitationSent = z.object({ invitation, url: z.string(), emailed: z.boolean() });
export type InvitationSent = z.infer<typeof invitationSent>;

export const member = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  active: z.boolean(),
  joinedAt: z.iso.datetime({ offset: true }),
});
export type Member = z.infer<typeof member>;

export const usersOverview = z.object({ members: z.array(member), invitations: z.array(invitation) });
export type UsersOverview = z.infer<typeof usersOverview>;

/** What the invite link's page shows before anyone signs in. */
export const invitationPreview = z.object({
  organizationName: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.enum(ROLES),
  /** The email already has an Aerowise login: they confirm with that password instead of choosing one. */
  existingUser: z.boolean(),
});
export type InvitationPreview = z.infer<typeof invitationPreview>;

export const acceptInvitationInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  password: z.string().max(200),
});

export const passwordResetRequest = z.object({ email: z.string().trim().max(320) });
export const passwordResetInput = z.object({ password: z.string().max(200) });
