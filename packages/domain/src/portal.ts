import { z } from "zod";
import { CONTRACT_STATES } from "./contracts.ts";
import { id } from "./crm.ts";
import { PAYMENT_STATUSES } from "./invoices.ts";
import { RENEWAL_STATUSES } from "./renewals.ts";

// The customer portal: what a homeowner sees from their magic link, and the service
// requests they send from it.

/** A portal link works for this long; the homeowner can always ask for a new one by email. */
export const PORTAL_LINK_DAYS = 90;

export const SERVICE_REQUEST_KINDS = ["alarm", "odor", "repair", "pumping", "question", "other"] as const;
export type ServiceRequestKind = (typeof SERVICE_REQUEST_KINDS)[number];
export const SERVICE_REQUEST_LABELS: Record<ServiceRequestKind, string> = {
  alarm: "Alarm is going off",
  odor: "Odor or wet area",
  repair: "Something needs repair",
  pumping: "Pumping",
  question: "A question",
  other: "Something else",
};

const date = z.iso.date();
const datetime = z.iso.datetime({ offset: true });

export const portalLinkRequest = z.object({ email: z.email().max(320) });
export const portalLinkInput = z.object({ send: z.boolean().default(false) });
/** A copied link comes back with its URL; an emailed one only says where it is going. */
export const portalLink = z.object({ url: z.string().nullable(), expiresAt: datetime.nullable(), sentTo: z.string().nullable() });

/** What the office sees about a customer's portal: who has a working link and when it was used. */
export const portalAccess = z.object({
  activeLinks: z.number().int(),
  lastUsedAt: datetime.nullable(),
  links: z.array(
    z.object({
      id,
      source: z.enum(["office", "email", "sms"]),
      sentTo: z.string().nullable(),
      createdAt: datetime,
      expiresAt: datetime,
      lastUsedAt: datetime.nullable(),
      revokedAt: datetime.nullable(),
      createdByName: z.string().nullable(),
    }),
  ),
  /** Whether the customer has an email the link can go to. */
  email: z.string().nullable(),
});
export type PortalAccess = z.infer<typeof portalAccess>;

export const serviceRequestInput = z.object({
  siteId: id,
  kind: z.enum(SERVICE_REQUEST_KINDS),
  description: z.string().trim().min(3).max(2000),
  contactPhone: z.string().trim().max(40).nullish(),
});
export type ServiceRequestInput = z.input<typeof serviceRequestInput>;

export const serviceRequestResolveInput = z.object({ resolution: z.string().trim().min(1).max(2000) });

export const serviceRequest = z.object({
  id,
  kind: z.enum(SERVICE_REQUEST_KINDS),
  description: z.string(),
  contactPhone: z.string().nullable(),
  status: z.enum(["open", "closed"]),
  resolution: z.string().nullable(),
  createdAt: datetime,
  closedAt: datetime.nullable(),
  site: z.object({ id, addressLine1: z.string(), city: z.string() }),
  customer: z.object({ id, displayName: z.string() }),
});
export type ServiceRequest = z.infer<typeof serviceRequest>;

const portalServiceRequest = serviceRequest.pick({ id: true, kind: true, description: true, status: true, resolution: true, createdAt: true, closedAt: true });

export const portalSite = z.object({
  id,
  address: z.string(),
  system: z
    .object({
      manufacturer: z.string().nullable(),
      model: z.string().nullable(),
      serial: z.string().nullable(),
      installedAt: date.nullable(),
      systemType: z.string().nullable(),
      treatmentType: z.string().nullable(),
      disposalType: z.string().nullable(),
      chlorinationMethod: z.string().nullable(),
    })
    .nullable(),
  contract: z
    .object({
      planName: z.string(),
      startOn: date,
      endOn: date,
      state: z.enum(CONTRACT_STATES),
      visitsPerTerm: z.number().int(),
      visitsDone: z.number().int(),
      /**
       * SW-9: with pumping or maintenance visits, each kind's own count this term (inspections
       * included, labelled). Empty for an inspection-only contract, which shows visitsDone of
       * visitsPerTerm as before.
       */
      visitProgress: z.array(z.object({ label: z.string(), done: z.number().int(), total: z.number().int() })).default([]),
    })
    .nullable(),
  /** A renewal the homeowner can act on, or the latest one. */
  renewal: z.object({ status: z.enum(RENEWAL_STATUSES), startOn: date, url: z.string().nullable() }).nullable(),
  /**
   * The next inspection; with none due, the next pumping or maintenance visit (SW-9), named by
   * `label` (null for an inspection).
   */
  nextVisit: z.object({ dueOn: date, windowStart: date, windowEnd: date, scheduledDate: date.nullable(), label: z.string().nullable().default(null) }).nullable(),
  /** SW-9: false for a site with only pumping or maintenance service, which has no inspection reports to show. */
  inspections: z.boolean().default(true),
  /** Customer copies of inspection reports, newest first. */
  reports: z.array(z.object({ id, inspectedOn: date, url: z.string() })),
  /** SW-7: finished work with its completion summary, newest first. */
  completedWork: z.array(z.object({ id, label: z.string(), title: z.string(), completedOn: date, url: z.string() })),
  serviceRequests: z.array(portalServiceRequest),
});
export type PortalSite = z.infer<typeof portalSite>;

export const portalInvoice = z.object({
  number: z.string(),
  issuedOn: date,
  dueOn: date,
  totalCents: z.number().int(),
  amountDueCents: z.number().int(),
  paymentStatus: z.enum(PAYMENT_STATUSES),
  overdue: z.boolean(),
  payUrl: z.string(),
});

export const portalView = z.object({
  provider: z.object({ name: z.string(), phone: z.string().nullable(), email: z.string().nullable() }),
  customerName: z.string(),
  expiresAt: datetime,
  sites: z.array(portalSite),
  invoices: z.array(portalInvoice),
  amountDueCents: z.number().int(),
  invoiceTotal: z.number().int().min(0),
  serviceRequestTotal: z.number().int().min(0),
});
export type PortalView = z.infer<typeof portalView>;
