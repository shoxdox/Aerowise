import { createHash, randomBytes } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import { addDays, buildTermSchedule, contractInstallments, type RenewalTerms } from "@aerowise/domain";
import { sql, type Transaction } from "kysely";
import { insertContract } from "./contracts.ts";

type Executor = Database | Transaction<DB>;

/** JSON with object keys sorted, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export const newRenewalToken = () => randomBytes(24).toString("base64url");

/** A change the system made (a campaign run, a customer through their link): no signed-in user. */
export async function systemAudit(
  db: Executor,
  e: { organizationId: string; action: string; entityType: string; entityId: string; changes?: Record<string, unknown>; actorUserId?: string | null; requestId?: string | null },
) {
  await db
    .insertInto("auditEvents")
    .values({
      organizationId: e.organizationId,
      actorUserId: e.actorUserId ?? null,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      changes: JSON.stringify(e.changes ?? {}),
      requestId: e.requestId ?? null,
    })
    .execute();
}

export async function renewalOnTimeline(
  db: Executor,
  e: { organizationId: string; siteId: string; renewalId: string; eventType: string; summary: string; actorUserId?: string | null; at: Date },
) {
  await db
    .insertInto("complianceEvents")
    .values({
      organizationId: e.organizationId,
      siteId: e.siteId,
      eventType: e.eventType,
      occurredAt: e.at,
      actorUserId: e.actorUserId ?? null,
      inspectionId: null,
      reportId: null,
      renewalId: e.renewalId,
      summary: e.summary,
    })
    .execute();
}

/**
 * The next term on offer for a contract: its plan's current terms and price when the plan
 * is still offered, otherwise the contract's own. It starts the day after the contract ends.
 */
export async function offerTerms(db: Executor, organizationId: string, contract: ContractRow, override: { planId?: string; priceCents?: number } = {}): Promise<RenewalTerms> {
  const planId = override.planId ?? contract.planId;
  const p = planId
    ? await db
        .selectFrom("plans")
        .select(["id", "name", "termMonths", "visitsPerTerm", "priceCents", "billingFrequency", "serviceType", "active"])
        .where("organizationId", "=", organizationId)
        .where("id", "=", planId)
        .executeTakeFirst()
    : undefined;
  if (override.planId && (!p || !p.active)) throw new RenewalError("plan_unavailable", "That plan is not offered");
  const startOn = addDays(contract.endOn, 1);
  const base =
    p && p.active
      ? { planId: p.id, planName: p.name, termMonths: p.termMonths, visitsPerTerm: p.visitsPerTerm, priceCents: p.priceCents, billingFrequency: p.billingFrequency, serviceType: p.serviceType }
      : {
          planId: contract.planId,
          planName: contract.planName,
          termMonths: contract.termMonths,
          visitsPerTerm: contract.visitsPerTerm,
          priceCents: contract.priceCents,
          billingFrequency: contract.billingFrequency,
          serviceType: contract.serviceType,
        };
  const priceCents = override.priceCents ?? base.priceCents;
  return { ...base, priceCents, autoRenew: contract.autoRenew, startOn, endOn: buildTermSchedule(startOn, base.termMonths, base.visitsPerTerm).endOn };
}

export interface ContractRow {
  id: string;
  siteId: string;
  planId: string | null;
  planName: string;
  startOn: string;
  endOn: string;
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: DB["contracts"]["billingFrequency"];
  serviceType: DB["contracts"]["serviceType"];
  autoRenew: boolean;
  status: "active" | "cancelled";
}

export class RenewalError extends Error {
  constructor(
    readonly code: "not_found" | "cancelled" | "already_renewed" | "renewal_exists" | "plan_unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** Starts a renewal for a contract, in the caller's transaction. It is not sent yet. */
export async function createRenewal(trx: Transaction<DB>, organizationId: string, contractId: string, opts: { createdBy?: string | null; requestId?: string | null; now: Date }) {
  const c = await trx
    .selectFrom("contracts as c")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "c.siteId").onRef("s.organizationId", "=", "c.organizationId"))
    .select([
      "c.id",
      "c.siteId",
      "c.planId",
      "c.planName",
      "c.startOn",
      "c.endOn",
      "c.termMonths",
      "c.visitsPerTerm",
      "c.priceCents",
      "c.billingFrequency",
      "c.serviceType",
      "c.autoRenew",
      "c.status",
      "s.customerId",
    ])
    .where("c.organizationId", "=", organizationId)
    .where("c.id", "=", contractId)
    .forUpdate()
    .executeTakeFirst();
  if (!c) throw new RenewalError("not_found", "Contract not found");
  if (c.status === "cancelled") throw new RenewalError("cancelled", "A cancelled contract cannot be renewed");
  const renewed = await trx.selectFrom("contracts").select("id").where("organizationId", "=", organizationId).where("previousContractId", "=", c.id).executeTakeFirst();
  if (renewed) throw new RenewalError("already_renewed", "This contract has already been renewed");
  const open = await trx
    .selectFrom("renewals")
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("contractId", "=", c.id)
    .where("status", "not in", ["declined", "expired"])
    .executeTakeFirst();
  if (open) throw new RenewalError("renewal_exists", "This contract already has a renewal in progress");
  const terms = await offerTerms(trx, organizationId, c);
  const row = await trx
    .insertInto("renewals")
    .values({
      organizationId,
      contractId: c.id,
      siteId: c.siteId,
      customerId: c.customerId,
      publicToken: newRenewalToken(),
      ...terms,
      sentAt: null,
      lastReminderDays: null,
      viewedAt: null,
      signedAt: null,
      paidAt: null,
      activatedAt: null,
      declinedAt: null,
      declineReason: null,
      expiredAt: null,
      reviewReason: null,
      signedDocumentId: null,
      invoiceId: null,
      newContractId: null,
      createdBy: opts.createdBy ?? null,
      updatedAt: opts.now,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await systemAudit(trx, {
    organizationId,
    actorUserId: opts.createdBy,
    requestId: opts.requestId,
    action: "renewal.created",
    entityType: "renewal",
    entityId: row.id,
    changes: { contractId: c.id, ...terms },
  });
  return row.id;
}

/** Why a renewal cannot become a contract right now, or null when it can. */
async function activationProblem(trx: Transaction<DB>, organizationId: string, r: { contractId: string; siteId: string; startOn: string; endOn: string }) {
  const prev = await trx.selectFrom("contracts").select(["id", "status"]).where("organizationId", "=", organizationId).where("id", "=", r.contractId).forUpdate().executeTakeFirstOrThrow();
  if (prev.status === "cancelled") return "The contract being renewed was cancelled";
  const renewed = await trx.selectFrom("contracts").select("id").where("organizationId", "=", organizationId).where("previousContractId", "=", prev.id).executeTakeFirst();
  if (renewed) return "This contract was already renewed another way";
  const overlap = await trx
    .selectFrom("contracts")
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("siteId", "=", r.siteId)
    .where("status", "=", "active")
    .where(sql<boolean>`daterange(start_on, end_on, '[]') && daterange(${r.startOn}::date, ${r.endOn}::date, '[]')`)
    .executeTakeFirst();
  if (overlap) return "Another contract on this site already covers the new term's dates";
  return null;
}

export type ActivationResult = { status: "activated"; contractId: string } | { status: "needs_review"; reason: string };

/**
 * Turns a renewal into the next contract with its visits, in the caller's transaction.
 * Safe to call again: an activated renewal returns its contract. When something in the
 * way needs a person (the contract was cancelled, or renewed by hand), the renewal goes
 * to review instead of failing.
 */
export async function activateRenewal(
  trx: Transaction<DB>,
  organizationId: string,
  renewalId: string,
  opts: { now: Date; actorUserId?: string | null; requestId?: string | null; note?: string },
): Promise<ActivationResult> {
  const r = await trx.selectFrom("renewals").selectAll().where("organizationId", "=", organizationId).where("id", "=", renewalId).forUpdate().executeTakeFirstOrThrow();
  if (r.status === "activated") return { status: "activated", contractId: r.newContractId! };
  const audit = (action: string, changes: Record<string, unknown>) =>
    systemAudit(trx, { organizationId, actorUserId: opts.actorUserId, requestId: opts.requestId, action, entityType: "renewal", entityId: r.id, changes });

  const problem = await activationProblem(trx, organizationId, r);
  if (problem) {
    await trx.updateTable("renewals").set({ status: "needs_review", reviewReason: problem, updatedAt: opts.now }).where("id", "=", r.id).execute();
    await audit("renewal.needs_review", { reason: problem });
    return { status: "needs_review", reason: problem };
  }
  const contractId = await insertContract(trx, organizationId, {
    siteId: r.siteId,
    startOn: r.startOn,
    terms: {
      planId: r.planId,
      planName: r.planName,
      termMonths: r.termMonths,
      visitsPerTerm: r.visitsPerTerm,
      priceCents: r.priceCents,
      billingFrequency: r.billingFrequency,
      serviceType: r.serviceType,
    },
    autoRenew: r.autoRenew,
    previousContractId: r.contractId,
    signedDocumentId: r.signedDocumentId,
  });
  await trx
    .updateTable("renewals")
    .set({ status: "activated", activatedAt: opts.now, newContractId: contractId, reviewReason: null, updatedAt: opts.now })
    .where("id", "=", r.id)
    .execute();
  // The renewal invoice was issued before this contract existed; its first line pays the
  // contract's first installment, so link it and that installment is not billed again.
  if (r.invoiceId) {
    const line = await trx
      .selectFrom("invoiceLines")
      .select(["id", "description"])
      .where("organizationId", "=", organizationId)
      .where("invoiceId", "=", r.invoiceId)
      .where("position", "=", 1)
      .where("contractId", "is", null)
      .executeTakeFirst();
    const contract = await trx.selectFrom("contracts").select(["startOn", "endOn", "termMonths", "priceCents", "billingFrequency"]).where("id", "=", contractId).executeTakeFirstOrThrow();
    const first = contractInstallments(contract)[0]!;
    if (line) {
      await trx
        .updateTable("invoiceLines")
        .set({ contractId, installment: 1, periodStart: first.periodStart, periodEnd: first.periodEnd })
        .where("id", "=", line.id)
        .execute();
    }
  }
  await renewalOnTimeline(trx, {
    organizationId,
    siteId: r.siteId,
    renewalId: r.id,
    eventType: "contract_renewed",
    summary: `Contract renewed: ${r.planName}, ${r.startOn} to ${r.endOn}${opts.note ? ` (${opts.note})` : ""}`,
    actorUserId: opts.actorUserId,
    at: opts.now,
  });
  await audit("renewal.activated", { contractId, ...(opts.note ? { note: opts.note } : {}) });
  return { status: "activated", contractId };
}

/**
 * Activates every renewal waiting on a payment that has now cleared. Called after anything
 * that records a payment, and by the worker's sweep in case one was missed. Each renewal
 * gets its own transaction, so one in trouble does not hold up the rest.
 */
export async function activatePaidRenewals(db: Database, filter: { organizationId?: string; invoiceId?: string }, now: Date) {
  let q = db
    .selectFrom("renewals as r")
    .innerJoin("invoices as i", (j) => j.onRef("i.id", "=", "r.invoiceId").onRef("i.organizationId", "=", "r.organizationId"))
    .select(["r.id", "r.organizationId"])
    .where("r.status", "in", ["payment_pending", "paid"])
    .where("i.status", "=", "open")
    .where("i.paymentStatus", "in", ["paid", "overpaid"]);
  if (filter.organizationId) q = q.where("r.organizationId", "=", filter.organizationId);
  if (filter.invoiceId) q = q.where("r.invoiceId", "=", filter.invoiceId);
  const due = await q.execute();
  const results: ActivationResult[] = [];
  for (const r of due) {
    results.push(
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("renewals").set({ status: "paid", paidAt: sql`coalesce(paid_at, ${now})`, updatedAt: now }).where("id", "=", r.id).where("status", "in", ["payment_pending", "paid"]).execute();
        return activateRenewal(trx, r.organizationId, r.id, { now });
      }),
    );
  }
  return results;
}
