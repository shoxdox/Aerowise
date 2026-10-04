import { z } from "zod";
import { id } from "./crm.ts";
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

export const responseInput = z.object({
  action: z.string().trim().min(3).max(2000),
  respondedAt: datetime,
  jobId: id.nullish(),
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
});
export type CustomerDelivery = z.infer<typeof customerDelivery>;
