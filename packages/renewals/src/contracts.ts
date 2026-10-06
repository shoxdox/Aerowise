import { loadCatalog, resolveSite, siteMonitoredOn, type CatalogEntry } from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import { anchoredVisitsWithin, buildAnchoredSchedule, buildTermSchedule, serviceIntervalMonths, visitsWithin, type ContractVisitRule } from "@aerowise/domain";
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
): Promise<{ terms: T; added: AddedVisits | null; contractVisits: (ContractVisitRule & { unconfirmed?: string }) | null }> {
  const site = await db
    .selectFrom("sites")
    .select(["county", "state", "jurisdictionId", "customerType", "permitIntervalMonths"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", siteId)
    .executeTakeFirstOrThrow();
  terms = { ...terms, customerType: site.customerType };
  const resolved = resolveSite(catalog ?? (await loadCatalog(db)), site, startOn);
  if (!resolved) return { terms, added: null, contractVisits: null };
  // Monitoring only matters where the authority allows a longer interval for it.
  const monitored = resolved.rules.service.monitored ? await siteMonitoredOn(db, organizationId, siteId, startOn) : false;
  const intervalMonths = serviceIntervalMonths(resolved.rules, terms.customerType, monitored, site.permitIntervalMonths);
  const contractVisits = resolved.rules.service.contractVisits ?? null;
  const visitsPerTerm = contractVisits ? anchoredVisitsWithin(terms.termMonths, terms.visitsPerTerm, intervalMonths) : visitsWithin(terms.termMonths, terms.visitsPerTerm, intervalMonths);
  if (visitsPerTerm === terms.visitsPerTerm) return { terms, added: null, contractVisits };
  return {
    terms: { ...terms, visitsPerTerm },
    added: { planVisits: terms.visitsPerTerm, visitsPerTerm, authorityName: resolved.authorityName, intervalMonths, ...(contractVisits ? { contractVisits } : {}) },
    contractVisits,
  };
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
  input: { siteId: string; startOn: string; terms: Terms; autoRenew: boolean; notes?: string | null; previousContractId?: string; signedDocumentId?: string | null },
  opts: { catalog?: CatalogEntry[]; acceptVisits?: number; confirmExtraVisits?: boolean } = {},
) {
  const { terms, added, contractVisits } = await siteVisitTerms(trx, organizationId, input.siteId, input.startOn, input.terms, opts.catalog);
  // The office is warned before visits are added (Justin, 2026-10-05): it must accept the count.
  if (opts.confirmExtraVisits && added && opts.acceptVisits !== added.visitsPerTerm) throw new MoreVisitsRequired(added);
  const schedule = contractVisits
    ? buildAnchoredSchedule(input.startOn, terms.termMonths, terms.visitsPerTerm, contractVisits)
    : buildTermSchedule(input.startOn, terms.termMonths, terms.visitsPerTerm);
  const created = await trx
    .insertInto("contracts")
    .values({
      organizationId,
      siteId: input.siteId,
      ...terms,
      startOn: input.startOn,
      endOn: schedule.endOn,
      autoRenew: input.autoRenew,
      notes: input.notes ?? null,
      previousContractId: input.previousContractId ?? null,
      signedDocumentId: input.signedDocumentId ?? null,
      cancelledAt: null,
      cancelReason: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("serviceObligations")
    .values(
      schedule.visits.map((v) => ({
        organizationId,
        contractId: created.id,
        siteId: input.siteId,
        serviceType: terms.serviceType,
        sequence: v.sequence,
        windowStart: v.windowStart,
        windowEnd: v.windowEnd,
        dueOn: v.dueOn,
        completedAt: null,
      })),
    )
    .execute();
  return created.id;
}
