import { createHash } from "node:crypto";
import { prepareFilingById, syncContractFilings, type ComplianceContext, type EmailTransport } from "@aerowise/compliance";
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
 * waiting for its signed PDF. Contracts are made in several places (renewals, imports,
 * the contracts screen), so a sweep is what guarantees none is missed.
 */
export async function runContractFilings(ctx: ComplianceContext, organizationId: string) {
  const opened = await syncContractFilings(ctx, organizationId);
  const pending = await ctx.db.selectFrom("filings").select("id").where("organizationId", "=", organizationId).where("kind", "=", "contract").where("status", "=", "pending").execute();
  for (const f of pending) await prepareFilingById(ctx, organizationId, f.id);
  return { opened, checked: pending.length };
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
  const pdf = await ctx.store.get(r.storageKey);
  if (!pdf) throw new Error(`report file ${r.id} is missing from storage`);
  if (sha256Hex(pdf) !== r.sha256) throw new Error(`report file ${r.id} does not match its recorded hash`);
  const base = {
    organizationId,
    customerId: r.customerId,
    siteId: r.siteId,
    documentKind: "inspection_report" as const,
    reportId: r.id,
    signedDocumentId: null,
    channel: "email" as const,
    recipient: payload.to,
    documentSha256: r.sha256,
    idempotencyKey,
    requestedBy: payload.requestedBy,
  };
  try {
    const sent = await ctx.mail.send({
      organizationId,
      idempotencyKey,
      from: `"${r.orgName.replace(/"/g, "")}" <${ctx.from ?? "reports@aerowise.invalid"}>`,
      to: payload.to,
      subject: `Your aerobic system inspection report for ${r.addressLine1}`,
      text: [`Attached is the report from your aerobic septic system's maintenance inspection at ${r.addressLine1}.`, "", "Thank you,", r.orgName].join("\n"),
      attachments: [{ filename: `inspection-report${r.version > 1 ? `-v${r.version}` : ""}.pdf`, contentType: "application/pdf", content: pdf }],
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
