import { z } from "zod";

// The first-run checklist on the office home. Every item is worked out from the company's
// own records each time it is shown, never ticked by hand, so it cannot say "done" about
// something that is not, and it disappears once every required item is.

export const ONBOARDING_ITEMS = [
  "company_details",
  "responsible_mp",
  "technicians",
  "service_counties",
  "customers",
  "sites",
  "authority_fit",
  "contract",
  "scheduled_visit",
  "reviewed_report",
  "stripe",
  "quickbooks",
] as const;
export type OnboardingItemKey = (typeof ONBOARDING_ITEMS)[number];

/** What the checklist is worked out from: plain facts read from the database. */
export interface OnboardingFacts {
  company: { name: string; phone: string | null; addressLine1: string | null; city: string | null; state: string | null; postalCode: string | null };
  /** Whether the responsible MP chosen on the licenses page is an active, unexpired MP license. */
  responsibleMpValid: boolean;
  /** Active members who do inspections: everyone with the technician role, plus anyone else holding a valid inspecting credential. */
  inspectors: { name: string; role: string; hasValidCredential: boolean }[];
  serviceCounties: number;
  customers: number;
  sites: number;
  applicableSites: number;
  contracts: number;
  scheduledVisits: number;
  reviewedReports: number;
  role?: string;
  stripeChargesEnabled: boolean;
  quickbooksConnected: boolean;
}

export const onboardingItem = z.object({
  key: z.enum(ONBOARDING_ITEMS),
  label: z.string(),
  done: z.boolean(),
  optional: z.boolean(),
  /** Why it is not done yet, in a sentence; null once done. */
  detail: z.string().nullable(),
  href: z.string().nullable(),
});
export type OnboardingItem = z.infer<typeof onboardingItem>;

export const onboardingChecklist = z.object({
  /** True when every required item is done; the office home then hides the checklist. */
  complete: z.boolean(),
  items: z.array(onboardingItem),
});
export type OnboardingChecklist = z.infer<typeof onboardingChecklist>;

const item = (key: OnboardingItemKey, label: string, href: string, missing: string | null, optional = false): OnboardingItem => ({
  key,
  label,
  href,
  optional,
  done: missing === null,
  detail: missing,
});

function companyDetailsMissing(c: OnboardingFacts["company"]): string | null {
  const missing = [
    !c.phone && "phone",
    !c.addressLine1 && "street address",
    !c.city && "city",
    !c.state && "state",
    !c.postalCode && "ZIP code",
  ].filter((v): v is string => typeof v === "string");
  return missing.length ? `Add the company's ${missing.join(", ")}. They print on every report and invoice.` : null;
}

function techniciansMissing(inspectors: OnboardingFacts["inspectors"]): string | null {
  if (!inspectors.some((p) => p.hasValidCredential)) return "Invite a technician and record their TCEQ license, or record your own if you do the inspections.";
  const without = inspectors.filter((p) => !p.hasValidCredential).map((p) => p.name);
  if (without.length) return `Record a current TCEQ license for ${without.join(", ")}.`;
  return null;
}

export function onboardingChecklistFor(f: OnboardingFacts): OnboardingChecklist {
  const items = [
    item("company_details", "Company details", "/settings/company", companyDetailsMissing(f.company)),
    item("responsible_mp", "Responsible maintenance provider", "/settings/credentials", f.responsibleMpValid ? null : "Choose the company's current TCEQ MP license."),
    item(
      "technicians",
      "Technicians and their licenses",
      f.inspectors.some((p) => p.hasValidCredential) ? "/settings/credentials" : "/settings/users",
      techniciansMissing(f.inspectors),
    ),
    item("service_counties", "Service counties", "/settings/company", f.serviceCounties > 0 ? null : "List the counties you work in."),
    item("customers", "First customer", "/customers", f.customers > 0 ? null : "Import your customer list from a spreadsheet, or add a customer."),
    item("sites", "First service site", "/sites", f.sites > 0 ? null : "Add a service address, system and permit information to a customer."),
    item("authority_fit", "Review site authority applicability", "/sites", f.applicableSites > 0 ? null : "Review the permit, reporting authority and unresolved requirements on your first site. A draft profile is not authority acceptance."),
    item("contract", "First contract", "/sites", f.contracts > 0 ? null : "Choose a plan and record the service term on a site."),
    item("scheduled_visit", "First scheduled visit", "/due", f.scheduledVisits > 0 ? null : "Schedule a visit from Due, or book supported work from a site."),
    item("reviewed_report", "First reviewed and signed report", "/filings", f.reviewedReports > 0 ? null : "Review the completed inspection and have the responsible maintenance provider sign its report in the office."),
    item("stripe", "Connect Stripe", "/settings/billing", f.stripeChargesEnabled ? null : "Optional online payments. Check and manual-payment workflows do not need Stripe.", true),
    item("quickbooks", "Connect QuickBooks", "/quickbooks", f.quickbooksConnected ? null : "Optional: keep customers and invoices in step with QuickBooks.", true),
  ];
  if (f.role === "office") {
    for (const i of items) {
      if (["company_details", "responsible_mp", "technicians", "service_counties", "stripe", "quickbooks"].includes(i.key) && !i.done) {
        i.href = null;
        i.detail = `Ask the company owner: ${i.detail}`;
      }
    }
  }
  return { complete: items.every((i) => i.done || i.optional), items };
}
