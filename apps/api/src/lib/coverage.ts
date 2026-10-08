import type { Database, DB } from "@aerowise/db";
import { coverageSummary, coverLine, matchingRules, parseCoverageRules, type WorkCategory, type WorkOrderCoverage } from "@aerowise/domain";
import { coverageItemNames } from "@aerowise/renewals";
import type { FastifyRequest } from "fastify";
import { sql, type Transaction } from "kysely";
import { HttpError } from "./errors.ts";
import { workOrderEvent } from "./work-orders.ts";

// Coverage for work orders (SW-8, service workflows plan §4.3). A work order is covered by
// the contract active at its site on the day the work was requested, and only by the rules
// frozen on that contract. Applying coverage reserves one use per matching rule; billing
// the work consumes it; cancelling, declining or restoring releases it. Reserved and
// consumed uses count against a rule's limit, and the rule row is locked while one is
// reserved, so two work orders reaching for the last use get it once between them.
//
// Every change here runs with the work order row already locked by the caller (the work
// order before its invoice, before any rule), the same order every other path takes.

type Executor = Database | Transaction<DB>;
type Trx = Transaction<DB>;

const LIVE = ["reserved", "consumed"] as const;

/** Reserved and consumed uses of each rule. */
export async function usedCounts(ex: Executor, organizationId: string, ruleIds: readonly string[]) {
  if (!ruleIds.length) return new Map<string, number>();
  const rows = await ex
    .selectFrom("coverageUses")
    .select(["contractCoverageRuleId", sql<number>`count(*)::int`.as("n")])
    .where("organizationId", "=", organizationId)
    .where("contractCoverageRuleId", "in", ruleIds)
    .where("state", "in", LIVE)
    .groupBy("contractCoverageRuleId")
    .execute();
  return new Map(rows.map((r) => [r.contractCoverageRuleId, Number(r.n)]));
}

/** The work order with what coverage needs to know about it. */
async function workOrderFacts(ex: Executor, organizationId: string, workOrderId: string) {
  const wo = await ex
    .selectFrom("workOrders as w")
    .innerJoin("organizations as o", "o.id", "w.organizationId")
    .select(["w.id", "w.siteId", "w.category", "w.status", sql<string>`coalesce(w.requested_on, (w.created_at at time zone o.timezone)::date)::text`.as("day")])
    .where("w.organizationId", "=", organizationId)
    .where("w.id", "=", workOrderId)
    .executeTakeFirstOrThrow();
  const lines = await ex
    .selectFrom("workOrderLines as l")
    .leftJoin("serviceItems as i", (j) => j.onRef("i.id", "=", "l.serviceItemId").onRef("i.organizationId", "=", "l.organizationId"))
    .select(["l.serviceItemId", "i.category"])
    .where("l.organizationId", "=", organizationId)
    .where("l.workOrderId", "=", workOrderId)
    .execute();
  return { ...wo, lines };
}

/** The contract active at the site on that day, if any. */
async function coveringContract(ex: Executor, organizationId: string, siteId: string, day: string) {
  return ex
    .selectFrom("contracts as c")
    .leftJoin("planVersions as v", "v.id", "c.planVersionId")
    .select(["c.id", "c.planName", "c.startOn", "c.endOn", "v.version"])
    .where("c.organizationId", "=", organizationId)
    .where("c.siteId", "=", siteId)
    .where("c.status", "=", "active")
    .where("c.startOn", "<=", day)
    .where("c.endOn", ">=", day)
    .where((eb) => eb.or([eb("c.serviceEndsOn", "is", null), eb("c.serviceEndsOn", ">=", day)]))
    .orderBy("c.startOn", "desc")
    .executeTakeFirst();
}

async function contractRules(ex: Executor, organizationId: string, contractId: string) {
  const rows = await ex
    .selectFrom("contractCoverageRules")
    .select(["id", "ruleKey", "rule", "limitCount"])
    .where("organizationId", "=", organizationId)
    .where("contractId", "=", contractId)
    .orderBy("position")
    .execute();
  const parsed = parseCoverageRules(rows.map((r) => r.rule));
  return rows.map((r, i) => ({ ...parsed[i]!, id: r.id, limitCount: r.limitCount }));
}

/** The work order's draft or issued invoice. Its lines were priced under the coverage it held when it was made. */
async function liveInvoice(ex: Executor, organizationId: string, workOrderId: string) {
  return ex.selectFrom("invoices").select("id").where("organizationId", "=", organizationId).where("workOrderId", "=", workOrderId).where("status", "<>", "void").executeTakeFirst();
}

/**
 * Coverage can't change under a live invoice: its prices would no longer match the uses held
 * for it. Called with the work order locked, as creating, issuing and voiding its invoice are.
 */
async function refuseUnderInvoice(trx: Trx, organizationId: string, workOrderId: string) {
  if (await liveInvoice(trx, organizationId, workOrderId))
    throw new HttpError(409, "invoice_exists", "This work order already has an invoice. Discard the draft or void the invoice, change the coverage, then create the invoice again.");
}

/** This work order's coverage, as the office sees it. */
export async function workOrderCoverage(ex: Executor, organizationId: string, workOrderId: string, opts: { canApply: boolean }): Promise<WorkOrderCoverage> {
  const wo = await workOrderFacts(ex, organizationId, workOrderId);
  const contract = await coveringContract(ex, organizationId, wo.siteId, wo.day);
  const invoice = await liveInvoice(ex, organizationId, workOrderId);
  const liveInvoiceId = invoice?.id ?? null;
  if (!contract) return { contract: null, notice: `No contract at this site covers ${wo.day}, the day this work was requested.`, rules: [], canApply: false, liveInvoiceId };
  const rules = await contractRules(ex, organizationId, contract.id);
  const [used, uses, names] = await Promise.all([
    usedCounts(ex, organizationId, rules.map((r) => r.id)),
    ex.selectFrom("coverageUses").select(["contractCoverageRuleId", "state", "invoiceId", "reason"]).where("organizationId", "=", organizationId).where("workOrderId", "=", workOrderId).execute(),
    coverageItemNames(ex, organizationId, rules),
  ]);
  const matching = new Set(matchingRules(rules, wo).map((r) => r.id));
  const view = rules.map((r) => {
    const use = uses.find((u) => u.contractCoverageRuleId === r.id) ?? null;
    return {
      id: r.id,
      ruleKey: r.ruleKey,
      label: r.label,
      summary: coverageSummary(r, "serviceItemId" in r.match ? names.get(r.match.serviceItemId) : undefined),
      effect: r.effect,
      limit: r.limitCount,
      used: used.get(r.id) ?? 0,
      matches: matching.has(r.id),
      use: use ? { state: use.state, invoiceId: use.invoiceId, reason: use.reason } : null,
    };
  });
  const open = wo.status !== "cancelled" && wo.status !== "completed";
  const applicable = view.some((r) => r.matches && (!r.use || r.use.state === "released") && (r.limit === null || r.used < r.limit));
  return {
    contract: { id: contract.id, planName: contract.planName, planVersion: contract.version ?? null, startOn: contract.startOn, endOn: contract.endOn },
    notice: rules.length ? (view.some((r) => r.matches) ? null : "None of its plan's coverage rules fit this work.") : "Its plan has no coverage rules, so it covers nothing.",
    rules: view,
    canApply: opts.canApply && open && applicable && !liveInvoiceId,
    liveInvoiceId,
  };
}

/** Keeps `work_orders.coverage_snapshot` in step with the work order's uses. */
async function refreshSnapshot(trx: Trx, organizationId: string, workOrderId: string, at: Date) {
  const uses = await trx
    .selectFrom("coverageUses as u")
    .innerJoin("contractCoverageRules as r", "r.id", "u.contractCoverageRuleId")
    .innerJoin("contracts as c", "c.id", "r.contractId")
    .select(["u.state", "r.ruleKey", "r.rule", "r.contractId", "c.planName"])
    .where("u.organizationId", "=", organizationId)
    .where("u.workOrderId", "=", workOrderId)
    .orderBy("r.position")
    .execute();
  const live = uses.filter((u) => u.state !== "released");
  const snapshot = live.length
    ? {
        contractId: live[0]!.contractId,
        planName: live[0]!.planName,
        // What the technician may see: covered or not, never prices.
        covered: true,
        rules: live.map((u) => {
          const r = parseCoverageRules([u.rule])[0]!;
          return { ruleKey: u.ruleKey, label: r.label, effect: r.effect, percentOff: r.percentOff, state: u.state };
        }),
        updatedAt: at.toISOString(),
      }
    : null;
  await trx
    .updateTable("workOrders")
    .set({ coverageSnapshot: snapshot ? JSON.stringify(snapshot) : null, updatedAt: at })
    .where("organizationId", "=", organizationId)
    .where("id", "=", workOrderId)
    .execute();
}

/**
 * Reserves one use of every rule that fits the work order and has room left. A rule already
 * at its limit is reported, not reserved: that work is not covered.
 */
export async function reserveCoverage(trx: Trx, req: FastifyRequest, organizationId: string, workOrderId: string, at: Date) {
  const wo = await workOrderFacts(trx, organizationId, workOrderId);
  if (wo.status === "cancelled" || wo.status === "completed") throw new HttpError(409, "work_order_closed", `This work order is ${wo.status}`);
  await refuseUnderInvoice(trx, organizationId, workOrderId);
  const contract = await coveringContract(trx, organizationId, wo.siteId, wo.day);
  if (!contract) throw new HttpError(409, "no_contract", `No contract at this site covers ${wo.day}, the day this work was requested`);
  const rules = matchingRules(await contractRules(trx, organizationId, contract.id), wo);
  if (!rules.length) throw new HttpError(409, "nothing_to_apply", "None of the contract's coverage rules fit this work");
  const reserved: string[] = [];
  const full: string[] = [];
  // Rules in id order, so two work orders lock the same rules in the same order.
  for (const r of [...rules].sort((a, b) => a.id.localeCompare(b.id))) {
    await trx.selectFrom("contractCoverageRules").select("id").where("id", "=", r.id).forUpdate().executeTakeFirstOrThrow();
    const mine = await trx.selectFrom("coverageUses").select(["id", "state"]).where("contractCoverageRuleId", "=", r.id).where("workOrderId", "=", workOrderId).executeTakeFirst();
    if (mine && mine.state !== "released") continue;
    const used = (await usedCounts(trx, organizationId, [r.id])).get(r.id) ?? 0;
    if (r.limitCount !== null && used >= r.limitCount) {
      full.push(r.label);
      continue;
    }
    if (mine) {
      await trx.updateTable("coverageUses").set({ state: "reserved", reservedAt: at, releasedAt: null, reason: null, updatedAt: at }).where("id", "=", mine.id).execute();
    } else {
      await trx.insertInto("coverageUses").values({ organizationId, contractCoverageRuleId: r.id, workOrderId, invoiceId: null, reservedAt: at, consumedAt: null, releasedAt: null, reason: null, updatedAt: at }).execute();
    }
    reserved.push(r.label);
  }
  await refreshSnapshot(trx, organizationId, workOrderId, at);
  const summary = [
    reserved.length ? `Coverage applied from ${contract.planName}: ${reserved.join(", ")}` : null,
    full.length ? `Limit reached, not covered: ${full.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(". ");
  if (summary) await workOrderEvent(trx, req, { organizationId, workOrderId, eventType: "coverage_applied", summary, details: { contractId: contract.id, reserved, full }, at });
  return { reserved, full };
}

/** Releases uses in `from` states, with a reason, and records why. Returns how many. */
async function release(trx: Trx, req: FastifyRequest | null, organizationId: string, workOrderId: string, from: readonly ("reserved" | "consumed")[], reason: string, at: Date) {
  const r = await trx
    .updateTable("coverageUses")
    .set({ state: "released", releasedAt: at, consumedAt: null, reason, updatedAt: at })
    .where("organizationId", "=", organizationId)
    .where("workOrderId", "=", workOrderId)
    .where("state", "in", from)
    .executeTakeFirst();
  const n = Number(r.numUpdatedRows);
  if (n) {
    await refreshSnapshot(trx, organizationId, workOrderId, at);
    if (req) await workOrderEvent(trx, req, { organizationId, workOrderId, eventType: "coverage_released", summary: `Coverage released: ${reason}`, details: { reason, uses: n }, at });
  }
  return n;
}

/** The office decided not to apply coverage before invoicing. A billed use needs its invoice voided, or a restore; a draft must be discarded first. */
export async function declineCoverage(trx: Trx, req: FastifyRequest, organizationId: string, workOrderId: string, reason: string, at: Date) {
  const consumed = await trx.selectFrom("coverageUses").select("id").where("organizationId", "=", organizationId).where("workOrderId", "=", workOrderId).where("state", "=", "consumed").executeTakeFirst();
  if (consumed) throw new HttpError(409, "coverage_billed", "This work was billed with its coverage. Void the invoice first, or restore the benefit.");
  await refuseUnderInvoice(trx, organizationId, workOrderId);
  if (!(await release(trx, req, organizationId, workOrderId, ["reserved"], reason, at))) throw new HttpError(409, "nothing_reserved", "No coverage is applied to this work order");
}

/** "Restore benefit": gives a billed use back, for example after the customer was refunded. */
export async function restoreCoverage(trx: Trx, req: FastifyRequest, organizationId: string, workOrderId: string, reason: string, at: Date) {
  if (!(await release(trx, req, organizationId, workOrderId, ["consumed"], `Benefit restored: ${reason}`, at))) throw new HttpError(409, "nothing_billed", "No billed coverage on this work order to restore");
}

/** The work order was cancelled: what was only reserved goes back. Billed uses stay with their invoice. */
export async function releaseOnCancel(trx: Trx, req: FastifyRequest | null, organizationId: string, workOrderId: string, at: Date) {
  await release(trx, req, organizationId, workOrderId, ["reserved"], "Work order cancelled", at);
}

/**
 * The work order closed, by whichever route (the office, an estimate's cancellation, the
 * phone's final visit or a held record the office attached): cancelled work gives back what
 * it only reserved, and work completed at no charge spends it. Billed work spends it when
 * its invoice is issued. Called from setWorkOrderStatus, so no route can skip it.
 */
export async function coverageOnClose(trx: Trx, req: FastifyRequest | null, organizationId: string, workOrderId: string, to: "cancelled" | "completed", at: Date) {
  if (to === "cancelled") return releaseOnCancel(trx, req, organizationId, workOrderId, at);
  const wo = await trx.selectFrom("workOrders").select("billingStatus").where("organizationId", "=", organizationId).where("id", "=", workOrderId).executeTakeFirstOrThrow();
  if (wo.billingStatus === "no_charge") await consumeCoverage(trx, req, organizationId, workOrderId, null, at);
}

/** The work was billed (its invoice issued) or completed at no charge: its reserved uses are spent. */
export async function consumeCoverage(trx: Trx, req: FastifyRequest | null, organizationId: string, workOrderId: string, invoiceId: string | null, at: Date) {
  const r = await trx
    .updateTable("coverageUses")
    .set({ state: "consumed", consumedAt: at, invoiceId, updatedAt: at })
    .where("organizationId", "=", organizationId)
    .where("workOrderId", "=", workOrderId)
    .where("state", "=", "reserved")
    .executeTakeFirst();
  if (Number(r.numUpdatedRows)) {
    await refreshSnapshot(trx, organizationId, workOrderId, at);
    await workOrderEvent(trx, req, { organizationId, workOrderId, eventType: "coverage_used", summary: invoiceId ? "Coverage used on the issued invoice" : "Coverage used: completed at no charge", details: { invoiceId }, at });
  }
}

/**
 * The invoice that spent the coverage was voided. While the work order is live its uses go
 * back to reserved, ready for a replacement invoice; once it is cancelled they are released.
 */
export async function afterCoveredInvoiceVoided(trx: Trx, req: FastifyRequest, organizationId: string, wo: { id: string; status: string }, invoiceId: string, at: Date) {
  const uses = trx.updateTable("coverageUses").where("organizationId", "=", organizationId).where("workOrderId", "=", wo.id).where("state", "=", "consumed").where("invoiceId", "=", invoiceId);
  const r =
    wo.status === "cancelled"
      ? await uses.set({ state: "released", releasedAt: at, consumedAt: null, reason: "Invoice voided after the work order was cancelled", updatedAt: at }).executeTakeFirst()
      : await uses.set({ state: "reserved", consumedAt: null, invoiceId: null, updatedAt: at }).executeTakeFirst();
  if (Number(r.numUpdatedRows)) {
    await refreshSnapshot(trx, organizationId, wo.id, at);
    await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "coverage_returned", summary: wo.status === "cancelled" ? "Coverage released: its invoice was voided" : "Coverage reserved again: its invoice was voided", details: { invoiceId }, at });
  }
}

/**
 * Prices a work order's invoice lines under the coverage it holds. The first of the
 * contract's rules that fits a line decides it, in the plan's order: an exclusion leaves it
 * at full price, a rule this work order holds a use of prices it, and a rule it does not
 * hold (not applied, or at its limit) leaves it alone. A changed line says why.
 */
export async function coveredInvoiceLines<L extends { description: string; unitPriceCents: number; serviceItemId?: string | null }>(
  trx: Trx,
  organizationId: string,
  wo: { id: string; category: WorkCategory },
  lines: L[],
): Promise<L[]> {
  const held = await trx
    .selectFrom("coverageUses as u")
    .innerJoin("contractCoverageRules as r", "r.id", "u.contractCoverageRuleId")
    .innerJoin("contracts as c", "c.id", "r.contractId")
    .select(["r.id", "r.contractId", "c.planName"])
    .where("u.organizationId", "=", organizationId)
    .where("u.workOrderId", "=", wo.id)
    .where("u.state", "in", LIVE)
    .execute();
  if (!held.length) return lines;
  const { contractId, planName } = held[0]!;
  const rules = await contractRules(trx, organizationId, contractId);
  const heldKeys = new Set(rules.filter((r) => held.some((h) => h.id === r.id)).map((r) => r.ruleKey));
  const itemIds = [...new Set(lines.flatMap((l) => (l.serviceItemId ? [l.serviceItemId] : [])))];
  const items = itemIds.length ? await trx.selectFrom("serviceItems").select(["id", "category"]).where("organizationId", "=", organizationId).where("id", "in", itemIds).execute() : [];
  return lines.map((l) => {
    const category = items.find((i) => i.id === l.serviceItemId)?.category ?? wo.category;
    const c = coverLine(rules, { category, serviceItemId: l.serviceItemId ?? null, unitPriceCents: l.unitPriceCents }, planName);
    return c.note && c.ruleKey && heldKeys.has(c.ruleKey) ? { ...l, unitPriceCents: c.unitPriceCents, description: `${l.description} (${c.note})`.slice(0, 500) } : l;
  });
}
