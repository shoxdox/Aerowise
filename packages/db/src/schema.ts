import type { ColumnType, Generated } from "kysely";
import type { FilingStatus, Role, SubmissionMethod } from "@aerowise/domain";

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
  permitNumber: string | null;
  accessNotes: string | null;
  gateCode: string | null;
  safetyFlags: Generated<string[]>;
  schedulingNotes: string | null;
  jurisdictionId: ColumnType<string | null, string | null | undefined, string | null>;
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
  cancelledAt: Timestamp | null;
  cancelReason: string | null;
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

export interface FilingsTable {
  id: Generated<string>;
  organizationId: string;
  inspectionId: string;
  siteId: string;
  jurisdictionId: string | null;
  rulesetId: string | null;
  rulesetVersion: number | null;
  templateId: string;
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
}
