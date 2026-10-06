import { contractFilingRequired, mayAutoSubmit, profileStatus, type RulesetRules } from "./filings.ts";

// What an authority's ruleset asks of a site, in a few plain lines for the site's panel
// (W10.5). Each line has a stable key so a later confirmation status can be shown per line
// (W12.V4). Nothing here says more than the ruleset does: where the authority has not said
// how something reaches it, the line says so instead of guessing.

export const REQUIREMENT_KEYS = ["service", "reportDeadline", "reportChannel", "contracts", "acknowledgment"] as const;
export type RequirementKey = (typeof REQUIREMENT_KEYS)[number];

export interface RequirementLine {
  key: RequirementKey;
  label: string;
  value: string;
}

const months = (n: number) => (n === 1 ? "month" : `${n} months`);

export function authorityRequirements(rules: RulesetRules): RequirementLine[] {
  const lines: RequirementLine[] = [];
  const s = rules.service;
  lines.push({
    key: "service",
    label: "Inspections",
    value: `At least every ${months(s.intervalMonths)}${s.commercialIntervalMonths ? `, every ${months(s.commercialIntervalMonths)} for commercial systems` : ""}${s.monitored ? `, or every ${months(s.monitored.intervalMonths)} with qualifying monitoring` : ""}.`,
  });
  lines.push({ key: "reportDeadline", label: "Report deadline", value: `Within ${rules.filing.deadlineDays} days of the inspection.` });

  const auto = mayAutoSubmit(rules);
  const sub = rules.submission;
  let channel: string;
  if (rules.inspectionReports?.submission === "unknown") {
    channel = "Not published. Report filings wait for review; nothing is sent to a guessed address.";
  } else if (sub.method === "email" && sub.email) {
    channel = `By email to ${sub.email.to}. ${auto ? "Sent automatically once the report is ready." : "The office releases each one."}`;
  } else {
    channel = `By hand${sub.portalUrl ? " on the authority's portal" : " (portal, mail or counter)"}. Aerowise prepares the package and the office records the submission.`;
  }
  lines.push({ key: "reportChannel", label: "How reports are sent", value: channel });

  const c = rules.contracts;
  lines.push({
    key: "contracts",
    label: "Contracts",
    value: !contractFilingRequired(rules)
      ? "Not filed with this authority."
      : `Filed with the authority${c?.renewalDaysBeforePreviousEnd != null ? `; a renewal at least ${c.renewalDaysBeforePreviousEnd} days before the previous contract ends` : ""}.${c?.submission === "unknown" ? " How they reach it is not published, so contract filings wait for review." : ""}`,
  });

  lines.push({
    key: "acknowledgment",
    label: "Acknowledgment",
    value:
      rules.confirmation.mode === "manual_reference"
        ? "The authority replies; record its reference to finish a filing."
        : "The authority publishes no acknowledgment. A filing stays sent unless you record proof it was received.",
  });
  return lines;
}

/** Where the lines come from, said once above them. */
export function requirementsSource(rules: RulesetRules): string {
  switch (profileStatus(rules)) {
    case "fictional":
      return "Example rules for the demo; no real authority.";
    case "draft":
      return "Read from the authority's public sources and not confirmed with it.";
    default:
      return "Confirmed with the authority.";
  }
}
