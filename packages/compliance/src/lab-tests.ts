import type { Database, DB } from "@aerowise/db";
import { addDays, addMonths, labTestRequirement, LAB_TEST_DUE_SOON_DAYS, type LabTestStatus } from "@aerowise/domain";
import { sql, type Transaction } from "kysely";
import { explainSite, loadCatalog, rulesetOn, type CatalogEntry } from "./rulesets.ts";

type Executor = Database | Transaction<DB>;

/**
 * Where each site stands on the lab tests its authority requires, on `today`. Only sites
 * with a contract in force count: the requirement is the maintenance provider's while it
 * services the system. The type (residential or commercial) is that contract's.
 *
 * The next test is due `everyMonths` after the latest sample that has not been replaced
 * by a correction. With none on record, it counts from the later of the site's first
 * contract with this organization and the day the authority's rules took effect.
 */
export async function labTestStatuses(db: Executor, organizationId: string, today: string, opts: { siteId?: string; catalog?: CatalogEntry[] } = {}) {
  let q = db
    .selectFrom("contracts as k")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "k.siteId").onRef("s.organizationId", "=", "k.organizationId"))
    .select(["s.id as siteId", "s.county", "s.state", "s.jurisdictionId", "k.customerType"])
    .select((eb) =>
      eb
        .selectFrom("contracts as first")
        .select((f) => f.fn.min("first.startOn").as("v"))
        .whereRef("first.organizationId", "=", "k.organizationId")
        .whereRef("first.siteId", "=", "k.siteId")
        .where("first.status", "=", "active")
        .as("firstStartOn"),
    )
    .select((eb) =>
      eb
        .selectFrom("labTests as t")
        .select(sql<string>`max(t.sampled_on)::text`.as("v"))
        .whereRef("t.organizationId", "=", "k.organizationId")
        .whereRef("t.siteId", "=", "k.siteId")
        .where((w) => w.not(w.exists(w.selectFrom("labTests as r").select("r.id").whereRef("r.organizationId", "=", "t.organizationId").whereRef("r.replacesId", "=", "t.id"))))
        .as("lastSampledOn"),
    )
    .where("k.organizationId", "=", organizationId)
    .where("k.status", "=", "active")
    .where("k.startOn", "<=", today)
    .where("k.endOn", ">=", today)
    .where("s.active", "=", true);
  if (opts.siteId) q = q.where("s.id", "=", opts.siteId);
  const rows = await q.execute();
  if (rows.length === 0) return [];
  const catalog = opts.catalog ?? (await loadCatalog(db));
  const out: (LabTestStatus & { siteId: string })[] = [];
  for (const r of rows) {
    const resolved = explainSite(catalog, r, today).resolved;
    const rule = resolved ? labTestRequirement(resolved.rules, r.customerType) : null;
    if (!resolved || !rule) continue;
    const entry = catalog.find((e) => e.jurisdiction.id === resolved.jurisdictionId)!;
    const inForceFrom = rulesetOn(entry, today)!.effectiveFrom;
    const firstStart = r.firstStartOn!;
    const basisDate = r.lastSampledOn ?? (firstStart > inForceFrom ? firstStart : inForceFrom);
    const dueOn = addMonths(basisDate, rule.everyMonths);
    const dueBasis = r.lastSampledOn
      ? `${rule.everyMonths} months after the last sample on ${r.lastSampledOn}`
      : basisDate === firstStart
        ? `${rule.everyMonths} months after the first contract started on ${firstStart}, with no test on record`
        : `${rule.everyMonths} months after ${resolved.authorityName}'s rules took effect on ${inForceFrom}, with no test on record`;
    out.push({
      siteId: r.siteId,
      authorityName: resolved.authorityName,
      analytes: rule.analytes,
      everyMonths: rule.everyMonths,
      note: rule.note ?? null,
      lastSampledOn: r.lastSampledOn,
      dueOn,
      dueBasis,
      state: today > dueOn ? "late" : today >= addDays(dueOn, -LAB_TEST_DUE_SOON_DAYS) ? "due_soon" : "ok",
    });
  }
  return out;
}
