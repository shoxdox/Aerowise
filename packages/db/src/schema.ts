import type { ColumnType, Generated } from "kysely";
import type { Role } from "@aerowise/domain";

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
}
