import { confirmationsFor, loadCatalog, loadConfirmations, rulesetOn } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { dateInZone, FOUNDER_OFFER, profileStatus, publicOverview, verifiedWith, type CoverageItem, type PublicOverview, type SubscriptionConfig } from "@aerowise/domain";
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
      const [catalog, confirmations] = await Promise.all([loadCatalog(db), loadConfirmations(db)]);
      for (const entry of catalog) {
        if (!entry.jurisdiction.active) continue;
        const rs = rulesetOn(entry, today) ?? entry.rulesets[0];
        if (!rs) continue;
        const status = profileStatus(rs.rules);
        if (status === "fictional") continue;
        const verified = verifiedWith(rs.rules);
        const reports = rs.rules.inspectionReports?.submission === "supported";
        const filing = reports && rs.rules.submission.method === "email" ? "email" : reports && rs.rules.submission.portalUrl ? "portal" : "prepared";
        coverage.push({
          key: entry.jurisdiction.key,
          authorityName: entry.jurisdiction.authorityName,
          type: entry.jurisdiction.type,
          counties: rs.rules.applicability.counties,
          // A verified profile without its record never gets the badge, so it reads as a draft.
          status: verified ? "verified" : "draft",
          verified,
          // Only what the authority itself confirmed; partial answers and other evidence stay off the public page.
          confirmedWithAuthority: verified
            ? []
            : confirmationsFor(confirmations, entry.jurisdiction.id)
                .filter((f) => f.state === "authority_confirmed")
                .map((f) => f.label),
          filing,
          rules: {
            intervalMonths: rs.rules.service.intervalMonths,
            monitoredIntervalMonths: rs.rules.service.monitored?.intervalMonths ?? null,
            reportDeadlineDays: rs.rules.filing.deadlineDays,
            renewalDaysBeforePreviousEnd: rs.rules.contracts?.renewalDaysBeforePreviousEnd ?? null,
            requiredFields: rs.rules.inspection.requiredFields,
            contractVisits: !!rs.rules.service.contractVisits,
            correctiveReportDays: rs.rules.service.correctiveReport?.withinDays ?? null,
            destination: filing === "email" ? (rs.rules.submission.email?.to ?? null) : filing === "portal" ? rs.rules.submission.portalUrl : null,
          },
        });
      }
      // Verified authorities first, then by name.
      coverage.sort((a, b) => Number(!!b.verified) - Number(!!a.verified) || a.authorityName.localeCompare(b.authorityName));
      const { designPartnerDays, trialDays, pricePerContractCents, monthlyMinimumCents } = subscription;
      return { coverage, pricing: { designPartnerDays, trialDays, pricePerContractCents, monthlyMinimumCents, founderPricePerContractCents: FOUNDER_OFFER.pricePerContractCents, founderCompanyLimit: FOUNDER_OFFER.companyLimit } };
    },
  );
};
