import { loadCatalog, resolveSite, type CatalogEntry } from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import { buildTermSchedule, serviceIntervalMonths, visitsWithin } from "@aerowise/domain";
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
 * The terms with enough visits that no visit window is longer than the site's authority
 * allows under the rules in force on `startOn`. A site with no authority keeps its plan's
 * visits; visits are added, never removed. Pass `catalog` when doing many sites at once.
 */
export async function termsForSite<T extends VisitTerms>(db: Executor, organizationId: string, siteId: string, startOn: string, terms: T, catalog?: CatalogEntry[]): Promise<T> {
  const site = await db
    .selectFrom("sites")
    .select(["county", "state", "jurisdictionId"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", siteId)
    .executeTakeFirstOrThrow();
  const resolved = resolveSite(catalog ?? (await loadCatalog(db)), site, startOn);
  if (!resolved) return terms;
  const visitsPerTerm = visitsWithin(terms.termMonths, terms.visitsPerTerm, serviceIntervalMonths(resolved.rules, terms.customerType));
  return visitsPerTerm === terms.visitsPerTerm ? terms : { ...terms, visitsPerTerm };
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
  opts: { catalog?: CatalogEntry[] } = {},
) {
  const terms = await termsForSite(trx, organizationId, input.siteId, input.startOn, input.terms, opts.catalog);
  const schedule = buildTermSchedule(input.startOn, terms.termMonths, terms.visitsPerTerm);
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
