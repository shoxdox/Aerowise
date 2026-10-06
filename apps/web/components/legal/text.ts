import type { LegalDocument } from "@aerowise/domain";

// PLACEHOLDER TEXT. Not legal advice and not reviewed by a lawyer. Justin replaces this with
// lawyer-reviewed text; when he does, bump the version in packages/domain/src/legal.ts so
// every owner is asked to accept the new text.

export const PLACEHOLDER_WARNING = "Placeholder text. This is not the final, lawyer-reviewed version.";

export const LEGAL_TEXT: Record<LegalDocument, { heading: string; paragraphs: string[] }[]> = {
  terms: [
    { heading: "Who these terms are for", paragraphs: ["These terms cover a maintenance company's use of Aerowise, accepted by the company's owner on its behalf."] },
    {
      heading: "Your filings stay your responsibility",
      paragraphs: [
        "Aerowise prepares and tracks reports and filings. The licensed maintenance provider reviews, signs and is responsible for every report sent to a permitting authority.",
      ],
    },
    { heading: "Your data", paragraphs: ["Your customer and inspection records belong to your company. You can export them at any time, including after your plan ends."] },
    { heading: "Fees", paragraphs: ["Fees are as shown on your subscription page. Design partners pay nothing during their free period."] },
    { heading: "Changes", paragraphs: ["When these terms change, owners are asked to accept the new version before continuing."] },
  ],
  privacy: [
    { heading: "What we collect", paragraphs: ["Account details for your staff, and the customer, site and inspection records your company enters or imports."] },
    { heading: "How it is used", paragraphs: ["Only to run Aerowise for your company: scheduling, inspections, reports, filings, invoices and messages you send."] },
    { heading: "Who it is shared with", paragraphs: ["The permitting authorities and customers you send reports to, and the service providers that deliver email, texts and payments for you."] },
    { heading: "Changes", paragraphs: ["When this policy changes, owners are asked to accept the new version before continuing."] },
  ],
};
