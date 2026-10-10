import { createHash } from "node:crypto";
import type { EmailTransport } from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import { addDays, agreementContent, dateInZone, daysBetween, REMINDER_DAYS, REMINDER_GAP_DAYS, SIGNABLE_STATUSES } from "@aerowise/domain";
import { dollars } from "@aerowise/payments";
import { activatePaidRenewals, createRenewal, RenewalError, sha256Hex, systemAudit } from "@aerowise/renewals";
import { renderAgreement } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import { sql, type Transaction } from "kysely";
import { billingEmail } from "./invoice-task.ts";
import { renewUrlFor } from "./links.ts";
import { enqueue } from "./queue.ts";
import { queueSms } from "./sms-task.ts";

export const RENEWAL_EMAIL = "renewals.email";
export const RENEWAL_AGREEMENT = "renewals.agreement";
export const RENEWAL_SWEEP = "renewals.sweep";

type Executor = Database | Transaction<DB>;

const longDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
};

/**
 * Queues the renewal email (the offer, or a reminder) and marks the renewal sent. Each send
 * has its own number, so a retried task never emails twice.
 */
export async function queueRenewalEmail(trx: Transaction<DB>, organizationId: string, renewalId: string, opts: { now: Date; reminderDays?: number }) {
  const r = await trx
    .updateTable("renewals")
    .set((eb) => ({
      sendCount: eb("sendCount", "+", 1),
      sentAt: opts.now,
      status: sql`case when status = 'upcoming' then 'sent' else status end`,
      ...(opts.reminderDays !== undefined ? { lastReminderDays: opts.reminderDays } : {}),
      updatedAt: opts.now,
    }))
    .where("organizationId", "=", organizationId)
    .where("id", "=", renewalId)
    .returning(["sendCount", "customerId", "siteId"])
    .executeTakeFirstOrThrow();
  // A reminder is texted too, to customers who get texts.
  if (opts.reminderDays !== undefined) {
    await queueSms(
      trx,
      organizationId,
      { kind: "renewal_reminder", customerId: r.customerId, siteId: r.siteId, relatedType: "renewal", relatedId: renewalId, dedupeKey: `renewal_reminder:${renewalId}:${opts.reminderDays}` },
      opts.now,
    );
  }
  await enqueue(trx, {
    kind: RENEWAL_EMAIL,
    organizationId,
    payload: { renewalId, sendNo: r.sendCount, reminder: opts.reminderDays !== undefined },
    dedupeKey: `renewal-email-${renewalId}-${r.sendCount}`,
    runAt: opts.now,
  });
  return r.sendCount;
}

/** Emails the homeowner their renewal link. Skips a renewal that can no longer be signed. */
export async function sendRenewalEmail(
  ctx: { db: Database; mail: EmailTransport; appUrl: string; from?: string },
  organizationId: string,
  renewalId: string,
  sendNo: number,
  reminder: boolean,
) {
  const { db } = ctx;
  const r = await db
    .selectFrom("renewals as r")
    .innerJoin("contracts as c", "c.id", "r.contractId")
    .innerJoin("customers as cu", "cu.id", "r.customerId")
    .innerJoin("organizations as o", "o.id", "r.organizationId")
    .select(["r.status", "r.customerId", "r.planName", "r.priceCents", "r.startOn", "r.endOn", "c.endOn as contractEndOn", "cu.displayName", "o.name as orgName", "o.phone as orgPhone", "o.email as orgEmail"])
    .where("r.organizationId", "=", organizationId)
    .where("r.id", "=", renewalId)
    .executeTakeFirst();
  if (!r) throw new Error(`renewal ${renewalId} not found`);
  if (!(SIGNABLE_STATUSES as readonly string[]).includes(r.status)) return;
  const to = await billingEmail(db, organizationId, r.customerId);
  if (!to) throw new Error("No email address on file for this customer");
  const link = renewUrlFor(ctx.appUrl, renewalId);
  const contact = [r.orgPhone, r.orgEmail].filter(Boolean).join(" or ");
  await ctx.mail.send({
    organizationId,
    idempotencyKey: `renewal-${renewalId}-send-${sendNo}`,
    from: `"${r.orgName.replace(/"/g, "")}" <${ctx.from ?? "billing@aerowise.invalid"}>`,
    to,
    subject: reminder
      ? `Reminder: your septic maintenance plan ends ${longDay(r.contractEndOn)}`
      : `Renew your septic maintenance plan with ${r.orgName}`,
    text: [
      `Hello ${r.displayName},`,
      "",
      `Your ${r.planName} maintenance plan with ${r.orgName} ends on ${longDay(r.contractEndOn)}.`,
      `Renewing keeps your aerobic system inspected and your reports filed on time. The next term runs ${longDay(r.startOn)} to ${longDay(r.endOn)} for ${dollars(r.priceCents)}.`,
      "",
      `Review, sign and pay in a couple of minutes: ${link}`,
      "",
      contact ? `Questions? Reach us at ${contact}.` : "",
      "",
      "Thank you,",
      r.orgName,
    ].join("\n"),
    attachments: [],
  });
}

/**
 * Draws a signed agreement's PDF and stores it, once, then emails the customer their
 * signed copy. Safe to run again: the PDF is only ever set once, and the email has a
 * fixed idempotency key.
 */
export async function renderSignedAgreement(ctx: { db: Database; store: ObjectStore; mail: EmailTransport; from?: string }, organizationId: string, documentId: string) {
  const { db, store } = ctx;
  const d = await db
    .selectFrom("signedDocuments as d")
    .innerJoin("organizations as o", "o.id", "d.organizationId")
    .select([
      "d.id",
      "d.title",
      "d.content",
      "d.contentSha256",
      "d.signerName",
      "d.signatureKind",
      "d.signatureImage",
      "d.consentText",
      "d.signedAt",
      "d.ipAddress",
      "d.userAgent",
      "d.pdfStorageKey",
      "d.customerId",
      "d.siteId",
      "o.timezone",
      "o.name as orgName",
    ])
    .where("d.organizationId", "=", organizationId)
    .where("d.id", "=", documentId)
    .executeTakeFirst();
  if (!d) throw new Error(`signed document ${documentId} not found`);
  const content = agreementContent.parse(d.content);
  let key = d.pdfStorageKey;
  if (!key) {
    const pdf = await renderAgreement(content, {
      documentId: d.id,
      signerName: d.signerName,
      kind: d.signatureKind,
      image: d.signatureImage ? Buffer.from(d.signatureImage.slice(d.signatureImage.indexOf(",") + 1), "base64") : null,
      consentText: d.consentText,
      signedAt: d.signedAt,
      timezone: d.timezone,
      ipAddress: d.ipAddress,
      userAgent: d.userAgent,
      contentSha256: d.contentSha256,
    });
    const sha256 = sha256Hex(pdf);
    key = `${organizationId}/agreements/${documentId}-${sha256.slice(0, 12)}.pdf`;
    await store.put(key, pdf, "application/pdf");
    const res = await db
      .updateTable("signedDocuments")
      .set({ pdfStorageKey: key, pdfSha256: sha256, pdfByteSize: pdf.length })
      .where("organizationId", "=", organizationId)
      .where("id", "=", documentId)
      .where("pdfStorageKey", "is", null)
      .executeTakeFirst();
    // Another worker got there first; keep theirs.
    if (Number(res.numUpdatedRows) !== 1) key = (await db.selectFrom("signedDocuments").select("pdfStorageKey").where("id", "=", documentId).executeTakeFirstOrThrow()).pdfStorageKey!;
  }
  const to = content.customer.email;
  if (!to) return key;
  const pdf = await store.get(key);
  if (!pdf) throw new Error(`agreement PDF ${key} is missing from storage`);
  // The customer's copy is recorded as a customer delivery, never as an authority filing.
  const idempotencyKey = `renewal-agreement-${documentId}`;
  const delivered = await db.selectFrom("customerDeliveries").select("id").where("organizationId", "=", organizationId).where("idempotencyKey", "=", idempotencyKey).where("status", "=", "accepted").executeTakeFirst();
  if (delivered) return key;
  const delivery = {
    organizationId,
    customerId: d.customerId,
    siteId: d.siteId,
    documentKind: "signed_agreement" as const,
    reportId: null,
    signedDocumentId: d.id,
    channel: "email" as const,
    recipient: to,
    documentSha256: createHash("sha256").update(pdf).digest("hex"),
    idempotencyKey,
    requestedBy: null,
  };
  const sent = await ctx.mail.send({
    organizationId,
    idempotencyKey,
    from: `"${d.orgName.replace(/"/g, "")}" <${ctx.from ?? "billing@aerowise.invalid"}>`,
    to,
    subject: `Your signed agreement with ${d.orgName}`,
    text: [
      `Hello ${d.signerName},`,
      "",
      `Thank you for renewing. Your signed ${content.term.planName} agreement for ${content.serviceAddress} is attached for your records.`,
      "",
      "Thank you,",
      d.orgName,
    ].join("\n"),
    attachments: [{ filename: "agreement.pdf", contentType: "application/pdf", content: pdf }],
  }).catch(async (err: Error) => {
    await db.insertInto("customerDeliveries").values({ ...delivery, status: "failed", attemptedAt: new Date(), error: (err.message || String(err)).slice(0, 2000) }).execute();
    throw err;
  });
  await db
    .insertInto("customerDeliveries")
    .values({ ...delivery, status: "accepted", attemptedAt: new Date(), transportResponse: JSON.stringify({ ...sent.response, messageId: sent.messageId, acceptedAt: sent.acceptedAt }), error: null })
    .onConflict((oc) => oc.columns(["organizationId", "idempotencyKey"]).where("status", "=", "accepted").doNothing())
    .execute();
  return key;
}

export interface SweepResult {
  created: number;
  sent: number;
  reminded: number;
  expired: number;
  activated: number;
}

/**
 * One organization's renewal campaign: starts renewals for contracts entering the renewal
 * window, emails them (when the office has turned that on), sends reminders, expires
 * offers whose contract has ended, and activates any renewal whose payment has cleared.
 */
export async function runRenewalSweep(db: Database, organizationId: string, now: Date): Promise<SweepResult> {
  const org = await db.selectFrom("organizations").select(["timezone", "renewalWindowDays", "renewalAutoSend"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
  const today = dateInZone(now, org.timezone);
  const result: SweepResult = { created: 0, sent: 0, reminded: 0, expired: 0, activated: 0 };

  const entering = await db
    .selectFrom("contracts as c")
    .select("c.id")
    .where("c.organizationId", "=", organizationId)
    .where("c.status", "=", "active")
    // A contract that is ending (a last day of service recorded) is not renewed.
    .where("c.serviceEndsOn", "is", null)
    .where("c.endOn", ">=", today)
    .where("c.endOn", "<=", addDays(today, org.renewalWindowDays))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("renewals as r").select("r.id").whereRef("r.contractId", "=", "c.id"))))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("contracts as n").select("n.id").whereRef("n.previousContractId", "=", "c.id"))))
    .orderBy("c.endOn")
    .limit(500)
    .execute();
  for (const c of entering) {
    try {
      await db.transaction().execute((trx) => createRenewal(trx, organizationId, c.id, { now }));
      result.created++;
    } catch (err) {
      // Someone started it by hand in the meantime.
      if (!(err instanceof RenewalError)) throw err;
    }
  }

  if (org.renewalAutoSend) {
    const waiting = await db
      .selectFrom("renewals as r")
      .innerJoin("contracts as c", "c.id", "r.contractId")
      .select(["r.id", "r.status", "r.customerId", "r.sentAt", "r.lastReminderDays", "c.endOn"])
      .where("r.organizationId", "=", organizationId)
      .where("r.status", "in", ["upcoming", "sent", "viewed"])
      .where("c.endOn", ">=", today)
      .execute();
    const gapStart = new Date(now.getTime() - REMINDER_GAP_DAYS * 86_400_000);
    for (const r of waiting) {
      if (!(await billingEmail(db, organizationId, r.customerId))) continue;
      if (r.status === "upcoming" && !r.sentAt) {
        await db.transaction().execute((trx) => queueRenewalEmail(trx, organizationId, r.id, { now }));
        result.sent++;
        continue;
      }
      const daysLeft = daysBetween(today, r.endOn);
      const due = [...REMINDER_DAYS].sort((a, b) => a - b).find((d) => daysLeft <= d);
      if (due === undefined || (r.lastReminderDays !== null && r.lastReminderDays <= due) || !r.sentAt || r.sentAt > gapStart) continue;
      await db.transaction().execute((trx) => queueRenewalEmail(trx, organizationId, r.id, { now, reminderDays: due }));
      result.reminded++;
    }
  }

  const ended = await db
    .selectFrom("renewals as r")
    .innerJoin("contracts as c", "c.id", "r.contractId")
    .select("r.id")
    .where("r.organizationId", "=", organizationId)
    .where("r.status", "in", [...SIGNABLE_STATUSES])
    .where("c.endOn", "<", today)
    .execute();
  for (const r of ended) {
    await db.transaction().execute(async (trx) => {
      const res = await trx
        .updateTable("renewals")
        .set({ status: "expired", expiredAt: now, updatedAt: now })
        .where("id", "=", r.id)
        .where("status", "in", [...SIGNABLE_STATUSES])
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 1) {
        await systemAudit(trx, { organizationId, action: "renewal.expired", entityType: "renewal", entityId: r.id });
        result.expired++;
      }
    });
  }

  result.activated = (await activatePaidRenewals(db, { organizationId }, now)).filter((a) => a.status === "activated").length;
  return result;
}

/** The worker's regular sweep: one campaign run per organization per interval. */
export async function scheduleRenewalSweeps(db: Executor, now: Date, intervalMs: number) {
  const orgs = await db.selectFrom("organizations").select("id").execute();
  for (const { id } of orgs) {
    await enqueue(db, {
      kind: RENEWAL_SWEEP,
      organizationId: id,
      payload: { organizationId: id },
      dedupeKey: `renewal-sweep:${id}:${Math.floor(now.getTime() / intervalMs)}`,
      runAt: now,
      maxAttempts: 1,
    });
  }
}
