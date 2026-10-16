import { bundledRulesets } from "@aerowise/compliance";
import { authorityRequirements, profileStatus, requirementsSource, rulesetRules, type RulesetRules } from "@aerowise/domain";
import { describe, expect, it } from "vitest";

// The newest bundled version of an authority's ruleset.
const load = (key: string) => bundledRulesets().filter((r) => r.jurisdiction.key === key).sort((a, b) => b.version - a.version)[0]!;
const base = (over: Record<string, unknown> = {}): RulesetRules => rulesetRules.parse({ ...load("tx-example-county"), ...over });

const line = (rules: RulesetRules, key: string) => authorityRequirements(rules).find((l) => l.key === key)!.value;

describe("authority requirements on the site panel", () => {
  it("says the interval, deadline, channel, contracts and acknowledgment of the example rules", () => {
    const r = base();
    expect(authorityRequirements(r).map((l) => l.key)).toEqual(["service", "reportDeadline", "reportChannel", "contracts", "acknowledgment"]);
    expect(line(r, "service")).toBe("At least every 4 months.");
    expect(line(r, "reportDeadline")).toBe("Within 14 days of the inspection.");
    expect(line(r, "reportChannel")).toBe(
      "By email to filings@tx-example-county.example. Sent automatically once the maintenance provider signs the report. The office may file by CSV upload instead (FICTIONAL: Example County CSV layout EC-CSV-1, made up for development and tests).",
    );
    // Without a CSV layout the line is only the email channel; filing by CSV says so instead.
    expect(line(base({ export: undefined }), "reportChannel")).toBe("By email to filings@tx-example-county.example. Sent automatically once the maintenance provider signs the report.");
    expect(line(base({ submission: { method: "csv_export", fallback: "manual_export", portalUrl: null } }), "reportChannel")).toMatch(/^By CSV upload, in its own column layout \(FICTIONAL: Example County CSV layout EC-CSV-1/);
    expect(line(r, "contracts")).toBe("Not filed with this authority.");
    expect(line(r, "acknowledgment")).toMatch(/record its reference/);
    expect(requirementsSource(r)).toMatch(/Example rules/);
  });

  it("never presents a draft authority's channel as confirmed", () => {
    // Travis County: draft requirements from public pages, with no published way to send reports.
    const travis = load("tx-travis-county");
    expect(requirementsSource(travis)).toBe("Read from the authority's public sources and not confirmed with it.");
    expect(line(travis, "reportChannel")).toMatch(/^Not published\. /);
    // A draft authority with a published email is still released by the office, never sent on its own.
    const draftEmail = { ...travis, inspectionReports: undefined, submission: base().submission, filing: { ...travis.filing, autoSubmit: true } };
    expect(line(draftEmail, "reportChannel")).toMatch(/The office releases each one\.$/);

    const unknown = base({ inspectionReports: { submission: "unknown" }, contracts: { filingRequired: true, renewalDaysBeforePreviousEnd: 30, submission: "unknown" } });
    expect(line(unknown, "reportChannel")).toMatch(/^Not published\. .*nothing is sent to a guessed address/);
    expect(line(unknown, "contracts")).toBe(
      "Filed with the authority; a renewal at least 30 days before the previous contract ends. How they reach it is not published, so contract filings wait for review.",
    );
  });

  it("covers commercial and monitored intervals, hand filing and no published acknowledgment", () => {
    const r = base({
      service: { intervalMonths: 4, commercialIntervalMonths: 1, monitored: { intervalMonths: 6, appliesTo: ["residential"], note: "x" } },
      submission: { method: "manual_export", portalUrl: "https://portal.example.gov" },
      confirmation: { mode: "none_published" },
    });
    expect(line(r, "service")).toBe("At least every 4 months, every month for commercial systems, or every 6 months with qualifying monitoring.");
    expect(line(r, "reportChannel")).toMatch(/^By hand on the authority's portal\./);
    expect(line(r, "acknowledgment")).toMatch(/publishes no acknowledgment/);
  });

  it("summarizes every bundled ruleset, and no draft reads as confirmed", () => {
    for (const r of bundledRulesets()) {
      expect(authorityRequirements(r)).toHaveLength(5);
      if (profileStatus(r) === "draft") expect(requirementsSource(r)).toMatch(/not confirmed/);
      if (r.inspectionReports?.submission === "unknown") expect(authorityRequirements(r).find((l) => l.key === "reportChannel")!.value).toMatch(/^Not published\./);
    }
  });
});
