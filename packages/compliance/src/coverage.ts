import type { Database } from "@aerowise/db";
import { profileStatus, verifiedWith, type RulesetCoverage } from "@aerowise/domain";
import { explainSite, loadCatalog, rulesetOn } from "./rulesets.ts";

/**
 * Every reporting authority with how far its rules are checked and how many sites use it,
 * across all organizations (platform admin only). Sites are resolved the same way filings
 * are, so a hand-picked authority counts and a site in a county two authorities share is
 * counted as one to decide, not as both.
 */
export async function rulesetCoverage(db: Database, today: string): Promise<RulesetCoverage> {
  const [catalog, sites] = await Promise.all([
    loadCatalog(db),
    db.selectFrom("sites").select(["organizationId", "county", "state", "jurisdictionId"]).where("active", "=", true).execute(),
  ]);
  const use = new Map<string, { sites: number; orgs: Set<string>; toDecide: number }>();
  const tally = (id: string) => use.get(id) ?? (use.set(id, { sites: 0, orgs: new Set(), toDecide: 0 }), use.get(id)!);
  let sitesWithoutAuthority = 0;
  for (const site of sites) {
    const r = explainSite(catalog, site, today);
    if (r.resolved) {
      const t = tally(r.resolved.jurisdictionId);
      t.sites++;
      t.orgs.add(site.organizationId);
    } else if (r.candidates.length) {
      for (const c of r.candidates) tally(c.jurisdiction.id).toDecide++;
    } else {
      sitesWithoutAuthority++;
    }
  }
  return {
    today,
    sitesWithoutAuthority,
    items: catalog.map((entry) => {
      const rs = rulesetOn(entry, today) ?? entry.rulesets[0] ?? null;
      const rules = rs?.rules;
      const t = use.get(entry.jurisdiction.id);
      return {
        key: entry.jurisdiction.key,
        state: entry.jurisdiction.state,
        authorityName: entry.jurisdiction.authorityName,
        type: entry.jurisdiction.type,
        active: entry.jurisdiction.active,
        rulesetVersion: rulesetOn(entry, today)?.version ?? null,
        versions: entry.rulesets.length,
        profileStatus: rules ? profileStatus(rules) : "fictional",
        verified: rules ? verifiedWith(rules) : null,
        sourcesCheckedOn: rules?.profile?.sourcesCheckedOn ?? null,
        sourceCount: rules?.profile?.sources.length ?? 0,
        unresolved: rules?.profile?.unresolved ?? [],
        sites: t?.sites ?? 0,
        organizations: t?.orgs.size ?? 0,
        sitesToDecide: t?.toDecide ?? 0,
      };
    }),
  };
}
