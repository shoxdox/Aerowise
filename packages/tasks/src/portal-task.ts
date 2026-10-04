import { createHash, randomBytes } from "node:crypto";
import type { EmailTransport } from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import { PORTAL_LINK_DAYS } from "@aerowise/domain";
import type { Transaction } from "kysely";

export const PORTAL_LINK_EMAIL = "portal.link_email";

type Executor = Database | Transaction<DB>;

export const portalUrlFor = (appUrl: string, token: string) => `${appUrl.replace(/\/$/, "")}/portal/${token}`;

/** Portal links are looked up by this hash; the token itself is never stored. */
export const hashPortalToken = (token: string) => createHash("sha256").update(token).digest();

/** Makes a new portal link for a customer and returns its token, which only the caller ever sees. */
export async function createPortalLink(
  db: Executor,
  link: { organizationId: string; customerId: string; source: "office" | "email" | "sms"; sentTo: string | null; createdBy: string | null; now: Date },
) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(link.now.getTime() + PORTAL_LINK_DAYS * 86_400_000);
  const row = await db
    .insertInto("portalLinks")
    .values({
      organizationId: link.organizationId,
      customerId: link.customerId,
      tokenHash: hashPortalToken(token),
      source: link.source,
      sentTo: link.sentTo,
      createdBy: link.createdBy,
      expiresAt,
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();
  return { id: row.id, token, expiresAt };
}

export interface PortalLinkEmail {
  customerId: string;
  to: string;
  source: "office" | "email";
  createdBy: string | null;
}

/**
 * Makes a fresh portal link and emails it. The link is made here, not when the email was
 * asked for, so its token is never written to the task queue. A retry makes another link,
 * but the idempotency key means only one email ever goes out per task.
 */
export async function sendPortalLink(
  ctx: { db: Database; mail: EmailTransport; appUrl: string; now: () => Date; from?: string },
  organizationId: string,
  taskId: string,
  p: PortalLinkEmail,
) {
  const { db } = ctx;
  const who = await db
    .selectFrom("customers as cu")
    .innerJoin("organizations as o", "o.id", "cu.organizationId")
    .select(["cu.displayName", "o.name as orgName", "o.phone as orgPhone", "o.email as orgEmail"])
    .where("cu.organizationId", "=", organizationId)
    .where("cu.id", "=", p.customerId)
    .executeTakeFirst();
  if (!who) return;
  const link = await createPortalLink(db, { organizationId, customerId: p.customerId, source: p.source, sentTo: p.to, createdBy: p.createdBy, now: ctx.now() });
  const contact = [who.orgPhone, who.orgEmail].filter(Boolean).join(" or ");
  await ctx.mail.send({
    organizationId,
    idempotencyKey: `portal-link-${taskId}`,
    from: `"${who.orgName.replace(/"/g, "")}" <${ctx.from ?? "billing@aerowise.invalid"}>`,
    to: p.to,
    subject: `Your septic service account with ${who.orgName}`,
    text: [
      `Hello ${who.displayName},`,
      "",
      `Here is your link to your account with ${who.orgName}. You can see your maintenance plan, your next visit, your inspection reports and your invoices, and ask us for service.`,
      "",
      portalUrlFor(ctx.appUrl, link.token),
      "",
      `The link works for ${PORTAL_LINK_DAYS} days. Keep it to yourself: anyone with it can see your account. You can ask for a new one at any time.`,
      p.source === "email" ? "If you did not ask for this link, you can ignore this email." : "",
      "",
      contact ? `Questions? Reach us at ${contact}.` : "",
      "",
      "Thank you,",
      who.orgName,
    ].join("\n"),
    attachments: [],
  });
}
