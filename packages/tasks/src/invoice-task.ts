import { createHash } from "node:crypto";
import type { EmailTransport } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { invoiceSnapshot } from "@aerowise/domain";
import { dollars, invoiceEvent, type Executor } from "@aerowise/payments";
import { renderInvoice } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";

export const RENDER_INVOICE = "invoices.render";
export const SEND_INVOICE = "invoices.send";

export const payUrlFor = (appUrl: string, token: string) => `${appUrl.replace(/\/$/, "")}/pay/${token}`;

/**
 * Where an invoice goes: the customer's billing contact, else their primary contact,
 * else any contact with an email. Invoices are transactional, so marketing consent does
 * not apply.
 */
export async function billingEmail(db: Executor, organizationId: string, customerId: string): Promise<string | null> {
  const contacts = await db
    .selectFrom("contacts")
    .select(["email", "type"])
    .where("organizationId", "=", organizationId)
    .where("customerId", "=", customerId)
    .where("email", "is not", null)
    .orderBy("createdAt")
    .execute();
  const rank = (t: string) => (t === "billing" ? 0 : t === "primary" ? 1 : 2);
  return contacts.sort((a, b) => rank(a.type) - rank(b.type))[0]?.email ?? null;
}

/**
 * Draws an issued invoice's PDF from its snapshot and stores it. Safe to run again: an
 * invoice that already has its PDF is left alone, and only one writer can set it.
 */
export async function renderInvoicePdf(db: Database, store: ObjectStore, organizationId: string, invoiceId: string, appUrl: string) {
  const inv = await db
    .selectFrom("invoices")
    .select(["id", "status", "number", "snapshot", "publicToken", "pdfStorageKey"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", invoiceId)
    .executeTakeFirst();
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (inv.pdfStorageKey) return inv.pdfStorageKey;
  if (inv.status === "draft" || !inv.snapshot || !inv.publicToken) throw new Error(`invoice ${invoiceId} is not issued`);
  const snapshot = invoiceSnapshot.parse(inv.snapshot);
  const pdf = await renderInvoice(snapshot, { payUrl: inv.status === "open" ? payUrlFor(appUrl, inv.publicToken) : null });
  const sha256 = createHash("sha256").update(pdf).digest("hex");
  const key = `${organizationId}/invoices/${invoiceId}/${snapshot.number}-${sha256.slice(0, 12)}.pdf`;
  await store.put(key, pdf, "application/pdf");
  const res = await db
    .updateTable("invoices")
    .set({ pdfStorageKey: key, pdfSha256: sha256, pdfByteSize: pdf.length })
    .where("organizationId", "=", organizationId)
    .where("id", "=", invoiceId)
    .where("pdfStorageKey", "is", null)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) === 1) return key;
  // Another worker got there first; keep theirs.
  const winner = await db.selectFrom("invoices").select("pdfStorageKey").where("id", "=", invoiceId).executeTakeFirstOrThrow();
  return winner.pdfStorageKey!;
}

/**
 * Emails an open invoice with its PDF and pay link. Each send has its own number; the
 * same number always means the same message, so a retried task never emails twice.
 */
export async function sendInvoice(
  ctx: { db: Database; store: ObjectStore; mail: EmailTransport; now: () => Date; appUrl: string; from?: string },
  organizationId: string,
  invoiceId: string,
  sendNo: number,
) {
  const { db } = ctx;
  const inv = await db
    .selectFrom("invoices as i")
    .innerJoin("organizations as o", "o.id", "i.organizationId")
    .select(["i.id", "i.status", "i.customerId", "i.snapshot", "i.publicToken", "o.name as orgName", "o.phone as orgPhone", "o.email as orgEmail"])
    .where("i.organizationId", "=", organizationId)
    .where("i.id", "=", invoiceId)
    .executeTakeFirst();
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  // Voided after the send was queued: the customer should not get it.
  if (inv.status !== "open") return;
  const snapshot = invoiceSnapshot.parse(inv.snapshot);
  const to = (await billingEmail(db, organizationId, inv.customerId)) ?? snapshot.billTo.email;
  if (!to) throw new Error("No email address on file for this customer");

  const key = await renderInvoicePdf(db, ctx.store, organizationId, invoiceId, ctx.appUrl);
  const pdf = await ctx.store.get(key);
  if (!pdf) throw new Error(`invoice PDF ${key} is missing from storage`);
  const payUrl = payUrlFor(ctx.appUrl, inv.publicToken!);
  const contact = [inv.orgPhone, inv.orgEmail].filter(Boolean).join(" or ");
  const result = await ctx.mail.send({
    organizationId,
    idempotencyKey: `invoice-${invoiceId}-send-${sendNo}`,
    from: `"${inv.orgName.replace(/"/g, "")}" <${ctx.from ?? "billing@aerowise.invalid"}>`,
    to,
    subject: `Invoice ${snapshot.number} from ${inv.orgName}: ${dollars(snapshot.totalCents)} due ${snapshot.dueOn}`,
    text: [
      `Hello ${snapshot.billTo.name},`,
      "",
      `Your invoice ${snapshot.number} for ${dollars(snapshot.totalCents)} is attached. It is due on ${snapshot.dueOn}.`,
      "",
      `View and pay it online by card or bank transfer: ${payUrl}`,
      "",
      contact ? `Questions? Reach us at ${contact}.` : "",
      "",
      `Thank you,`,
      inv.orgName,
    ].join("\n"),
    attachments: [{ filename: `${snapshot.number}.pdf`, contentType: "application/pdf", content: pdf }],
  });
  const now = ctx.now();
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("invoices").set({ sentAt: now, updatedAt: now }).where("organizationId", "=", organizationId).where("id", "=", invoiceId).execute();
    await invoiceEvent(trx, { organizationId, invoiceId, eventType: "sent", summary: `Emailed to ${to}`, details: { messageId: result.messageId, sendNo }, at: now });
  });
}
