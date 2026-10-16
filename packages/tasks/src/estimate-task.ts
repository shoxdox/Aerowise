import { createHash, randomBytes } from "node:crypto";
import type { EmailTransport } from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import { addDays, dateInZone, estimateLabel, isEstimateOpen, type EstimateStatus } from "@aerowise/domain";
import { dollars } from "@aerowise/payments";
import { systemAudit } from "@aerowise/renewals";
import type { Transaction } from "kysely";
import { fromLine, longDay, replyToOf } from "./customer-email.ts";
import { billingEmail } from "./invoice-task.ts";
import { enqueue } from "./queue.ts";

// Estimates (SW-5): emailing the homeowner their link, and expiring an estimate once its
// last day has passed in the company's own timezone.

export const ESTIMATE_EMAIL = "estimates.email";
export const ESTIMATE_EXPIRY = "estimates.expire";

type Executor = Database | Transaction<DB>;

export const estimateUrlFor = (appUrl: string, token: string) => `${appUrl.replace(/\/$/, "")}/estimate/${token}`;

/** Estimate links are looked up by this hash; the token itself is never stored. */
export const hashEstimateToken = (token: string) => createHash("sha256").update(token).digest();

/** Makes a link to an estimate and returns its token, which only the caller ever sees. */
export async function createEstimateLink(db: Executor, link: { organizationId: string; estimateId: string; source: "email" | "office"; sentTo: string | null; createdBy: string | null }) {
  const token = randomBytes(32).toString("base64url");
  await db
    .insertInto("estimateLinks")
    .values({ organizationId: link.organizationId, estimateId: link.estimateId, tokenHash: hashEstimateToken(token), source: link.source, sentTo: link.sentTo, createdBy: link.createdBy })
    .execute();
  return token;
}

/** Whether an estimate whose last day is `expiresOn` has run out on `today` (both company-local dates). */
export const estimateExpired = (expiresOn: string | null, today: string) => expiresOn !== null && today > expiresOn;

/** The first hour at which `expiresOn` has passed in the company's timezone. */
export function expiryRunAt(expiresOn: string, timeZone: string): Date {
  const [y, m, d] = addDays(expiresOn, 1).split("-").map(Number);
  // Every timezone's next day starts within 14 hours either side of UTC midnight.
  let t = new Date(Date.UTC(y!, m! - 1, d!) - 14 * 3600_000);
  while (dateInZone(t, timeZone) <= expiresOn) t = new Date(t.getTime() + 3600_000);
  return t;
}

/** Queues the expiry check for a sent version. The check itself re-reads the estimate. */
export async function queueEstimateExpiry(trx: Transaction<DB>, e: { organizationId: string; estimateId: string; version: number; expiresOn: string | null; timeZone: string }) {
  if (!e.expiresOn) return;
  await enqueue(trx, {
    kind: ESTIMATE_EXPIRY,
    organizationId: e.organizationId,
    payload: { estimateId: e.estimateId, version: e.version },
    dedupeKey: `estimate-expiry-${e.estimateId}-${e.version}`,
    runAt: expiryRunAt(e.expiresOn, e.timeZone),
  });
}

/** Marks a sent estimate expired once its sent version's last day has passed. Safe to run again. */
export async function expireEstimate(db: Database, organizationId: string, estimateId: string, version: number, now: Date) {
  await db.transaction().execute(async (trx) => {
    const e = await trx
      .selectFrom("estimates as e")
      .innerJoin("organizations as o", "o.id", "e.organizationId")
      .select(["e.id", "e.status", "e.currentVersion", "o.timezone"])
      .where("e.organizationId", "=", organizationId)
      .where("e.id", "=", estimateId)
      .forUpdate("e")
      .executeTakeFirst();
    // Accepted, declined, voided or revised since: nothing to do.
    if (!e || !isEstimateOpen(e.status as EstimateStatus) || e.currentVersion !== version) return;
    const v = await trx.selectFrom("estimateVersions").select("expiresOn").where("estimateId", "=", estimateId).where("version", "=", version).executeTakeFirst();
    if (!v || !estimateExpired(v.expiresOn, dateInZone(now, e.timezone))) return;
    await trx.updateTable("estimates").set({ status: "expired", expiredAt: now, updatedAt: now }).where("id", "=", estimateId).execute();
    await trx
      .insertInto("estimateEvents")
      .values({ organizationId, estimateId, eventType: "expired", summary: `Expired: the offer was good until ${v.expiresOn}`, actorUserId: null, details: JSON.stringify({ version }), occurredAt: now })
      .execute();
    await systemAudit(trx, { organizationId, action: "estimate.expired", entityType: "estimate", entityId: estimateId, changes: { version } });
  });
}

/** Queues an email of the estimate's current version. Each email makes its own link. */
export async function queueEstimateEmail(trx: Transaction<DB>, e: { organizationId: string; estimateId: string; version: number; createdBy: string | null; now: Date; requestKey: string }) {
  await enqueue(trx, {
    kind: ESTIMATE_EMAIL,
    organizationId: e.organizationId,
    payload: { estimateId: e.estimateId, version: e.version, createdBy: e.createdBy },
    dedupeKey: `estimate-email-${e.estimateId}-${e.requestKey}`,
    runAt: e.now,
  });
}

/**
 * Emails the homeowner a link to their estimate. The link is made here, not when the email
 * was asked for, so its token never sits in the task queue. Skips an estimate that can no
 * longer be accepted or has been revised since.
 */
export async function sendEstimateEmail(
  ctx: { db: Database; mail: EmailTransport; appUrl: string; from?: string },
  organizationId: string,
  taskId: string,
  p: { estimateId: string; version: number; createdBy: string | null },
) {
  const { db } = ctx;
  const e = await db
    .selectFrom("estimates as e")
    .innerJoin("customers as cu", (j) => j.onRef("cu.id", "=", "e.customerId").onRef("cu.organizationId", "=", "e.organizationId"))
    .innerJoin("organizations as o", "o.id", "e.organizationId")
    .innerJoin("estimateVersions as v", (j) => j.onRef("v.estimateId", "=", "e.id").on("v.version", "=", p.version))
    .select(["e.status", "e.number", "e.title", "e.currentVersion", "e.customerId", "cu.displayName", "o.name as orgName", "o.phone as orgPhone", "o.email as orgEmail", "v.totals", "v.expiresOn"])
    .where("e.organizationId", "=", organizationId)
    .where("e.id", "=", p.estimateId)
    .executeTakeFirst();
  if (!e) throw new Error(`estimate ${p.estimateId} not found`);
  if (!isEstimateOpen(e.status as EstimateStatus) || e.currentVersion !== p.version) return;
  const to = await billingEmail(db, organizationId, e.customerId);
  if (!to) throw new Error("No email address on file for this customer");
  const token = await createEstimateLink(db, { organizationId, estimateId: p.estimateId, source: "email", sentTo: to, createdBy: p.createdBy });
  const contact = [e.orgPhone, e.orgEmail].filter(Boolean).join(" or ");
  const total = (e.totals as { totalCents: number }).totalCents;
  await ctx.mail.send({
    organizationId,
    idempotencyKey: `estimate-${p.estimateId}-email-${taskId}`,
    from: fromLine(e.orgName, ctx.from ?? "billing@aerowise.invalid"),
    to,
    replyTo: replyToOf(e.orgEmail),
    subject: `Your estimate from ${e.orgName}: ${e.title}`,
    text: [
      `Hello ${e.displayName},`,
      "",
      `${e.orgName} has sent you an estimate, ${estimateLabel(e.number)}: ${e.title}, for ${dollars(total)}${e.expiresOn ? `, good until ${longDay(e.expiresOn)}` : ""}.`,
      "",
      `Review it, choose any options and accept it here: ${estimateUrlFor(ctx.appUrl, token)}`,
      "",
      "Keep this link to yourself: anyone with it can accept the estimate.",
      contact ? `Questions? Reach us at ${contact}.` : "",
      "",
      "Thank you,",
      e.orgName,
    ].join("\n"),
    attachments: [],
  });
}
