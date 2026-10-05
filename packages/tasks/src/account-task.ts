import { createHash, randomBytes } from "node:crypto";
import type { EmailTransport } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { PASSWORD_RESET_MINUTES } from "@aerowise/domain";

export const PASSWORD_RESET_EMAIL = "account.password_reset_email";

export const hashResetToken = (token: string) => createHash("sha256").update(token).digest();
export const resetUrlFor = (appUrl: string, token: string) => `${appUrl.replace(/\/$/, "")}/reset-password/${token}`;

/**
 * Makes a reset link and emails it. The token is made here, not when the reset was asked
 * for, so it is never written to the task queue. A retry makes another link (both expire
 * within the hour), but the idempotency key means only one email goes out per task.
 */
export async function sendPasswordReset(
  ctx: { db: Database; mail: EmailTransport; appUrl: string; now: () => Date; from?: string },
  organizationId: string,
  taskId: string,
  p: { userId: string },
) {
  const user = await ctx.db.selectFrom("users").select(["id", "name", "email", "active"]).where("id", "=", p.userId).executeTakeFirst();
  if (!user?.active) return;
  const token = randomBytes(32).toString("base64url");
  const at = ctx.now();
  await ctx.db
    .insertInto("passwordResetTokens")
    .values({ userId: user.id, tokenHash: hashResetToken(token), expiresAt: new Date(at.getTime() + PASSWORD_RESET_MINUTES * 60_000) })
    .execute();
  await ctx.mail.send({
    organizationId,
    idempotencyKey: `password-reset-${taskId}`,
    from: `"Aerowise" <${ctx.from ?? "accounts@aerowise.invalid"}>`,
    to: user.email,
    subject: "Reset your Aerowise password",
    text: [
      `Hello ${user.name},`,
      "",
      "Someone asked to reset the password for your Aerowise login. If it was you, open this link to choose a new one:",
      "",
      resetUrlFor(ctx.appUrl, token),
      "",
      `The link works once, for ${PASSWORD_RESET_MINUTES} minutes. If you did not ask for this, you can ignore this email; your password stays the same.`,
    ].join("\n"),
    attachments: [],
  });
}
