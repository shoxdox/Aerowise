import { createHash } from "node:crypto";
import type { EmailTransport } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { amountDue, dateInZone, invoiceSnapshot, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@aerowise/domain";
import { dollars, invoiceEvent, type Executor, type PaymentProvider } from "@aerowise/payments";
import { renderInvoice, type InvoiceAccount } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import { fromLine, longDay, paysOnline, replyToOf } from "./customer-email.ts";
import { payUrlFor } from "./links.ts";
import { enqueue } from "./queue.ts";

export const RENDER_INVOICE = "invoices.render";
export const SEND_INVOICE = "invoices.send";
export const SEND_RECEIPT = "invoices.receipt";

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
 * invoice that already has its PDF is left alone, and only one writer can set it. The pay
 * link is printed only when the customer can pay online.
 */
export async function renderInvoicePdf(db: Database, store: ObjectStore, organizationId: string, invoiceId: string, appUrl: string, payments?: PaymentProvider | null) {
  const inv = await db
    .selectFrom("invoices")
    .select(["id", "status", "number", "snapshot", "pdfStorageKey"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", invoiceId)
    .executeTakeFirst();
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  if (inv.pdfStorageKey) return inv.pdfStorageKey;
  if (inv.status === "draft" || !inv.snapshot) throw new Error(`invoice ${invoiceId} is not issued`);
  const snapshot = invoiceSnapshot.parse(inv.snapshot);
  const online = inv.status === "open" && (await paysOnline(db, organizationId, payments));
  const pdf = await renderInvoice(snapshot, { payUrl: online ? payUrlFor(appUrl, inv.id) : null });
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
 * The invoice PDF a customer or the office downloads. Until money comes in it is the copy
 * made at issue. After that it is drawn again from the same snapshot with what has been paid
 * and what is still due, so a paid invoice reads as paid, with its date, never as owed.
 * Null while the issued copy is still being made.
 */
export async function currentInvoicePdf(
  ctx: { db: Database; store: ObjectStore; appUrl: string; payments?: PaymentProvider | null },
  organizationId: string,
  invoiceId: string,
): Promise<{ stored: string } | { drawn: Buffer } | null> {
  const inv = await ctx.db
    .selectFrom("invoices as i")
    .innerJoin("organizations as o", "o.id", "i.organizationId")
    .select(["i.id", "i.status", "i.snapshot", "i.pdfStorageKey", "i.totalCents", "i.paidCents", "i.pendingCents", "i.creditedCents", "i.paidAt", "o.timezone"])
    .where("i.organizationId", "=", organizationId)
    .where("i.id", "=", invoiceId)
    .executeTakeFirst();
  if (!inv?.pdfStorageKey || !inv.snapshot) return null;
  if (inv.status !== "open" || inv.paidCents + inv.pendingCents + inv.creditedCents === 0) return { stored: inv.pdfStorageKey };
  const account: InvoiceAccount = {
    paidCents: inv.paidCents,
    pendingCents: inv.pendingCents,
    creditedCents: inv.creditedCents,
    amountDueCents: amountDue(inv),
    paidOn: inv.paidAt ? dateInZone(inv.paidAt, inv.timezone) : null,
  };
  const online = account.amountDueCents > 0 && (await paysOnline(ctx.db, organizationId, ctx.payments));
  return { drawn: await renderInvoice(invoiceSnapshot.parse(inv.snapshot), { payUrl: online ? payUrlFor(ctx.appUrl, inv.id) : null, account }) };
}

/**
 * Emails an open invoice with its PDF and pay link. Each send has its own number; the
 * same number always means the same message, so a retried task never emails twice. The
 * first send is the invoice; a later one is a reminder of the balance still due, and is
 * dropped when nothing is due any more. The pay link is offered only when the customer can
 * pay online, and replies go to the provider.
 */
export async function sendInvoice(
  ctx: { db: Database; store: ObjectStore; mail: EmailTransport; now: () => Date; appUrl: string; from?: string; payments?: PaymentProvider | null },
  organizationId: string,
  invoiceId: string,
  sendNo: number,
) {
  const { db } = ctx;
  const inv = await db
    .selectFrom("invoices as i")
    .innerJoin("organizations as o", "o.id", "i.organizationId")
    .select(["i.id", "i.status", "i.customerId", "i.snapshot", "i.totalCents", "i.paidCents", "i.pendingCents", "i.creditedCents", "o.name as orgName", "o.phone as orgPhone", "o.email as orgEmail", "o.timezone"])
    .where("i.organizationId", "=", organizationId)
    .where("i.id", "=", invoiceId)
    .executeTakeFirst();
  if (!inv) throw new Error(`invoice ${invoiceId} not found`);
  // Voided after the send was queued: the customer should not get it.
  if (inv.status !== "open") return;
  const due = amountDue(inv);
  const reminder = sendNo > 1;
  // Paid since the reminder was asked for: there is nothing to remind them of.
  if (reminder && due === 0) return;
  const snapshot = invoiceSnapshot.parse(inv.snapshot);
  const to = (await billingEmail(db, organizationId, inv.customerId)) ?? snapshot.billTo.email;
  if (!to) throw new Error("No email address on file for this customer");

  const key = await renderInvoicePdf(db, ctx.store, organizationId, invoiceId, ctx.appUrl, ctx.payments);
  const current = await currentInvoicePdf(ctx, organizationId, invoiceId);
  const pdf = current && "drawn" in current ? current.drawn : await ctx.store.get(key);
  if (!pdf) throw new Error(`invoice PDF ${key} is missing from storage`);
  const payUrl = payUrlFor(ctx.appUrl, inv.id);
  const online = due > 0 && (await paysOnline(db, organizationId, ctx.payments));
  const contact = [inv.orgPhone, inv.orgEmail].filter(Boolean).join(" or ");
  const n = snapshot.number;
  const late = snapshot.dueOn < dateInZone(ctx.now(), inv.timezone);
  const subject = reminder
    ? `Reminder: ${dollars(due)} still due on invoice ${n} from ${inv.orgName}`
    : due === 0
      ? `Invoice ${n} from ${inv.orgName}: paid in full`
      : `Invoice ${n} from ${inv.orgName}: ${dollars(due)} due ${longDay(snapshot.dueOn)}`;
  const summary = reminder
    ? `This is a reminder that ${dollars(due)} is still due on invoice ${n}${due < snapshot.totalCents ? ` (of ${dollars(snapshot.totalCents)})` : ""}. It ${late ? "was" : "is"} due on ${longDay(snapshot.dueOn)}. A copy is attached.`
    : due === 0
      ? `Your invoice ${n} for ${dollars(snapshot.totalCents)} is attached. It is paid in full; nothing is due.`
      : due < snapshot.totalCents
        ? `Your invoice ${n} for ${dollars(snapshot.totalCents)} is attached. Of that, ${dollars(due)} is still due, by ${longDay(snapshot.dueOn)}.`
        : `Your invoice ${n} for ${dollars(snapshot.totalCents)} is attached. It is due on ${longDay(snapshot.dueOn)}.`;
  const howToPay =
    due === 0
      ? `View it online: ${payUrl}`
      : online
        ? `View and pay it online by card or bank transfer: ${payUrl}`
        : `Please pay by check made out to ${inv.orgName}, with ${n} written on it. You can view the invoice here: ${payUrl}`;
  const result = await ctx.mail.send({
    organizationId,
    idempotencyKey: `invoice-${invoiceId}-send-${sendNo}`,
    from: fromLine(inv.orgName, ctx.from ?? "billing@aerowise.invalid"),
    to,
    replyTo: replyToOf(inv.orgEmail),
    subject,
    text: [`Hello ${snapshot.billTo.name},`, "", summary, "", howToPay, "", contact ? `Questions? Reach us at ${contact}.` : "", "", `Thank you,`, inv.orgName].join("\n"),
    attachments: [{ filename: `${n}.pdf`, contentType: "application/pdf", content: pdf }],
  });
  const now = ctx.now();
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("invoices").set({ sentAt: now, updatedAt: now }).where("organizationId", "=", organizationId).where("id", "=", invoiceId).execute();
    await invoiceEvent(trx, { organizationId, invoiceId, eventType: "sent", summary: `${reminder ? "Reminder emailed" : "Emailed"} to ${to}`, details: { messageId: result.messageId, sendNo }, at: now });
  });
}

/** Queues a receipt for a payment the office recorded, in the caller's transaction. */
export async function queueReceipt(trx: Executor, organizationId: string, paymentId: string, now: Date) {
  await enqueue(trx, { kind: SEND_RECEIPT, organizationId, payload: { paymentId }, dedupeKey: `invoice-receipt-${paymentId}`, runAt: now });
}

/**
 * Emails the customer a receipt for a payment the office recorded (a check, cash): what came
 * in, on which invoice, and what is still due. A customer with no email on file gets none.
 */
export async function sendReceipt(ctx: { db: Database; mail: EmailTransport; appUrl: string; from?: string }, organizationId: string, paymentId: string) {
  const { db } = ctx;
  const p = await db
    .selectFrom("payments as p")
    .innerJoin("invoices as i", "i.id", "p.invoiceId")
    .innerJoin("organizations as o", "o.id", "p.organizationId")
    .select([
      "p.amountCents",
      "p.method",
      "p.reference",
      "p.receivedOn",
      "p.status",
      "i.id as invoiceId",
      "i.status as invoiceStatus",
      "i.customerId",
      "i.snapshot",
      "i.totalCents",
      "i.paidCents",
      "i.pendingCents",
      "i.creditedCents",
      "o.name as orgName",
      "o.phone as orgPhone",
      "o.email as orgEmail",
    ])
    .where("p.organizationId", "=", organizationId)
    .where("p.id", "=", paymentId)
    .executeTakeFirst();
  if (!p) throw new Error(`payment ${paymentId} not found`);
  if (p.status !== "succeeded" || p.invoiceStatus !== "open" || !p.snapshot) return;
  const to = await billingEmail(db, organizationId, p.customerId);
  if (!to) return;
  const snapshot = invoiceSnapshot.parse(p.snapshot);
  const due = amountDue(p);
  const how = `${PAYMENT_METHOD_LABELS[p.method as PaymentMethod].toLowerCase()}${p.reference ? ` (${p.reference})` : ""}`;
  const contact = [p.orgPhone, p.orgEmail].filter(Boolean).join(" or ");
  await ctx.mail.send({
    organizationId,
    idempotencyKey: `invoice-receipt-${paymentId}`,
    from: fromLine(p.orgName, ctx.from ?? "billing@aerowise.invalid"),
    to,
    replyTo: replyToOf(p.orgEmail),
    subject: `Payment received: ${dollars(p.amountCents)} on invoice ${snapshot.number}`,
    text: [
      `Hello ${snapshot.billTo.name},`,
      "",
      `We received your payment of ${dollars(p.amountCents)} by ${how}${p.receivedOn ? ` on ${longDay(p.receivedOn)}` : ""}, for invoice ${snapshot.number}.`,
      due === 0
        ? "The invoice is paid in full."
        : `${dollars(due)} is still due on it, by ${longDay(snapshot.dueOn)}. You can view the invoice here: ${payUrlFor(ctx.appUrl, p.invoiceId)}`,
      "",
      contact ? `Questions? Reach us at ${contact}.` : "",
      "",
      "Thank you,",
      p.orgName,
    ].join("\n"),
    attachments: [],
  });
}
