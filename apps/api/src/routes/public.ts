import { loadCatalog, rulesetOn } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { dateInZone, profileStatus, publicOverview, verifiedWith, type CoverageItem, type PublicOverview, type SubscriptionConfig } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Every customer so far is in Texas, so the public page reads rules as of today there. */
const PUBLIC_TIMEZONE = "America/Chicago";

/** Per IP: plenty for people reading the page, little for anyone scraping it in a loop. */
const overviewLimit = { max: 60, timeWindow: "1 minute" };

export const publicRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; subscription: SubscriptionConfig }> = async (app, { db, now, subscription }) => {
  app.get(
    "/public/overview",
    {
      config: { public: true, rateLimit: overviewLimit },
      schema: {
        tags: ["public"],
        summary: "County coverage and design-partner pricing for the marketing page",
        description: "No sign-in. Lists the authorities with real (verified or draft) rules; fictional rules are left out.",
        response: { 200: publicOverview },
      },
    },
    async (): Promise<PublicOverview> => {
      const today = dateInZone(now(), PUBLIC_TIMEZONE);
      const coverage: CoverageItem[] = [];
      for (const entry of await loadCatalog(db)) {
        if (!entry.jurisdiction.active) continue;
        const rs = rulesetOn(entry, today) ?? entry.rulesets[0];
        if (!rs) continue;
        const status = profileStatus(rs.rules);
        if (status === "fictional") continue;
        const verified = verifiedWith(rs.rules);
        coverage.push({
          key: entry.jurisdiction.key,
          authorityName: entry.jurisdiction.authorityName,
          type: entry.jurisdiction.type,
          counties: rs.rules.applicability.counties,
          // A verified profile without its record never gets the badge, so it reads as a draft.
          status: verified ? "verified" : "draft",
          verified,
        });
      }
      // Verified authorities first, then by name.
      coverage.sort((a, b) => Number(!!b.verified) - Number(!!a.verified) || a.authorityName.localeCompare(b.authorityName));
      const { designPartnerDays, trialDays, pricePerContractCents, monthlyMinimumCents } = subscription;
      return { coverage, pricing: { designPartnerDays, trialDays, pricePerContractCents, monthlyMinimumCents } };
    },
  );
};
