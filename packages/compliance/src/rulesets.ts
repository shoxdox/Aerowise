import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, DB } from "@aerowise/db";
import { rulesetRules, type InspectionRequirements, type RulesetRules } from "@aerowise/domain";
import type { Transaction } from "kysely";

type Executor = Database | Transaction<DB>;

const RULESET_DIR = fileURLToPath(new URL("../rulesets", import.meta.url));

/** Every bundled ruleset file: rulesets/<jurisdiction-key>/v<n>.json. */
export function bundledRulesets(dir = RULESET_DIR): RulesetRules[] {
  const out: RulesetRules[] = [];
  for (const key of readdirSync(dir).sort()) {
    for (const file of readdirSync(join(dir, key)).filter((f) => /^v\d+\.json$/.test(f)).sort()) {
      const rules = rulesetRules.parse(JSON.parse(readFileSync(join(dir, key, file), "utf8")));
      if (rules.jurisdiction.key !== key || `v${rules.version}.json` !== file) {
        throw new Error(`ruleset ${key}/${file} declares ${rules.jurisdiction.key} v${rules.version}`);
      }
      out.push(rules);
    }
  }
  return out;
}

export const rulesHash = (rules: RulesetRules) => createHash("sha256").update(JSON.stringify(rules)).digest("hex");

/**
 * Loads the bundled rulesets into the database. Safe to run on every start and from
 * several processes at once. A published version whose file has since changed is an
 * error: rules change by adding a new version, never by editing one.
 */
export async function syncRulesets(db: Database, rulesets: RulesetRules[] = bundledRulesets()) {
  for (const rules of rulesets) {
    const j = rules.jurisdiction;
    const jurisdiction = await db
      .insertInto("jurisdictions")
      .values({ key: j.key, state: j.state, authorityName: j.authorityName, type: j.type })
      .onConflict((oc) => oc.column("key").doUpdateSet({ state: j.state, authorityName: j.authorityName, type: j.type }))
      .returning("id")
      .executeTakeFirstOrThrow();
    const sha256 = rulesHash(rules);
    await db
      .insertInto("jurisdictionRulesets")
      .values({
        jurisdictionId: jurisdiction.id,
        version: rules.version,
        effectiveFrom: rules.effectiveFrom,
        effectiveTo: rules.effectiveTo,
        rules: JSON.stringify(rules),
        sha256,
        sourceReference: rules.sourceReference,
      })
      .onConflict((oc) => oc.columns(["jurisdictionId", "version"]).doNothing())
      .execute();
    const stored = await db
      .selectFrom("jurisdictionRulesets")
      .select("sha256")
      .where("jurisdictionId", "=", jurisdiction.id)
      .where("version", "=", rules.version)
      .executeTakeFirstOrThrow();
    if (stored.sha256 !== sha256) {
      throw new Error(`ruleset ${j.key} v${rules.version} was changed after it was published; add v${rules.version + 1} instead`);
    }
  }
}

/** A calendar date (YYYY-MM-DD) in a timezone. */
export function dateInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export interface ResolvedJurisdiction {
  jurisdictionId: string;
  key: string;
  authorityName: string;
  rulesetId: string;
  rules: RulesetRules;
  source: "override" | "county";
}

export interface CatalogEntry {
  jurisdiction: { id: string; key: string; state: string; authorityName: string; type: string; active: boolean };
  rulesets: { id: string; version: number; effectiveFrom: string; effectiveTo: string | null; rules: RulesetRules }[];
}

/** Every jurisdiction with its published rulesets, newest version first. The table is small. */
export async function loadCatalog(db: Executor): Promise<CatalogEntry[]> {
  const [jurisdictions, rulesets] = await Promise.all([
    db.selectFrom("jurisdictions").select(["id", "key", "state", "authorityName", "type", "active"]).orderBy("key").execute(),
    db
      .selectFrom("jurisdictionRulesets")
      .select(["id", "jurisdictionId", "version", "effectiveFrom", "effectiveTo", "rules"])
      .where("status", "=", "published")
      .orderBy("version", "desc")
      .execute(),
  ]);
  return jurisdictions.map((j) => ({
    jurisdiction: j,
    rulesets: rulesets
      .filter((r) => r.jurisdictionId === j.id)
      .map((r) => ({ id: r.id, version: r.version, effectiveFrom: dateString(r.effectiveFrom), effectiveTo: r.effectiveTo ? dateString(r.effectiveTo) : null, rules: r.rules as RulesetRules })),
  }));
}

// `date` columns come back as strings with the pg type parser the db package sets up,
// but accept Date too.
const dateString = (d: string | Date) => (typeof d === "string" ? d : d.toISOString().slice(0, 10));

const normalizeCounty = (c: string) =>
  c
    .trim()
    .toLowerCase()
    .replace(/\s+county$/, "")
    .replace(/\s+/g, " ");

/** The ruleset version in force on a date: the newest whose dates cover it. */
export function rulesetOn(entry: CatalogEntry, onDate: string) {
  return entry.rulesets.find((r) => r.effectiveFrom <= onDate && (r.effectiveTo === null || onDate < r.effectiveTo)) ?? null;
}

/**
 * Which authority a site reports to, and under which rules on a date. A jurisdiction set
 * on the site wins; otherwise the site's county is matched against each active
 * ruleset's counties. No match, or more than one, resolves to nothing: the filing then
 * needs a person to decide rather than going to a guessed authority.
 */
export function resolveSite(
  catalog: CatalogEntry[],
  site: { county: string | null; state: string; jurisdictionId: string | null },
  onDate: string,
): ResolvedJurisdiction | null {
  const pick = (entry: CatalogEntry, source: ResolvedJurisdiction["source"]) => {
    const rs = rulesetOn(entry, onDate);
    if (!rs) return null;
    return { jurisdictionId: entry.jurisdiction.id, key: entry.jurisdiction.key, authorityName: entry.jurisdiction.authorityName, rulesetId: rs.id, rules: rs.rules, source };
  };
  if (site.jurisdictionId) {
    const entry = catalog.find((e) => e.jurisdiction.id === site.jurisdictionId);
    return entry ? pick(entry, "override") : null;
  }
  if (!site.county) return null;
  const county = normalizeCounty(site.county);
  const matches = catalog.filter((e) => {
    if (!e.jurisdiction.active || e.jurisdiction.state !== site.state) return false;
    const rs = rulesetOn(e, onDate);
    return rs?.rules.applicability.counties.some((c) => normalizeCounty(c) === county) ?? false;
  });
  return matches.length === 1 ? pick(matches[0]!, "county") : null;
}

export function requirementsOf(resolved: ResolvedJurisdiction): InspectionRequirements {
  return {
    jurisdictionKey: resolved.key,
    authorityName: resolved.authorityName,
    rulesetVersion: resolved.rules.version,
    requiredFields: resolved.rules.inspection.requiredFields,
    requiredPhotos: resolved.rules.inspection.requiredPhotos,
  };
}

/** Resolves one site, loading what it needs. */
export async function resolveSiteById(db: Executor, organizationId: string, siteId: string, onDate: string) {
  const site = await db
    .selectFrom("sites")
    .select(["county", "state", "jurisdictionId"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", siteId)
    .executeTakeFirstOrThrow();
  return resolveSite(await loadCatalog(db), site, onDate);
}

/**
 * What the site's authority adds to an inspection completed at `at` (in the
 * organization's timezone), or null when no authority applies.
 */
export async function siteRequirements(db: Executor, organizationId: string, siteId: string, at: Date): Promise<InspectionRequirements | null> {
  const org = await db.selectFrom("organizations").select("timezone").where("id", "=", organizationId).executeTakeFirstOrThrow();
  const resolved = await resolveSiteById(db, organizationId, siteId, dateInZone(at, org.timezone));
  return resolved ? requirementsOf(resolved) : null;
}
