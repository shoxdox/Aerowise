import type { ColumnType, Generated } from "kysely";
import type {
  CredentialKind,
  ReportClassification,
  FilingStatus,
  InvoicePaymentStatus,
  InvoiceStatus,
  PaymentMethod,
  PaymentRecordStatus,
  QuickBooksConflictKind,
  QuickBooksEntityType,
  QuickBooksSyncStatus,
  RefundStatus,
  Role,
  SmsKind,
  SmsSkipReason,
  SmsStatus,
  SubmissionMethod,
} from "@aerowise/domain";

// Hand-written Kysely table types (camelCase via CamelCasePlugin). Keep in sync with
// migrations/*.sql.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, never, never>;

export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  timezone: Generated<string>;
  logoUrl: string | null;
  invoiceTermsDays: Generated<number>;
  defaultTaxRateBps: Generated<number>;
  nextInvoiceNumber: Generated<number>;
  stripeAccountId: string | null;
  stripeChargesEnabled: Generated<boolean>;
  stripeDetailsSubmitted: Generated<boolean>;
  renewalWindowDays: Generated<number>;
  renewalAutoSend: Generated<boolean>;
  renewalPayment: Generated<"pay_to_activate" | "invoice">;
  renewalTerms: ColumnType<string | null, string | null | undefined, string | null>;
  smsEnabled: Generated<boolean>;
  smsKinds: ColumnType<SmsKind[], SmsKind[] | undefined, SmsKind[]>;
  smsFromNumber: ColumnType<string | null, string | null | undefined, string | null>;
  routeStartAddress: ColumnType<string | null, string | null | undefined, string | null>;
  routeStartLat: ColumnType<number | null, number | null | undefined, number | null>;
  routeStartLng: ColumnType<number | null, number | null | undefined, number | null>;
  routeReturnToStart: Generated<boolean>;
  routeStopMinutes: Generated<number>;
  routeDayMinutes: Generated<number>;
  routeSpeedMph: Generated<number>;
  responsibleCredentialId: ColumnType<string | null, string | null | undefined, string | null>;
  createdAt: CreatedAt;
}

export interface UsersTable {
  id: Generated<string>;
  name: string;
  email: string;
  phone: string | null;
  passwordHash: string | null;
  active: Generated<boolean>;
  createdAt: CreatedAt;
}

export interface MembershipsTable {
  organizationId: string;
  userId: string;
  role: Role;
  technicianLicense: string | null;
  active: Generated<boolean>;
  createdAt: CreatedAt;
}

export interface SessionsTable {
  id: Generated<string>;
  tokenHash: Buffer;
  organizationId: string;
  userId: string;
  createdAt: CreatedAt;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
}

export interface CustomersTable {
  id: Generated<string>;
  organizationId: string;
  displayName: string;
  billingLine1: string | null;
  billingLine2: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
  status: Generated<"active" | "inactive" | "prospect">;
  source: string | null;
  tags: Generated<string[]>;
  notes: string | null;
  importId: ColumnType<string | null, string | null | undefined, never>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface SitesTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: Generated<string>;
  postalCode: string | null;
  county: string | null;
  lat: number | null;
  lng: number | null;
  locationSource: ColumnType<"manual" | "geocoder" | null, "manual" | "geocoder" | null | undefined, "manual" | "geocoder" | null>;
  geocodeStatus: ColumnType<"not_found" | null, "not_found" | null | undefined, "not_found" | null>;
  permitNumber: string | null;
  accessNotes: string | null;
  gateCode: string | null;
  safetyFlags: Generated<string[]>;
  schedulingNotes: string | null;
  jurisdictionId: ColumnType<string | null, string | null | undefined, string | null>;
  authorityAssignmentId: ColumnType<string | null, string | null | undefined, string | null>;
  importId: ColumnType<string | null, string | null | undefined, never>;
  active: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface ContactsTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  siteId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  type: Generated<"primary" | "billing" | "site" | "other">;
  consentEmail: Generated<boolean>;
  consentSms: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface WastewaterSystemsTable {
  id: Generated<string>;
  organizationId: string;
  siteId: string;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  installedAt: string | null;
  systemType: string | null;
  treatmentType: string | null;
  disposalType: string | null;
  chlorinationMethod: string | null;
  notes: string | null;
  active: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface AuditEventsTable {
  id: Generated<string>;
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  changes: ColumnType<unknown, string | undefined, never>;
  requestId: string | null;
  occurredAt: CreatedAt;
}

export interface PlansTable {
  id: Generated<string>;
  organizationId: string;
  name: string;
  customerType: Generated<"residential" | "commercial">;
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: Generated<"annual" | "semiannual" | "quarterly" | "monthly">;
  serviceType: Generated<"aerobic_inspection">;
  active: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface ContractsTable {
  id: Generated<string>;
  organizationId: string;
  siteId: string;
  planId: string | null;
  planName: string;
  startOn: string;
  endOn: string;
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: "annual" | "semiannual" | "quarterly" | "monthly";
  serviceType: "aerobic_inspection";
  autoRenew: Generated<boolean>;
  status: Generated<"active" | "cancelled">;
  renewalStatus: Generated<string>;
  previousContractId: string | null;
  signedDocumentId: ColumnType<string | null, string | null | undefined, string | null>;
  cancelledAt: Timestamp | null;
  cancelReason: string | null;
  filingBasis: ColumnType<"initial_policy" | "after_initial_policy" | "renewal" | "replacement" | null, string | null | undefined, string | null>;
  filingBasisOn: ColumnType<string | null, string | null | undefined, string | null>;
  filingBasisNote: ColumnType<string | null, string | null | undefined, string | null>;
  filingBasisSetBy: ColumnType<string | null, string | null | undefined, string | null>;
  filingBasisSetAt: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  serviceEndsOn: ColumnType<string | null, string | null | undefined, string | null>;
  discontinuedBy: ColumnType<"provider" | "owner" | null, string | null | undefined, string | null>;
  providerCredentialId: ColumnType<string | null, string | null | undefined, string | null>;
  noticeSentOn: ColumnType<string | null, string | null | undefined, string | null>;
  noticeNote: ColumnType<string | null, string | null | undefined, string | null>;
  noticeRecordedBy: ColumnType<string | null, string | null | undefined, string | null>;
  notes: string | null;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface ServiceObligationsTable {
  id: Generated<string>;
  organizationId: string;
  contractId: string;
  siteId: string;
  serviceType: "aerobic_inspection";
  sequence: number;
  windowStart: string;
  windowEnd: string;
  dueOn: string;
  status: Generated<"open" | "completed" | "cancelled">;
  completedAt: Timestamp | null;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface JobsTable {
  id: Generated<string>;
  organizationId: string;
  siteId: string;
  obligationId: string | null;
  type: Generated<"inspection">;
  status: Generated<"scheduled" | "in_progress" | "completed" | "cancelled">;
  stateMachineVersion: Generated<number>;
  scheduledDate: string;
  technicianUserId: string;
  routePosition: Generated<number>;
  notes: string | null;
  cancelledAt: Timestamp | null;
  cancelReason: string | null;
  onTheWayAt: ColumnType<Date | null, Date | null | undefined, Date | null>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface InspectionTemplatesTable {
  id: Generated<string>;
  organizationId: string | null;
  key: string;
  version: number;
  name: string;
  definition: ColumnType<unknown, string, never>;
  createdBy: string | null;
  createdAt: CreatedAt;
}

export interface InspectionsTable {
  id: Generated<string>;
  organizationId: string;
  offlineClientId: string;
  jobId: string;
  siteId: string;
  templateId: string;
  technicianUserId: string;
  status: Generated<"draft" | "completed">;
  validationStatus: Generated<"pending" | "valid" | "invalid" | "overridden">;
  validationProblems: ColumnType<unknown, string | undefined, string>;
  overrideReason: string | null;
  overrideBy: string | null;
  arrivedAt: Timestamp;
  completedAt: Timestamp | null;
  arrivalLat: number | null;
  arrivalLng: number | null;
  arrivalAccuracyM: number | null;
  completionLat: number | null;
  completionLng: number | null;
  completionAccuracyM: number | null;
  accessIssue: string | null;
  lockedAt: Timestamp | null;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface InspectionValuesTable {
  organizationId: string;
  inspectionId: string;
  fieldKey: string;
  valueJson: ColumnType<unknown, string, string>;
  updatedAt: Generated<Date>;
}

export interface AttachmentsTable {
  id: Generated<string>;
  organizationId: string;
  offlineClientId: string;
  inspectionId: string;
  photoKey: string;
  storageKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  capturedAt: Timestamp | null;
  lat: number | null;
  lng: number | null;
  uploadedBy: string;
  createdAt: CreatedAt;
}

export interface IssuesTable {
  id: Generated<string>;
  organizationId: string;
  clientId: string;
  inspectionId: string;
  siteId: string;
  type: string;
  severity: Generated<string>;
  description: Generated<string>;
  status: Generated<"open" | "resolved">;
  resolvedAt: ColumnType<Date | null, Date | null | undefined, Date | null>;
  resolvedBy: ColumnType<string | null, string | null | undefined, string | null>;
  resolution: ColumnType<string | null, string | null | undefined, string | null>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface BackgroundTasksTable {
  id: Generated<string>;
  organizationId: string | null;
  kind: string;
  payload: ColumnType<unknown, string | undefined, string>;
  dedupeKey: string | null;
  runAt: Timestamp;
  attempts: Generated<number>;
  maxAttempts: Generated<number>;
  lockedAt: Timestamp | null;
  lockedBy: string | null;
  lastError: string | null;
  completedAt: Timestamp | null;
  failedAt: Timestamp | null;
  createdAt: CreatedAt;
}

export interface ReportsTable {
  id: Generated<string>;
  organizationId: string;
  inspectionId: string;
  siteId: string;
  audience: "customer" | "authority";
  version: Generated<number>;
  templateId: string;
  snapshot: ColumnType<unknown, string, never>;
  storageKey: string;
  contentType: Generated<string>;
  byteSize: number;
  sha256: string;
  generatedAt: CreatedAt;
  supersedesReportId: ColumnType<string | null, string | null | undefined, never>;
  correctionReason: ColumnType<string | null, string | null | undefined, never>;
  correctedBy: ColumnType<string | null, string | null | undefined, never>;
}

export interface ComplianceEventsTable {
  id: Generated<string>;
  organizationId: string;
  siteId: string;
  eventType: string;
  occurredAt: Timestamp;
  actorUserId: string | null;
  inspectionId: string | null;
  reportId: string | null;
  filingId: ColumnType<string | null, string | null | undefined, never>;
  invoiceId: ColumnType<string | null, string | null | undefined, never>;
  renewalId: ColumnType<string | null, string | null | undefined, never>;
  summary: string;
  details: ColumnType<unknown, string | undefined, never>;
}

export interface JurisdictionsTable {
  id: Generated<string>;
  key: string;
  state: string;
  authorityName: string;
  type: string;
  active: Generated<boolean>;
  createdAt: CreatedAt;
}

export interface JurisdictionRulesetsTable {
  id: Generated<string>;
  jurisdictionId: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  rules: ColumnType<unknown, string, never>;
  sha256: string;
  sourceReference: string;
  status: Generated<"published" | "retired">;
  createdAt: CreatedAt;
}

export type FilingKind = "inspection_report" | "contract";

export interface FilingsTable {
  id: Generated<string>;
  organizationId: string;
  kind: ColumnType<FilingKind, FilingKind | undefined, never>;
  inspectionId: string | null;
  contractId: ColumnType<string | null, string | null | undefined, never>;
  signedDocumentId: ColumnType<string | null, string | null | undefined, string | null>;
  contractDocumentId: ColumnType<string | null, string | null | undefined, string | null>;
  deadlineBasis: ColumnType<string | null, string | null | undefined, string | null>;
  confirmationEvidence: ColumnType<unknown, string | null | undefined, string | null>;
  sendRequestedBy: ColumnType<string | null, string | null | undefined, string | null>;
  sendRequestedSubmission: ColumnType<number | null, number | null | undefined, number | null>;
  siteId: string;
  jurisdictionId: string | null;
  rulesetId: string | null;
  rulesetVersion: number | null;
  templateId: string | null;
  status: FilingStatus;
  stateMachineVersion: number;
  submissionMethod: SubmissionMethod | null;
  methodVersion: string | null;
  submissionNo: Generated<number>;
  reportId: string | null;
  deadlineOn: string | null;
  warningDays: Generated<number>;
  nextDueOn: string | null;
  sentAt: Timestamp | null;
  confirmedAt: Timestamp | null;
  confirmationReference: string | null;
  confirmationNote: string | null;
  confirmedBy: string | null;
  proof: ColumnType<unknown, string | null | undefined, string | null>;
  rejectionReason: string | null;
  reviewReason: string | null;
  lastError: string | null;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface FilingAttemptsTable {
  id: Generated<string>;
  organizationId: string;
  filingId: string;
  attemptNo: number;
  submissionNo: number;
  method: SubmissionMethod;
  idempotencyKey: string;
  status: "started" | "succeeded" | "failed";
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  response: ColumnType<unknown, string | undefined, string>;
  error: string | null;
  packageId: ColumnType<string | null, string | null | undefined, string | null>;
  recipient: ColumnType<string | null, string | null | undefined, string | null>;
}

export interface SubmissionPackagesTable {
  id: Generated<string>;
  organizationId: string;
  filingId: string;
  submissionNo: number;
  jurisdictionId: string;
  rulesetId: string;
  method: SubmissionMethod;
  recipient: string | null;
  subject: string;
  body: string;
  fields: ColumnType<unknown, string, never>;
  documents: ColumnType<unknown, string, never>;
  manifestSha256: string;
  createdAt: ColumnType<Date, Date, never>;
}


export interface ProviderCredentialsTable {
  id: Generated<string>;
  organizationId: string;
  userId: string | null;
  holderName: string;
  kind: CredentialKind;
  number: string;
  expiresOn: string | null;
  verifiedOn: string | null;
  verificationSource: string | null;
  active: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export type AuthorityEvidenceKind = "authority_map" | "authority_determination" | "permit_record" | "other";

export interface SiteAuthorityAssignmentsTable {
  id: Generated<string>;
  organizationId: string;
  siteId: string;
  jurisdictionId: string | null;
  evidenceKind: AuthorityEvidenceKind | null;
  evidenceReference: string | null;
  evidenceNote: string | null;
  assignedBy: string | null;
  assignedAt: Timestamp;
}

export interface SiteAuthorityIdentifiersTable {
  id: Generated<string>;
  organizationId: string;
  siteId: string;
  jurisdictionId: string;
  kind: string;
  value: string;
  sourceNote: string | null;
  updatedBy: string | null;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface ReportSignaturesTable {
  id: Generated<string>;
  organizationId: string;
  reportId: string;
  signedBy: string;
  credentialId: string;
  typedName: string;
  statement: string;
  signedAt: ColumnType<Date, Date | string, never>;
  reportSha256: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  onBehalfOfCredentialId: ColumnType<string | null, string | null | undefined, never>;
  delegationNote: ColumnType<string | null, string | null | undefined, never>;
}

export interface ContractDocumentsTable {
  id: Generated<string>;
  organizationId: string;
  contractId: string;
  filename: string;
  storageKey: string;
  contentType: Generated<string>;
  byteSize: number;
  sha256: string;
  signedOn: string | null;
  uploadedBy: string | null;
  createdAt: CreatedAt;
}

export interface CustomerDeliveriesTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  siteId: string | null;
  documentKind: "inspection_report" | "signed_agreement";
  reportId: string | null;
  signedDocumentId: string | null;
  channel: "email";
  recipient: string;
  documentSha256: string;
  idempotencyKey: string;
  status: "accepted" | "failed";
  attemptedAt: Timestamp;
  transportResponse: ColumnType<unknown, string | undefined, never>;
  error: string | null;
  requestedBy: string | null;
}

export interface ImportsTable {
  id: Generated<string>;
  organizationId: string;
  filename: string;
  status: Generated<"preview" | "committed" | "failed" | "discarded">;
  headers: ColumnType<unknown, string, string>;
  mapping: ColumnType<unknown, string, string>;
  createdBy: string;
  createdAt: CreatedAt;
  committedAt: Timestamp | null;
  error: string | null;
  result: ColumnType<unknown, string | null | undefined, string | null>;
  sheets: ColumnType<unknown, string, never>;
  sheetIndex: Generated<number>;
  mappingSource: Generated<"detected" | "saved" | "edited">;
}

export interface ImportRowsTable {
  organizationId: string;
  importId: string;
  sheetIndex: Generated<number>;
  rowNo: number;
  raw: ColumnType<unknown, string, never>;
  include: boolean | null;
  customerId: string | null;
  siteId: string | null;
  contractId: string | null;
}

export interface ImportMappingsTable {
  id: Generated<string>;
  organizationId: string;
  headerKey: string;
  columns: ColumnType<unknown, string, string>;
  importId: string;
  updatedBy: string;
  updatedAt: Generated<Timestamp>;
}

export interface InvoicesTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  siteId: string | null;
  number: number | null;
  status: Generated<InvoiceStatus>;
  paymentStatus: Generated<InvoicePaymentStatus>;
  memo: string | null;
  termsDays: number;
  taxRateBps: number;
  discountCents: number;
  subtotalCents: number;
  taxableCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: Generated<number>;
  pendingCents: Generated<number>;
  refundedCents: Generated<number>;
  issuedOn: string | null;
  dueOn: string | null;
  publicToken: string | null;
  snapshot: ColumnType<unknown, string | null | undefined, string | null>;
  pdfStorageKey: string | null;
  pdfSha256: string | null;
  pdfByteSize: number | null;
  sentAt: Timestamp | null;
  sendCount: Generated<number>;
  paidAt: Timestamp | null;
  voidedAt: Timestamp | null;
  voidReason: string | null;
  createdBy: string | null;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface InvoiceLinesTable {
  id: Generated<string>;
  organizationId: string;
  invoiceId: string;
  position: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
  taxable: boolean;
  contractId: string | null;
  installment: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  jobId: string | null;
}

export interface PaymentsTable {
  id: Generated<string>;
  organizationId: string;
  invoiceId: string;
  amountCents: number;
  method: PaymentMethod;
  source: "stripe" | "manual";
  status: PaymentRecordStatus;
  refundedCents: Generated<number>;
  providerPaymentId: string | null;
  providerSessionId: string | null;
  receivedOn: string | null;
  reference: string | null;
  note: string | null;
  failureReason: string | null;
  recordedBy: string | null;
  succeededAt: Timestamp | null;
  failedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface RefundsTable {
  id: Generated<string>;
  organizationId: string;
  paymentId: string;
  amountCents: number;
  status: RefundStatus;
  providerRefundId: string | null;
  reason: string | null;
  failureReason: string | null;
  createdBy: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CheckoutSessionsTable {
  id: Generated<string>;
  organizationId: string;
  invoiceId: string;
  providerSessionId: string;
  amountCents: number;
  url: string;
  expiresAt: Timestamp;
  status: Generated<"open" | "complete" | "expired">;
  createdAt: Timestamp;
}

export interface StripeEventsTable {
  id: string;
  type: string;
  account: string | null;
  livemode: boolean;
  organizationId: string | null;
  payload: ColumnType<unknown, string, never>;
  outcome: string;
  receivedAt: Timestamp;
}

export interface InvoiceEventsTable {
  id: Generated<string>;
  seq: Generated<string>;
  organizationId: string;
  invoiceId: string;
  eventType: string;
  summary: string;
  actorUserId: string | null;
  paymentId: string | null;
  details: ColumnType<unknown, string | undefined, never>;
  occurredAt: Timestamp;
}

export interface QuickbooksConnectionsTable {
  organizationId: string;
  environment: "test" | "sandbox" | "production";
  realmId: string;
  companyName: string | null;
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessExpiresAt: Timestamp | null;
  refreshExpiresAt: Timestamp | null;
  status: Generated<"connected" | "needs_reauth" | "disconnected">;
  setupState: Generated<"review" | "active">;
  syncFrom: string;
  defaultItemId: string | null;
  defaultItemName: string | null;
  reviewFetchedAt: Timestamp | null;
  reviewRemoteCount: number | null;
  changesSince: Timestamp | null;
  syncLockUntil: Timestamp | null;
  lastSyncStartedAt: Timestamp | null;
  lastSyncFinishedAt: Timestamp | null;
  lastSyncError: string | null;
  connectedBy: string | null;
  connectedAt: Timestamp;
  disconnectedAt: Timestamp | null;
  updatedAt: Timestamp;
}

export interface QuickbooksLinksTable {
  id: Generated<string>;
  organizationId: string;
  entityType: QuickBooksEntityType;
  entityId: string;
  externalId: string | null;
  syncToken: string | null;
  status: QuickBooksSyncStatus;
  conflictKind: QuickBooksConflictKind | null;
  conflict: ColumnType<unknown, string | null | undefined, string | null>;
  decision: "match" | "create" | "skip" | null;
  force: Generated<boolean>;
  syncError: string | null;
  retryCount: Generated<number>;
  nextAttemptAt: Timestamp | null;
  lastSyncedAt: Timestamp | null;
  lastSourceModifiedAt: Timestamp | null;
  pushedHash: string | null;
  remoteUpdatedAt: string | null;
  remoteState: string | null;
  generation: Generated<number>;
  mappingVersion: Generated<number>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface QuickbooksTestCompaniesTable {
  realmId: string;
  data: ColumnType<unknown, string, string>;
  updatedAt: Timestamp;
}

export type RenewalStatus = "upcoming" | "sent" | "viewed" | "signed" | "payment_pending" | "paid" | "activated" | "declined" | "expired" | "needs_review";

export interface RenewalAddonsTable {
  id: Generated<string>;
  organizationId: string;
  name: string;
  description: string | null;
  priceCents: number;
  taxable: Generated<boolean>;
  active: Generated<boolean>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface RenewalsTable {
  id: Generated<string>;
  organizationId: string;
  contractId: string;
  siteId: string;
  customerId: string;
  status: Generated<RenewalStatus>;
  publicToken: string;
  version: Generated<number>;
  planId: string | null;
  planName: string;
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: "annual" | "semiannual" | "quarterly" | "monthly";
  serviceType: "aerobic_inspection";
  autoRenew: Generated<boolean>;
  startOn: string;
  endOn: string;
  selectedAddons: ColumnType<unknown, string | undefined, string>;
  customerUpdates: ColumnType<unknown, string | undefined, string>;
  sentAt: Timestamp | null;
  sendCount: Generated<number>;
  lastReminderDays: number | null;
  viewedAt: Timestamp | null;
  signedAt: Timestamp | null;
  paidAt: Timestamp | null;
  activatedAt: Timestamp | null;
  declinedAt: Timestamp | null;
  declineReason: string | null;
  expiredAt: Timestamp | null;
  reviewReason: string | null;
  signedDocumentId: string | null;
  invoiceId: string | null;
  newContractId: string | null;
  createdBy: string | null;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface SignedDocumentsTable {
  id: Generated<string>;
  organizationId: string;
  kind: "renewal_agreement";
  renewalId: string | null;
  siteId: string;
  customerId: string;
  title: string;
  content: ColumnType<unknown, string, never>;
  contentSha256: string;
  signerName: string;
  signatureKind: "typed" | "drawn";
  signatureImage: string | null;
  consentText: string;
  signedAt: Timestamp;
  ipAddress: string | null;
  userAgent: string | null;
  pdfStorageKey: string | null;
  pdfSha256: string | null;
  pdfByteSize: number | null;
  createdAt: CreatedAt;
}

export interface PortalLinksTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  tokenHash: Buffer;
  source: "office" | "email" | "sms";
  sentTo: string | null;
  createdBy: string | null;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
  lastUsedAt: Timestamp | null;
  createdAt: CreatedAt;
}

export type ServiceRequestKind = "alarm" | "odor" | "repair" | "pumping" | "question" | "other";

export interface ServiceRequestsTable {
  id: Generated<string>;
  organizationId: string;
  customerId: string;
  siteId: string;
  kind: ServiceRequestKind;
  description: string;
  contactPhone: string | null;
  status: Generated<"open" | "closed">;
  resolution: string | null;
  closedAt: Timestamp | null;
  closedBy: string | null;
  portalLinkId: string | null;
  source: Generated<"portal" | "office">;
  receivedAt: ColumnType<Date, Date | string, Date | string>;
  reportClassification: ColumnType<ReportClassification | null, ReportClassification | null | undefined, ReportClassification | null>;
  classificationNote: ColumnType<string | null, string | null | undefined, string | null>;
  classifiedBy: ColumnType<string | null, string | null | undefined, string | null>;
  classifiedAt: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  responseAction: ColumnType<string | null, string | null | undefined, string | null>;
  respondedAt: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  responseJobId: ColumnType<string | null, string | null | undefined, string | null>;
  responseRecordedBy: ColumnType<string | null, string | null | undefined, string | null>;
  responseOutcome: ColumnType<"resolved" | "outstanding" | null, "resolved" | "outstanding" | null | undefined, "resolved" | "outstanding" | null>;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}


export interface SmsMessagesTable {
  id: Generated<string>;
  organizationId: string;
  direction: "outbound" | "inbound";
  kind: SmsKind | null;
  customerId: string | null;
  contactId: string | null;
  phone: string | null;
  body: string;
  status: SmsStatus;
  skipReason: SmsSkipReason | null;
  attempts: Generated<number>;
  errorCode: string | null;
  errorMessage: string | null;
  provider: string | null;
  providerMessageId: string | null;
  relatedType: string | null;
  relatedId: string | null;
  dedupeKey: string | null;
  sentAt: Timestamp | null;
  deliveredAt: Timestamp | null;
  handledAt: Timestamp | null;
  handledBy: string | null;
  createdAt: CreatedAt;
  updatedAt: Timestamp;
}

export interface SmsOptOutsTable {
  organizationId: string;
  phone: string;
  source: "reply" | "carrier";
  optedOutAt: Generated<Date>;
}

export interface PlatformAdminsTable {
  id: Generated<string>;
  name: string;
  email: string;
  passwordHash: string;
  active: Generated<boolean>;
  createdAt: CreatedAt;
}

export interface PlatformAdminSessionsTable {
  id: Generated<string>;
  tokenHash: Buffer;
  adminId: string;
  createdAt: CreatedAt;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
}

export interface PlatformAuditEventsTable {
  id: Generated<string>;
  adminId: string | null;
  organizationId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes: ColumnType<unknown, string | undefined, never>;
  requestId: string | null;
  occurredAt: CreatedAt;
}

export interface DB {
  organizations: OrganizationsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  sessions: SessionsTable;
  customers: CustomersTable;
  sites: SitesTable;
  contacts: ContactsTable;
  wastewaterSystems: WastewaterSystemsTable;
  auditEvents: AuditEventsTable;
  plans: PlansTable;
  contracts: ContractsTable;
  serviceObligations: ServiceObligationsTable;
  jobs: JobsTable;
  inspectionTemplates: InspectionTemplatesTable;
  inspections: InspectionsTable;
  inspectionValues: InspectionValuesTable;
  attachments: AttachmentsTable;
  issues: IssuesTable;
  backgroundTasks: BackgroundTasksTable;
  reports: ReportsTable;
  complianceEvents: ComplianceEventsTable;
  jurisdictions: JurisdictionsTable;
  jurisdictionRulesets: JurisdictionRulesetsTable;
  filings: FilingsTable;
  filingAttempts: FilingAttemptsTable;
  imports: ImportsTable;
  importRows: ImportRowsTable;
  importMappings: ImportMappingsTable;
  invoices: InvoicesTable;
  invoiceLines: InvoiceLinesTable;
  payments: PaymentsTable;
  refunds: RefundsTable;
  checkoutSessions: CheckoutSessionsTable;
  stripeEvents: StripeEventsTable;
  invoiceEvents: InvoiceEventsTable;
  quickbooksConnections: QuickbooksConnectionsTable;
  quickbooksLinks: QuickbooksLinksTable;
  quickbooksTestCompanies: QuickbooksTestCompaniesTable;
  renewalAddons: RenewalAddonsTable;
  renewals: RenewalsTable;
  signedDocuments: SignedDocumentsTable;
  portalLinks: PortalLinksTable;
  serviceRequests: ServiceRequestsTable;
  smsMessages: SmsMessagesTable;
  smsOptOuts: SmsOptOutsTable;
  submissionPackages: SubmissionPackagesTable;
  providerCredentials: ProviderCredentialsTable;
  siteAuthorityAssignments: SiteAuthorityAssignmentsTable;
  siteAuthorityIdentifiers: SiteAuthorityIdentifiersTable;
  contractDocuments: ContractDocumentsTable;
  reportSignatures: ReportSignaturesTable;
  customerDeliveries: CustomerDeliveriesTable;
  platformAdmins: PlatformAdminsTable;
  platformAdminSessions: PlatformAdminSessionsTable;
  platformAuditEvents: PlatformAuditEventsTable;
}
