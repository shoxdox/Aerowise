import { loadCatalog, resolveSite, siteMonitoredOn, type CatalogEntry } from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import {
  anchoredVisitsWithin,
  buildAnchoredSchedule,
  buildIntervalSchedule,
  buildTermSchedule,
  serviceIntervalMonths,
  siteScheduleProblem,
  termEndOn,
  visitsWithin,
  type ContractVisitRule,
  type CoverageRule,
  type ServiceCycle,
  type VisitWindow,
} from "@aerowise/domain";
import type { Transaction } from "kysely";

type Executor = Database | Transaction<DB>;

export interface Terms {
  planId: string | null;
  planName: string;
  customerType: "residential" | "commercial";
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: DB["contracts"]["billingFrequency"];
  serviceType: DB["contracts"]["serviceType"];
  /** The plan version these terms came from (SW-8); null when there is none. */
  planVersionId?: string | null;
}

type VisitTerms = Pick<Terms, "customerType" | "termMonths" | "visitsPerTerm">;

/**
 * The terms for a contract at this site: the site's own residential or commercial type
 * (not the plan's), and enough visits that no visit window is longer than the site's
 * authority allows under the rules in force on `startOn` (longer where it allows that for a
 * system with electronic monitoring on record that day). A site with no authority keeps its
 * plan's visits; visits are added, never removed. Pass `catalog` when doing many sites at once.
 */
export async function termsForSite<T extends VisitTerms>(db: Executor, organizationId: string, siteId: string, startOn: string, terms: T, catalog?: CatalogEntry[]): Promise<T> {
  return (await siteVisitTerms(db, organizationId, siteId, startOn, terms, catalog)).terms;
}

/** Visits the site's authority adds to a plan, and why. */
export interface AddedVisits {
  planVisits: number;
  visitsPerTerm: number;
  authorityName: string;
  intervalMonths: number;
  /** Set when the authority counts visits from the contract's start (Hays). */
  contractVisits?: ContractVisitRule & { unconfirmed?: string };
}

/** `termsForSite`, also saying when (and why) the authority needs more visits than the plan has. */
export async function siteVisitTerms<T extends VisitTerms>(
  db: Executor,
  organizationId: string,
  siteId: string,
  startOn: string,
  terms: T,
  catalog?: CatalogEntry[],
): Promise<{
  terms: T;
  added: AddedVisits | null;
  contractVisits: (ContractVisitRule & { unconfirmed?: string }) | null;
  /** Why the authority's schedule for this site isn't settled (see `siteScheduleProblem`). */
  scheduleNotice: string | null;
}> {
  const site = await db
    .selectFrom("sites")
    .select(["county", "state", "jurisdictionId", "customerType", "permitIntervalMonths", "useCategory"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", siteId)
    .executeTakeFirstOrThrow();
  terms = { ...terms, customerType: site.customerType };
  const resolved = resolveSite(catalog ?? (await loadCatalog(db)), site, startOn);
  if (!resolved) return { terms, added: null, contractVisits: null, scheduleNotice: null };
  const scheduleNotice = siteScheduleProblem(resolved.rules, resolved.authorityName, site);
  // Monitoring only matters where the authority allows a longer interval for it.
  const monitored = resolved.rules.service.monitored ? await siteMonitoredOn(db, organizationId, siteId, startOn) : false;
  const intervalMonths = serviceIntervalMonths(resolved.rules, terms.customerType, monitored, site.permitIntervalMonths, site.useCategory);
  const contractVisits = resolved.rules.service.contractVisits ?? null;
  const visitsPerTerm = contractVisits ? anchoredVisitsWithin(terms.termMonths, terms.visitsPerTerm, intervalMonths) : visitsWithin(terms.termMonths, terms.visitsPerTerm, intervalMonths);
  if (visitsPerTerm === terms.visitsPerTerm) return { terms, added: null, contractVisits, scheduleNotice };
  return {
    terms: { ...terms, visitsPerTerm },
    added: { planVisits: terms.visitsPerTerm, visitsPerTerm, authorityName: resolved.authorityName, intervalMonths, ...(contractVisits ? { contractVisits } : {}) },
    contractVisits,
    scheduleNotice,
  };
}

/**
 * What a contract takes from its plan version's cycles (SW-9): whether it has aerobic
 * inspections, and its pumping or maintenance cycles. Without it a contract is an
 * inspection contract, exactly as before.
 */
export interface ContractCycles {
  aerobic: boolean;
  serviceCycles: readonly ServiceCycle[];
}

/** The office has not yet agreed to the extra visits the site's authority needs. */
export class MoreVisitsRequired extends Error {
  constructor(readonly added: AddedVisits) {
    const every = `${added.intervalMonths} month${added.intervalMonths === 1 ? "" : "s"}`;
    const c = added.contractVisits;
    const rule = c
      ? `${added.authorityName} counts visits from the contract's start: one within ${c.firstWithinDays} days of it, one at least every ${every}, and one in the last ${c.lastWithinDaysOfEnd} days`
      : `${added.authorityName} requires an inspection at least every ${every}`;
    const reading = c?.unconfirmed ? ` ${c.unconfirmed}.` : "";
    super(`${rule}, so this contract needs ${added.visitsPerTerm} visits instead of the plan's ${added.planVisits}, at the same price.${reading} Create it with ${added.visitsPerTerm} visits?`);
  }
}

/**
 * Inserts a contract and one open obligation per visit window, in the caller's
 * transaction. The visits follow the site's authority (see `termsForSite`). Postgres
 * errors (overlapping dates, a second renewal) are left to the caller.
 */
export async function insertContract(
  trx: Transaction<DB>,
  organizationId: string,
  input: {
    siteId: string;
    startOn: string;
    terms: Terms;
    autoRenew: boolean;
    notes?: string | null;
    previousContractId?: string;
    signedDocumentId?: string | null;
    /** Coverage rules to freeze on the contract (SW-8), from `terms.planVersionId`. */
    coverage?: readonly CoverageRule[];
    /** What was agreed, for a contract made without a signature (SW-8). */
    agreementSnapshot?: unknown;
    /** The cycles to freeze on the contract (SW-9), from `terms.planVersionId`. */
    cycles?: ContractCycles;
  },
  opts: { catalog?: CatalogEntry[]; acceptVisits?: number; confirmExtraVisits?: boolean } = {},
) {
  const aerobic = input.cycles?.aerobic ?? true;
  const others = input.cycles?.serviceCycles ?? [];
  if (!aerobic && !others.length) throw new Error("A contract needs at least one cycle");
  // A pumping or maintenance contract is never made into an inspection one for want of its cycles.
  if (!input.cycles && input.terms.serviceType !== "aerobic_inspection") throw new Error(`A ${input.terms.serviceType} contract is made from its plan version's cycles`);
  let terms: Terms = input.terms;
  let endOn = termEndOn(input.startOn, terms.termMonths);
  let inspections: VisitWindow[] = [];
  if (aerobic) {
    const site = await siteVisitTerms(trx, organizationId, input.siteId, input.startOn, input.terms, opts.catalog);
    // The office is warned before visits are added (Justin, 2026-10-05): it must accept the count.
    if (opts.confirmExtraVisits && site.added && opts.acceptVisits !== site.added.visitsPerTerm) throw new MoreVisitsRequired(site.added);
    terms = site.terms;
    const schedule = site.contractVisits
      ? buildAnchoredSchedule(input.startOn, terms.termMonths, terms.visitsPerTerm, site.contractVisits)
      : buildTermSchedule(input.startOn, terms.termMonths, terms.visitsPerTerm);
    endOn = schedule.endOn;
    inspections = schedule.visits;
  } else {
    // No inspections, so the authority's visit rules do not apply; the site's own type still does.
    const site = await trx.selectFrom("sites").select("customerType").where("organizationId", "=", organizationId).where("id", "=", input.siteId).executeTakeFirstOrThrow();
    terms = { ...terms, customerType: site.customerType, serviceType: others[0]!.serviceType };
  }
  const created = await trx
    .insertInto("contracts")
    .values({
      organizationId,
      siteId: input.siteId,
      ...terms,
      startOn: input.startOn,
      endOn,
      autoRenew: input.autoRenew,
      notes: input.notes ?? null,
      previousContractId: input.previousContractId ?? null,
      signedDocumentId: input.signedDocumentId ?? null,
      agreementSnapshot: input.agreementSnapshot === undefined ? null : JSON.stringify(input.agreementSnapshot),
      cancelledAt: null,
      cancelReason: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const planVersionId = terms.planVersionId ?? null;
  const addCycle = async (c: { cycleKey: string; serviceType: Terms["serviceType"]; workTypeId: string | null; schedule: unknown; snapshot: unknown }, visits: VisitWindow[]) => {
    const cycle = await trx
      .insertInto("contractServiceCycles")
      .values({ organizationId, contractId: created.id, cycleKey: c.cycleKey, serviceType: c.serviceType, workTypeId: c.workTypeId, schedule: JSON.stringify(c.schedule), snapshot: JSON.stringify(c.snapshot), planVersionId })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (!visits.length) return;
    await trx
      .insertInto("serviceObligations")
      .values(
        visits.map((v) => ({
          organizationId,
          contractId: created.id,
          siteId: input.siteId,
          serviceType: c.serviceType,
          cycleId: cycle.id,
          sequence: v.sequence,
          windowStart: v.windowStart,
          windowEnd: v.windowEnd,
          dueOn: v.dueOn,
          completedAt: null,
        })),
      )
      .execute();
  };
  if (aerobic) {
    // The inspections' cycle records the visits the contract actually has, authority ones included.
    const schedule = { kind: "visits_per_term", visitsPerTerm: terms.visitsPerTerm };
    await addCycle({ cycleKey: "aerobic", serviceType: "aerobic_inspection", workTypeId: null, schedule, snapshot: { cycleKey: "aerobic", serviceType: "aerobic_inspection", schedule } }, inspections);
  }
  // Pumping and maintenance visits fall from the contract's start and never pass through authority rules.
  for (const c of others) {
    await addCycle({ cycleKey: c.cycleKey, serviceType: c.serviceType, workTypeId: c.workTypeId, schedule: c.schedule, snapshot: c }, buildIntervalSchedule(input.startOn, terms.termMonths, c.schedule));
  }
  if (input.coverage?.length) {
    if (!terms.planVersionId) throw new Error("Coverage is frozen from a plan version");
    // Frozen for the contract's own term: the contract is judged by these alone from now on.
    await trx
      .insertInto("contractCoverageRules")
      .values(
        input.coverage.map((r, i) => ({
          organizationId,
          contractId: created.id,
          ruleKey: r.ruleKey,
          position: i + 1,
          rule: JSON.stringify(r),
          planVersionId: terms.planVersionId!,
          limitCount: r.limit?.count ?? null,
          periodStart: input.startOn,
          periodEnd: endOn,
        })),
      )
      .execute();
  }
  return created.id;
}
