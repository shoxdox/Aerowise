import { createHash } from "node:crypto";
import { customerCopy, dateInZone, prepareFilingById, replaceUnsignedPackages, syncContractFilings, type ComplianceContext, type EmailTransport, UNSIGNED_CUSTOMER_COPY } from "@aerowise/compliance";
import { cancelOpenVisits } from "./contract-end.ts";
import type { Database, DB } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import type { Transaction } from "kysely";
import { enqueue } from "./queue.ts";

type Executor = Database | Transaction<DB>;

export const CONTRACT_FILINGS = "filings.contracts";
export const SEND_CUSTOMER_REPORT = "reports.send_customer";

/** Queues the contract filing sweep for each organization with active contracts. */
export async function scheduleContractFilingSweeps(db: Executor, now: Date, intervalMs: number) {
  const orgs = await db.selectFrom("contracts").select("organizationId").distinct().where("status", "=", "active").execute();
  for (const { organizationId } of orgs) {
    await enqueue(db, {
      kind: CONTRACT_FILINGS,
      organizationId,
      payload: { organizationId },
      dedupeKey: `${CONTRACT_FILINGS}:${organizationId}:${Math.floor(now.getTime() / intervalMs)}`,
      runAt: now,
    });
  }
}

/**
 * Opens the contract filings that are missing, then checks every contract filing still
 * waiting for its signed PDF, and replaces unsent inspection packages with an unsigned report. Contracts are made in several places (renewals, imports,
 * the contracts screen), so a sweep is what guarantees none is missed.
 */
export async function runContractFilings(ctx: ComplianceContext, organizationId: string) {
  const ended = await endContractsPastService(ctx.db, organizationId, ctx.now());
  const opened = await syncContractFilings(ctx, organizationId);
  const pending = await ctx.db.selectFrom("filings").select("id").where("organizationId", "=", organizationId).where("kind", "=", "contract").where("status", "=", "pending").execute();
  for (const f of pending) await prepareFilingById(ctx, organizationId, f.id);
  // Inspection packages made from an unsigned report (before signatures were required, or
  // before the report was signed) are replaced before anything can send them.
  const replaced = await replaceUnsignedPackages(ctx, organizationId);
  return { opened, checked: pending.length, replaced, ended };
}

/**
 * Ends the contracts whose recorded last day of service has passed: cancelled from the day
 * after, with any visit still open cancelled too (it was not done while service lasted),
 * and its unstarted job taken off the route.
 */
export async function endContractsPastService(db: Database, organizationId: string, now: Date) {
  const org = await db.selectFrom("organizations").select("timezone").where("id", "=", organizationId).executeTakeFirstOrThrow();
  const today = dateInZone(now, org.timezone);
  return db.transaction().execute(async (trx) => {
    const ended = await trx
      .updateTable("contracts")
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where("organizationId", "=", organizationId)
      .where("status", "=", "active")
      .where("serviceEndsOn", "<", today)
      .returning("id")
      .execute();
    await cancelOpenVisits(trx, { organizationId, contractIds: ended.map((c) => c.id), reason: "Service under the contract ended", at: now });
    return ended.length;
  });
}

/** Contract filings waiting on this signed agreement's PDF, checked now that it exists. */
export async function prepareContractFilingsFor(ctx: ComplianceContext, organizationId: string, signedDocumentId: string) {
  const waiting = await ctx.db
    .selectFrom("filings")
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("signedDocumentId", "=", signedDocumentId)
    .where("status", "=", "pending")
    .execute();
  for (const f of waiting) await prepareFilingById(ctx, organizationId, f.id);
}

const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Emails the customer copy of an inspection report and records the delivery: recipient,
 * the document's hash, what the mail provider said. "Accepted" is the provider taking
 * the message, not the customer reading it. One send per request key, however often the
 * task runs.
 */
export async function sendCustomerReport(
  ctx: { db: Database; store: ObjectStore; mail: EmailTransport; now: () => Date; from?: string },
  organizationId: string,
  payload: { reportId: string; to: string; requestKey: string; requestedBy: string | null },
) {
  const r = await ctx.db
    .selectFrom("reports as r")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "r.siteId").onRef("s.organizationId", "=", "r.organizationId"))
    .innerJoin("organizations as o", "o.id", "r.organizationId")
    .select(["r.id", "r.audience", "r.storageKey", "r.sha256", "r.siteId", "r.version", "s.customerId", "s.addressLine1", "o.name as orgName"])
    .where("r.organizationId", "=", organizationId)
    .where("r.id", "=", payload.reportId)
    .executeTakeFirstOrThrow();
  if (r.audience !== "customer") throw new Error("Only the customer copy goes to customers");
  const idempotencyKey = `customer-report-${r.id}-${payload.requestKey}`;
  const done = await ctx.db.selectFrom("customerDeliveries").select("id").where("organizationId", "=", organizationId).where("idempotencyKey", "=", idempotencyKey).where("status", "=", "accepted").executeTakeFirst();
  if (done) return done.id;
  // The signed copy when there is one; an unsigned one never goes out where the
  // maintenance provider's signature is required (30 TAC 285.7(b)(3)).
  const copy = (await customerCopy(ctx.db, organizationId, r.id))!;
  const base = {
    organizationId,
    customerId: r.customerId,
    siteId: r.siteId,
    documentKind: "inspection_report" as const,
    reportId: r.id,
    signedDocumentId: null,
    channel: "email" as const,
    recipient: payload.to,
    documentSha256: copy.sha256,
    idempotencyKey,
    requestedBy: payload.requestedBy,
  };
  if (!copy.ready) {
    await ctx.db.insertInto("customerDeliveries").values({ ...base, status: "failed", attemptedAt: ctx.now(), error: UNSIGNED_CUSTOMER_COPY }).execute();
    return null;
  }
  const pdf = await ctx.store.get(copy.storageKey);
  if (!pdf) throw new Error(`report file ${r.id} is missing from storage`);
  if (sha256Hex(pdf) !== copy.sha256) throw new Error(`report file ${r.id} does not match its recorded hash`);
  try {
    const sent = await ctx.mail.send({
      organizationId,
      idempotencyKey,
      from: `"${r.orgName.replace(/"/g, "")}" <${ctx.from ?? "reports@aerowise.invalid"}>`,
      to: payload.to,
      subject: `Your aerobic system inspection report for ${r.addressLine1}`,
      text: [`Attached is the report from your aerobic septic system's maintenance inspection at ${r.addressLine1}.`, "", "Thank you,", r.orgName].join("\n"),
      attachments: [{ filename: `inspection-report${r.version > 1 ? `-v${r.version}` : ""}${copy.signed ? "-signed" : ""}.pdf`, contentType: "application/pdf", content: pdf }],
    });
    const row = await ctx.db
      .insertInto("customerDeliveries")
      .values({ ...base, status: "accepted", attemptedAt: ctx.now(), transportResponse: JSON.stringify({ ...sent.response, messageId: sent.messageId, acceptedAt: sent.acceptedAt }), error: null })
      .onConflict((oc) => oc.columns(["organizationId", "idempotencyKey"]).where("status", "=", "accepted").doNothing())
      .returning("id")
      .executeTakeFirst();
    return row?.id ?? null;
  } catch (err) {
    await ctx.db
      .insertInto("customerDeliveries")
      .values({ ...base, status: "failed", attemptedAt: ctx.now(), error: ((err as Error).message || String(err)).slice(0, 2000) })
      .execute();
    throw err;
  }
}
