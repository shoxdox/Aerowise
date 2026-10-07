import { z } from "zod";
import { id } from "./crm.ts";
import { emailDelivery } from "./demo-requests.ts";
import { SERVICE_REQUEST_KINDS } from "./portal.ts";

// Filing readiness: who holds which license, which complaints and monitoring notices the
// authority must hear about, and what was sent to customers.

const date = z.iso.date();
const datetime = z.iso.datetime({ offset: true });

export const CREDENTIAL_KINDS = ["tceq_maintenance_provider", "tceq_maintenance_technician", "tceq_installer", "other"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export const CREDENTIAL_LABELS: Record<CredentialKind, string> = {
  tceq_maintenance_provider: "TCEQ licensed maintenance provider (MP)",
  tceq_maintenance_technician: "TCEQ registered maintenance technician",
  tceq_installer: "TCEQ OSSF installer",
  other: "Other license or registration",
};
/** Credentials that let someone perform maintenance inspections. */
export const INSPECTING_CREDENTIALS: readonly CredentialKind[] = ["tceq_maintenance_provider", "tceq_maintenance_technician"];

export const credential = z.object({
  id,
  userId: id.nullable(),
  holderName: z.string(),
  kind: z.enum(CREDENTIAL_KINDS),
  number: z.string(),
  expiresOn: date.nullable(),
  verifiedOn: date.nullable(),
  verificationSource: z.string().nullable(),
  active: z.boolean(),
  /** This is the organization's responsible maintenance provider for filings. */
  responsible: z.boolean(),
});
export type Credential = z.infer<typeof credential>;

const credentialFields = {
  userId: id.nullish(),
  holderName: z.string().trim().min(1).max(200),
  kind: z.enum(CREDENTIAL_KINDS),
  number: z.string().trim().min(1).max(50),
  expiresOn: date.nullish(),
  verifiedOn: date.nullish(),
  verificationSource: z.string().trim().max(500).nullish(),
  active: z.boolean().optional(),
};
const verifiedTogether = (v: { verifiedOn?: string | null; verificationSource?: string | null }) => !v.verifiedOn === !v.verificationSource;
const verifiedMessage = { message: "verifiedOn and verificationSource go together" };
export const credentialInput = z.object(credentialFields).refine(verifiedTogether, verifiedMessage);
export const credentialPatch = z.object(credentialFields).partial().refine(verifiedTogether, verifiedMessage);

/** Problems with a credential on a date, for checks before a filing is released. */
export function credentialProblems(c: { active: boolean; expiresOn: string | null; number: string }, onDate: string): string[] {
  const out: string[] = [];
  if (!c.active) out.push("is marked inactive");
  if (c.expiresOn && c.expiresOn < onDate) out.push(`expired on ${c.expiresOn}`);
  if (!c.number.trim()) out.push("has no number");
  return out;
}

// Complaints and monitoring notices.

export const REPORT_CLASSIFICATIONS = ["owner_complaint", "monitoring_notice", "not_reportable"] as const;
export type ReportClassification = (typeof REPORT_CLASSIFICATIONS)[number];
export const REPORT_CLASSIFICATION_LABELS: Record<ReportClassification, string> = {
  owner_complaint: "Owner complaint (report the response to the authority)",
  monitoring_notice: "Electronic monitoring notice (report the response to the authority)",
  not_reportable: "Not reportable",
};

export const officeServiceRequestInput = z.object({
  siteId: id,
  kind: z.enum(SERVICE_REQUEST_KINDS),
  description: z.string().trim().min(3).max(2000),
  contactPhone: z.string().trim().max(40).nullish(),
  /** When the call, text or monitoring alert came in. Defaults to now. */
  receivedAt: datetime.optional(),
});

export const classifyInput = z.object({
  classification: z.enum(REPORT_CLASSIFICATIONS),
  note: z.string().trim().max(2000).nullish(),
});

export const RESPONSE_OUTCOMES = ["resolved", "outstanding"] as const;

export const responseInput = z.object({
  action: z.string().trim().min(3).max(2000),
  respondedAt: datetime,
  jobId: id.nullish(),
  /** Whether the problem is fixed, or still outstanding (a part on order, a repair scheduled). */
  outcome: z.enum(RESPONSE_OUTCOMES),
});

export const serviceRequestDetail = z.object({
  id,
  siteId: id,
  customerId: id,
  kind: z.enum(SERVICE_REQUEST_KINDS),
  description: z.string(),
  source: z.enum(["portal", "office"]),
  receivedAt: datetime,
  status: z.enum(["open", "closed"]),
  classification: z.enum(REPORT_CLASSIFICATIONS).nullable(),
  classificationNote: z.string().nullable(),
  classifiedAt: datetime.nullable(),
  responseAction: z.string().nullable(),
  respondedAt: datetime.nullable(),
  responseOutcome: z.enum(RESPONSE_OUTCOMES).nullable(),
  responseJobId: id.nullable(),
});
export type ServiceRequestDetail = z.infer<typeof serviceRequestDetail>;

/** What an authority report says about one complaint or monitoring notice. */
export interface ReportedResponse {
  requestId: string;
  classification: "owner_complaint" | "monitoring_notice";
  receivedAt: string;
  description: string;
  responseAction: string | null;
  respondedAt: string | null;
  /** After the response: resolved, or still outstanding. Null when nothing was done yet. */
  outcome: "resolved" | "outstanding" | null;
  /** Received before this reporting period and still unresolved. */
  carriedOver: boolean;
}

// Customer deliveries.

export const customerDelivery = z.object({
  id,
  documentKind: z.enum(["inspection_report", "signed_agreement"]),
  channel: z.literal("email"),
  recipient: z.string(),
  documentSha256: z.string(),
  status: z.enum(["accepted", "failed"]),
  attemptedAt: datetime,
  error: z.string().nullable(),
  /** For an accepted send: the local test outbox (nobody received it) or a mail provider. */
  delivery: emailDelivery.nullable(),
});
export type CustomerDelivery = z.infer<typeof customerDelivery>;

// ---- Maintenance provider signature on authority reports (30 TAC 285.7(b)(3)) ----

export const signReportInput = z.object({
  /** The signer's full name, as it appears on their MP license. */
  typedName: z.string().trim().min(2).max(200),
  /**
   * Needed when the signer is not the MP named for the site's contract: the documented
   * delegation and supervision that lets them sign for that MP. Quoted in the statement.
   */
  delegationNote: z.string().trim().max(2000).nullish(),
});

export const reportSigning = z.object({
  reportId: id,
  version: z.number().int(),
  /** The statement the signature will carry, in the signer's words. */
  statement: z.string(),
  /** The name on the signer's MP license, which they type to sign. */
  holderName: z.string().nullable(),
  /** Why this person cannot sign now. Empty when they can. */
  problems: z.array(z.string()),
  /** The filing and customer copy wait for this signature. False only under a fictional demo ruleset. */
  required: z.boolean(),
  /** The MP who signs this site's reports by default: the one named on the contract, else the organization's responsible MP. */
  provider: z.object({ name: z.string(), number: z.string(), source: z.enum(["contract", "organization"]) }).nullable(),
  /** This person is not that MP, so signing needs a documented delegation and supervision. */
  delegationRequired: z.boolean(),
  /** The customer copy is signed with the authority copy; until then it is not delivered. */
  customerCopy: z.object({ reportId: id, version: z.number().int(), signed: z.boolean() }).nullable(),
  signature: z
    .object({
      signedByName: z.string(),
      typedName: z.string(),
      licenseNumber: z.string(),
      delegationNote: z.string().nullable(),
      statement: z.string(),
      signedAt: datetime,
      sha256: z.string(),
    })
    .nullable(),
});
export type ReportSigning = z.infer<typeof reportSigning>;

export const contractProviderInput = z.object({
  /** The MP license named on the contract, or null to fall back to the organization's responsible MP. */
  credentialId: id.nullable(),
});

// ---- Which 30 TAC 285.7 deadline a contract filing has ----

export const CONTRACT_FILING_BASES = ["initial_policy", "after_initial_policy", "renewal", "replacement"] as const;
export type ContractFilingBasis = (typeof CONTRACT_FILING_BASES)[number];
export const CONTRACT_FILING_BASIS_LABELS: Record<ContractFilingBasis, string> = {
  initial_policy: "Initial two-year service policy (new system)",
  after_initial_policy: "First contract after the initial two-year policy",
  renewal: "Renewal of a contract that is expiring",
  replacement: "Replacement after a contract was discontinued",
};
/** The date each basis is counted from, as the office is asked for it. */
export const CONTRACT_FILING_BASIS_DATE_LABELS: Record<ContractFilingBasis, string | null> = {
  initial_policy: null,
  after_initial_policy: "Initial policy expires on",
  renewal: "Current contract expires on",
  replacement: "Previous contract ended on",
};

export const contractFilingBasisInput = z
  .object({
    basis: z.enum(CONTRACT_FILING_BASES),
    basisOn: date.nullish(),
    note: z.string().trim().max(1000).nullish(),
  })
  .refine((v) => v.basis === "initial_policy" || Boolean(v.basisOn), { message: "Give the date the deadline counts from", path: ["basisOn"] });

export const contractFilingBasis = z.object({
  basis: z.enum(CONTRACT_FILING_BASES).nullable(),
  basisOn: date.nullable(),
  note: z.string().nullable(),
  /** Worked out from the contract this one renews in Aerowise, not entered by a person. */
  derived: z.boolean(),
});
export type ContractFilingBasisState = z.infer<typeof contractFilingBasis>;

// ---- Ending a contract: the provider's written notice (30 TAC 285.7(d)(3)(A), (B)) ----

export const DISCONTINUED_BY = ["provider", "owner"] as const;

export const discontinuationNoticeInput = z.object({
  sentOn: date,
  /** Who was written to, and how (for example "LCRA by email, Acme Aerobics by letter, owner by email"). */
  note: z.string().trim().min(3).max(1000),
});

export const contractDiscontinuation = z.object({
  discontinuedBy: z.enum(DISCONTINUED_BY).nullable(),
  serviceEndsOn: date.nullable(),
  /** The latest day the written notice can go out: 30 days before service ends. */
  noticeDueOn: date.nullable(),
  /** Who must receive the notice under 285.7(d)(3). */
  recipients: z.array(z.string()),
  noticeSentOn: date.nullable(),
  noticeNote: z.string().nullable(),
});
