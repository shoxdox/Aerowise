import { createHash } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import { addDays, buildIntervalSchedule, contractInstallments, invoiceNumberLabel, parseServiceCycles, termEndOn, type AgreementContent, type CoverageRule, type RenewalTerms } from "@aerowise/domain";
import { sql, type Transaction } from "kysely";
import { insertContract, termsForSite, type ContractCycles } from "./contracts.ts";
import { loadPlanVersion } from "./plans.ts";

type Executor = Database | Transaction<DB>;

/** JSON with object keys sorted, so the same content always hashes the same (shared with signed work summaries). */
export { canonicalJson } from "@aerowise/domain";

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

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
export async function offerTerms(
  db: Executor,
  organizationId: string,
  contract: ContractRow,
  override: { planId?: string; priceCents?: number } = {},
): Promise<RenewalTerms & { planVersionId: string | null }> {
  const planId = override.planId ?? contract.planId;
  const p = planId
    ? await db
        .selectFrom("plans")
        .select(["id", "name", "customerType", "termMonths", "visitsPerTerm", "priceCents", "billingFrequency", "serviceType", "active", "currentVersionId"])
        .where("organizationId", "=", organizationId)
        .where("id", "=", planId)
        .executeTakeFirst()
    : undefined;
  if (override.planId && (!p || !p.active)) throw new RenewalError("plan_unavailable", "That plan is not offered");
  const startOn = addDays(contract.endOn, 1);
  const base =
    p && p.active
      ? {
          planId: p.id,
          planName: p.name,
          customerType: p.customerType,
          termMonths: p.termMonths,
          visitsPerTerm: p.visitsPerTerm,
          priceCents: p.priceCents,
          billingFrequency: p.billingFrequency,
          serviceType: p.serviceType,
          planVersionId: p.currentVersionId,
        }
      : {
          planId: contract.planId,
          planName: contract.planName,
          customerType: contract.customerType,
          termMonths: contract.termMonths,
          visitsPerTerm: contract.visitsPerTerm,
          priceCents: contract.priceCents,
          billingFrequency: contract.billingFrequency,
          serviceType: contract.serviceType,
          planVersionId: contract.planVersionId,
        };
  const priceCents = override.priceCents ?? base.priceCents;
  // A version without inspections (SW-9) is offered as its own service: no authority visit
  // rules, the site's own customer type, its first cycle's kind, and its visits in the term.
  const cycles = base.planVersionId ? await versionCycles(db, organizationId, base.planVersionId) : null;
  if (cycles && !cycles.aerobic && cycles.cycles.length) {
    const site = await db.selectFrom("sites").select("customerType").where("organizationId", "=", organizationId).where("id", "=", contract.siteId).executeTakeFirstOrThrow();
    const visits = cycles.cycles.reduce((n, c) => n + buildIntervalSchedule(startOn, base.termMonths, c.schedule).length, 0);
    return {
      ...base,
      customerType: site.customerType,
      serviceType: cycles.cycles[0]!.serviceType,
      visitsPerTerm: visits ? Math.min(visits, 24) : base.visitsPerTerm,
      planVersionId: base.planVersionId ?? null,
      priceCents,
      autoRenew: contract.autoRenew,
      startOn,
      endOn: termEndOn(startOn, base.termMonths),
    };
  }
  // The offer shows the visits the new contract will have under the site's authority.
  const terms = await termsForSite(db, organizationId, contract.siteId, startOn, base);
  return { ...terms, planVersionId: terms.planVersionId ?? null, priceCents, autoRenew: contract.autoRenew, startOn, endOn: termEndOn(startOn, terms.termMonths) };
}

/** A plan version's cycles (SW-9); null when it is not one of this organization's. */
async function versionCycles(db: Executor, organizationId: string, versionId: string) {
  const v = await db.selectFrom("planVersions").select("serviceCycles").where("organizationId", "=", organizationId).where("id", "=", versionId).executeTakeFirst();
  return v ? parseServiceCycles(v.serviceCycles) : null;
}

export interface ContractRow {
  id: string;
  siteId: string;
  planId: string | null;
  planName: string;
  customerType: "residential" | "commercial";
  startOn: string;
  endOn: string;
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: DB["contracts"]["billingFrequency"];
  serviceType: DB["contracts"]["serviceType"];
  autoRenew: boolean;
  status: "active" | "cancelled";
  planVersionId: string | null;
}

export class RenewalError extends Error {
  constructor(
    readonly code: "not_found" | "cancelled" | "already_renewed" | "renewal_exists" | "plan_unavailable" | "renewal_in_progress" | "not_in_review" | "no_next_term" | "installment_billed",
    message: string,
  ) {
    super(message);
  }
}

/** Renewals that are finished: a contract can have another started once its last one is one of these. */
export const FINISHED_RENEWAL_STATUSES = ["declined", "expired", "superseded"] as const;
const dollars = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

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
      "c.customerType",
      "c.startOn",
      "c.endOn",
      "c.termMonths",
      "c.visitsPerTerm",
      "c.priceCents",
      "c.billingFrequency",
      "c.serviceType",
      "c.autoRenew",
      "c.status",
      "c.planVersionId",
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
    .where("status", "not in", FINISHED_RENEWAL_STATUSES)
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

/** Why a renewal cannot become a contract: `reason` is for the office, `code` picks what the homeowner is told. */
export interface ActivationProblem {
  code: "cancelled" | "ending" | "renewed" | "overlap";
  reason: string;
}

/**
 * Why a renewal cannot become a contract right now, or null when it can. Signing and paying
 * ask this first, so no invoice is made or charged for a term that cannot start. In a
 * transaction it locks the contract being renewed (after the renewal, as everything does).
 */
export async function activationProblem(ex: Executor, organizationId: string, r: { contractId: string; siteId: string; startOn: string; endOn: string }): Promise<ActivationProblem | null> {
  const q = ex.selectFrom("contracts").select(["id", "status", "serviceEndsOn"]).where("organizationId", "=", organizationId).where("id", "=", r.contractId);
  const prev = await (ex.isTransaction ? q.forUpdate() : q).executeTakeFirstOrThrow();
  if (prev.status === "cancelled") return { code: "cancelled", reason: "The contract being renewed was cancelled" };
  if (prev.serviceEndsOn) return { code: "ending", reason: `The contract being renewed is ending (service stops after ${prev.serviceEndsOn})` };
  const renewed = await ex.selectFrom("contracts").select("id").where("organizationId", "=", organizationId).where("previousContractId", "=", prev.id).executeTakeFirst();
  if (renewed) return { code: "renewed", reason: "This contract was already renewed another way" };
  const overlap = await ex
    .selectFrom("contracts")
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("siteId", "=", r.siteId)
    .where("status", "=", "active")
    .where(sql<boolean>`daterange(start_on, end_on, '[]') && daterange(${r.startOn}::date, ${r.endOn}::date, '[]')`)
    .executeTakeFirst();
  if (overlap) return { code: "overlap", reason: "Another contract on this site already covers the new term's dates" };
  return null;
}

/** A contract's renewal that is not finished, locked; the caller holds the contract's lock or takes it next. */
export async function lockOpenRenewal(trx: Transaction<DB>, organizationId: string, contractId: string) {
  return trx.selectFrom("renewals").selectAll().where("organizationId", "=", organizationId).where("contractId", "=", contractId).where("status", "not in", FINISHED_RENEWAL_STATUSES).forUpdate().executeTakeFirst();
}

/**
 * Only an offer nobody has signed can be closed for a term made another way: once the
 * customer has signed, money may be on its way, so the office finishes that renewal from its
 * own page instead. Called before the term is made.
 */
export function refuseIfSigned(r: { status: string }) {
  if (r.status === "needs_review") throw new RenewalError("renewal_in_progress", "This contract's renewal is waiting for review. Resolve it from the renewal page.");
  if (!(["upcoming", "sent", "viewed"] as string[]).includes(r.status)) throw new RenewalError("renewal_in_progress", "The customer already signed this renewal. Finish it from the renewal page.");
}

/**
 * Closes a contract's open renewal because the office has just made its next term another way
 * ('Renew now'), in the caller's transaction, so the emailed link stops offering that term and
 * no reminder goes out for it.
 */
export async function supersedeRenewal(
  trx: Transaction<DB>,
  organizationId: string,
  r: { id: string; siteId: string; status: string },
  newContractId: string,
  opts: { now: Date; actorUserId?: string | null; requestId?: string | null },
) {
  refuseIfSigned(r);
  await trx.updateTable("renewals").set({ status: "superseded", supersededAt: opts.now, newContractId, updatedAt: opts.now }).where("id", "=", r.id).execute();
  await renewalOnTimeline(trx, {
    organizationId,
    siteId: r.siteId,
    renewalId: r.id,
    eventType: "renewal_superseded",
    summary: "Renewal offer closed: the office renewed the contract another way",
    actorUserId: opts.actorUserId,
    at: opts.now,
  });
  await systemAudit(trx, { organizationId, actorUserId: opts.actorUserId, requestId: opts.requestId, action: "renewal.superseded", entityType: "renewal", entityId: r.id, changes: { newContractId } });
}

/**
 * Links a renewal invoice's first line to a contract's first installment, so that installment
 * is not billed again. The invoice was issued before the contract existed.
 */
async function linkFirstInstallment(trx: Transaction<DB>, organizationId: string, invoiceId: string, contractId: string) {
  const line = await trx
    .selectFrom("invoiceLines")
    .select(["id"])
    .where("organizationId", "=", organizationId)
    .where("invoiceId", "=", invoiceId)
    .where("position", "=", 1)
    .where("contractId", "is", null)
    .executeTakeFirst();
  if (!line) return;
  const contract = await trx.selectFrom("contracts").select(["startOn", "endOn", "termMonths", "priceCents", "billingFrequency"]).where("id", "=", contractId).executeTakeFirstOrThrow();
  const first = contractInstallments(contract)[0]!;
  await trx.updateTable("invoiceLines").set({ contractId, installment: 1, periodStart: first.periodStart, periodEnd: first.periodEnd }).where("id", "=", line.id).execute();
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
  opts: {
    now: Date;
    actorUserId?: string | null;
    requestId?: string | null;
    note?: string;
    /** The plan builder is on (SW-8): a renewal activated without a signature takes its version's coverage. */
    planBuilder?: boolean;
    /** Service cycles are on (SW-9): a renewal activated without a signature takes its version's cycles. */
    serviceCycles?: boolean;
  },
): Promise<ActivationResult> {
  const r = await trx.selectFrom("renewals").selectAll().where("organizationId", "=", organizationId).where("id", "=", renewalId).forUpdate().executeTakeFirstOrThrow();
  if (r.status === "activated") return { status: "activated", contractId: r.newContractId! };
  const audit = (action: string, changes: Record<string, unknown>) =>
    systemAudit(trx, { organizationId, actorUserId: opts.actorUserId, requestId: opts.requestId, action, entityType: "renewal", entityId: r.id, changes });

  const problem = await activationProblem(trx, organizationId, r);
  if (problem) {
    await trx.updateTable("renewals").set({ status: "needs_review", reviewReason: problem.reason, updatedAt: opts.now }).where("id", "=", r.id).execute();
    await audit("renewal.needs_review", { reason: problem.reason });
    return { status: "needs_review", reason: problem.reason };
  }
  // The new term's coverage is what the customer signed for: the agreement lists it when the
  // plan builder was on at signing. Without a signature the deployment's switch decides.
  let coverage: CoverageRule[] = [];
  let cycles: ContractCycles | undefined;
  if (r.planVersionId) {
    const signed = r.signedDocumentId
      ? ((await trx.selectFrom("signedDocuments").select("content").where("organizationId", "=", organizationId).where("id", "=", r.signedDocumentId).executeTakeFirstOrThrow()).content as AgreementContent)
      : null;
    const v = await loadPlanVersion(trx, organizationId, r.planVersionId);
    if (signed ? !!signed.coverage?.length : !!opts.planBuilder) coverage = v?.coverage ?? [];
    // Cycles likewise (SW-9). A version without inspections always brings its cycles, so its
    // renewal is never made into an inspection contract.
    if (v && (!v.aerobic || (v.serviceCycles.length && (signed ? !!signed.cycles : !!opts.serviceCycles)))) {
      cycles = { aerobic: v.aerobic, serviceCycles: v.serviceCycles };
    }
  }
  const contractId = await insertContract(trx, organizationId, {
    siteId: r.siteId,
    startOn: r.startOn,
    coverage,
    ...(cycles ? { cycles } : {}),
    terms: {
      planId: r.planId,
      planName: r.planName,
      customerType: r.customerType,
      termMonths: r.termMonths,
      visitsPerTerm: r.visitsPerTerm,
      priceCents: r.priceCents,
      billingFrequency: r.billingFrequency,
      serviceType: r.serviceType,
      planVersionId: r.planVersionId,
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
  // The renewal invoice's first line pays the contract's first installment.
  if (r.invoiceId) await linkFirstInstallment(trx, organizationId, r.invoiceId, contractId);
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
 * Settles a renewal in review because its contract was already renewed another way (a
 * 'Renew now' made while the customer was signing and paying, before that closed the offer):
 * the renewal invoice counts toward the term that exists, as activation would have counted it
 * toward the term it made, so that term's first installment is never billed twice. Refused
 * when that installment is already on another invoice; the office voids that one or refunds
 * this payment instead.
 */
export async function applyRenewalToTerm(trx: Transaction<DB>, organizationId: string, renewalId: string, opts: { now: Date; actorUserId?: string | null; requestId?: string | null }) {
  const r = await trx.selectFrom("renewals").selectAll().where("organizationId", "=", organizationId).where("id", "=", renewalId).forUpdate().executeTakeFirst();
  if (!r) throw new RenewalError("not_found", "Renewal not found");
  if (r.status !== "needs_review") throw new RenewalError("not_in_review", "Only a renewal waiting for review can be counted toward another term");
  const next = await trx
    .selectFrom("contracts")
    .select(["id", "status", "startOn", "endOn"])
    .where("organizationId", "=", organizationId)
    .where("previousContractId", "=", r.contractId)
    .forUpdate()
    .executeTakeFirst();
  if (!next || next.status === "cancelled") throw new RenewalError("no_next_term", "This contract has no next term to count the renewal toward");
  if (r.invoiceId) {
    const billed = await trx
      .selectFrom("invoiceLines as l")
      .innerJoin("invoices as i", "i.id", "l.invoiceId")
      .select(["i.number"])
      .where("l.organizationId", "=", organizationId)
      .where("l.contractId", "=", next.id)
      .where("l.installment", "=", 1)
      .where("i.status", "<>", "void")
      .where("i.id", "<>", r.invoiceId)
      .executeTakeFirst();
    if (billed) {
      const label = invoiceNumberLabel(billed.number);
      throw new RenewalError("installment_billed", `The new term's first installment is already on ${label}. Void ${label} first, or refund this renewal's payment.`);
    }
    // Counted toward a term at another price, the difference would never be billed (or would
    // be overcharged): that payment is refunded and the term billed on its own instead.
    const line = await trx.selectFrom("invoiceLines").select("amountCents").where("organizationId", "=", organizationId).where("invoiceId", "=", r.invoiceId).where("position", "=", 1).executeTakeFirst();
    const first = contractInstallments(await trx.selectFrom("contracts").select(["startOn", "endOn", "termMonths", "priceCents", "billingFrequency"]).where("id", "=", next.id).executeTakeFirstOrThrow())[0]!;
    if (line && line.amountCents !== first.amountCents) {
      throw new RenewalError(
        "installment_billed",
        `This renewal billed ${dollars(line.amountCents)} for the first installment, but the term already made bills ${dollars(first.amountCents)}. Refund this renewal's payment and bill the term from its site page.`,
      );
    }
    await linkFirstInstallment(trx, organizationId, r.invoiceId, next.id);
  }
  await trx
    .updateTable("renewals")
    .set({ status: "activated", activatedAt: opts.now, newContractId: next.id, reviewReason: null, updatedAt: opts.now })
    .where("id", "=", r.id)
    .execute();
  await renewalOnTimeline(trx, {
    organizationId,
    siteId: r.siteId,
    renewalId: r.id,
    eventType: "contract_renewed",
    summary: `Renewal counted toward the term already made: ${next.startOn} to ${next.endOn}`,
    actorUserId: opts.actorUserId,
    at: opts.now,
  });
  await systemAudit(trx, { organizationId, actorUserId: opts.actorUserId, requestId: opts.requestId, action: "renewal.applied_to_term", entityType: "renewal", entityId: r.id, changes: { contractId: next.id, invoiceId: r.invoiceId } });
  return { contractId: next.id };
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
