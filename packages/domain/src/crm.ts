import { z } from "zod";

// Shared request/response shapes for customers, contacts, sites and wastewater systems.
// The API validates with these and publishes them through OpenAPI; the web app imports
// the inferred types.

const optionalText = (max: number) => z.string().trim().max(max).nullish();

export const CUSTOMER_STATUSES = ["active", "inactive", "prospect"] as const;
export const CONTACT_TYPES = ["primary", "billing", "site", "other"] as const;
export const SAFETY_FLAGS = ["dog", "locked_gate", "aggressive_animal", "hazard", "call_ahead"] as const;

export const id = z.uuid();

export const addressFields = {
  line1: optionalText(200),
  line2: optionalText(200),
  city: optionalText(100),
  state: z.string().trim().length(2).toUpperCase().nullish(),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Expected a ZIP code").nullish(),
};

// Each record has a field shape without defaults (used for PATCH, so omitted fields are
// left alone) and an input schema that adds defaults for creation.
const customerFields = z.object({
  displayName: z.string().trim().min(1).max(200),
  billingLine1: addressFields.line1,
  billingLine2: addressFields.line2,
  billingCity: addressFields.city,
  billingState: addressFields.state,
  billingPostalCode: addressFields.postalCode,
  status: z.enum(CUSTOMER_STATUSES),
  source: optionalText(100),
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
  notes: optionalText(5000),
});
export const customerInput = customerFields.extend({
  status: customerFields.shape.status.default("active"),
  tags: customerFields.shape.tags.default([]),
});
export const customerPatch = customerFields.partial();

export const customer = z.object({
  id,
  displayName: z.string(),
  billingLine1: z.string().nullable(),
  billingLine2: z.string().nullable(),
  billingCity: z.string().nullable(),
  billingState: z.string().nullable(),
  billingPostalCode: z.string().nullable(),
  status: z.enum(CUSTOMER_STATUSES),
  source: z.string().nullable(),
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const customerListItem = customer.extend({ siteCount: z.number().int() });

const contactFields = z.object({
  siteId: id.nullish(),
  name: z.string().trim().min(1).max(200),
  email: z.email().max(320).nullish(),
  phone: optionalText(40),
  type: z.enum(CONTACT_TYPES),
  consentEmail: z.boolean(),
  consentSms: z.boolean(),
});
export const contactInput = contactFields.extend({
  type: contactFields.shape.type.default("primary"),
  consentEmail: contactFields.shape.consentEmail.default(false),
  consentSms: contactFields.shape.consentSms.default(false),
});
export const contactPatch = contactFields.partial();

export const contact = z.object({
  id,
  customerId: id,
  siteId: id.nullable(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  type: z.enum(CONTACT_TYPES),
  consentEmail: z.boolean(),
  consentSms: z.boolean(),
});

/** Whether a system is residential or commercial: a property of the site, not the plan. */
export const CUSTOMER_TYPES = ["residential", "commercial"] as const;
/** What a site's system serves, where an authority's rules differ by it. */
export const SITE_USE_CATEGORIES = ["single_family", "multifamily", "commercial", "food_establishment"] as const;
export type SiteUseCategory = (typeof SITE_USE_CATEGORIES)[number];
export const SITE_USE_CATEGORY_LABELS: Record<SiteUseCategory, string> = {
  single_family: "Single-family home",
  multifamily: "Multifamily",
  commercial: "Commercial",
  food_establishment: "Food establishment",
};

const siteFields = z.object({
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: addressFields.line2,
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().length(2).toUpperCase(),
  postalCode: addressFields.postalCode,
  county: optionalText(100),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  permitNumber: optionalText(100),
  /**
   * The longest time between inspections set by the site's own permit, where its authority
   * lets the permit decide (Hays County). Needs a note saying where it was read.
   */
  permitIntervalMonths: z.number().int().min(1).max(24).nullish(),
  permitIntervalNote: optionalText(500),
  accessNotes: optionalText(2000),
  gateCode: optionalText(50),
  safetyFlags: z.array(z.enum(SAFETY_FLAGS)).max(SAFETY_FLAGS.length),
  schedulingNotes: optionalText(2000),
  /** Commercial systems may have a shorter service interval and lab tests (the site's authority decides). */
  customerType: z.enum(CUSTOMER_TYPES),
  /** Recorded by the office; null when nobody has said. Never inferred from the customer type. */
  useCategory: z.enum(SITE_USE_CATEGORIES).nullish(),
  active: z.boolean(),
});
export const siteInput = siteFields.extend({
  customerType: siteFields.shape.customerType.default("residential"),
  state: siteFields.shape.state.default("TX"),
  safetyFlags: siteFields.shape.safetyFlags.default([]),
  active: siteFields.shape.active.default(true),
});
export const sitePatch = siteFields.partial();

export const site = z.object({
  id,
  customerId: id,
  addressLine1: z.string(),
  addressLine2: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string().nullable(),
  county: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  /** Coordinates typed in by a person, or found from the address. */
  locationSource: z.enum(["manual", "geocoder"]).nullable(),
  /** `not_found`: the address could not be found on the map. */
  geocodeStatus: z.enum(["not_found"]).nullable(),
  permitNumber: z.string().nullable(),
  permitIntervalMonths: z.number().int().nullable(),
  permitIntervalNote: z.string().nullable(),
  accessNotes: z.string().nullable(),
  gateCode: z.string().nullable(),
  safetyFlags: z.array(z.enum(SAFETY_FLAGS)),
  schedulingNotes: z.string().nullable(),
  customerType: z.enum(CUSTOMER_TYPES),
  useCategory: z.enum(SITE_USE_CATEGORIES).nullable(),
  active: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export const siteListItem = site.extend({ customerName: z.string() });

/**
 * What kind of system it is (SW-7). Null until someone says; a backfill set `aerobic` only where
 * the site has an aerobic inspection contract, and `unknown` elsewhere. Nothing is guessed from
 * the free-text type columns, which are kept as they are.
 */
export const SYSTEM_CATEGORIES = ["aerobic", "conventional", "low_pressure_dosing", "drip", "holding_tank", "lift_station", "other", "unknown"] as const;
export type SystemCategory = (typeof SYSTEM_CATEGORIES)[number];
export const SYSTEM_CATEGORY_LABELS: Record<SystemCategory, string> = {
  aerobic: "Aerobic",
  conventional: "Conventional",
  low_pressure_dosing: "Low-pressure dosing",
  drip: "Drip",
  holding_tank: "Holding tank",
  lift_station: "Lift station",
  other: "Other",
  unknown: "Not known",
};

/**
 * The warning before an aerobic inspection contract starts on a site whose systems are all
 * recorded as something other than aerobic. A warning, not a refusal: the records may be wrong.
 * Systems with no category or `unknown` might be aerobic, so they never raise it.
 */
export function aerobicContractWarning(categories: readonly (SystemCategory | null)[]): string | null {
  if (categories.length === 0) return null;
  if (!categories.every((c) => c !== null && c !== "unknown" && c !== "aerobic")) return null;
  const kinds = [...new Set(categories.map((c) => SYSTEM_CATEGORY_LABELS[c!].toLowerCase()))].join(" and ");
  return `This site's system${categories.length === 1 ? " is" : "s are"} recorded as ${kinds}, not aerobic. An aerobic inspection contract is for an aerobic system. Start it anyway?`;
}

const systemFields = z.object({
  manufacturer: optionalText(100),
  model: optionalText(100),
  serial: optionalText(100),
  installedAt: z.iso.date().nullish(),
  systemType: optionalText(100),
  treatmentType: optionalText(100),
  disposalType: optionalText(100),
  chlorinationMethod: optionalText(100),
  systemCategory: z.enum(SYSTEM_CATEGORIES).nullish(),
  notes: optionalText(5000),
  active: z.boolean(),
});
export const systemInput = systemFields.extend({ active: systemFields.shape.active.default(true) });
export const systemPatch = systemFields.partial();

export const wastewaterSystem = z.object({
  id,
  siteId: id,
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  installedAt: z.iso.date().nullable(),
  systemType: z.string().nullable(),
  treatmentType: z.string().nullable(),
  disposalType: z.string().nullable(),
  chlorinationMethod: z.string().nullable(),
  systemCategory: z.enum(SYSTEM_CATEGORIES).nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
});

export const customerDetail = customer.extend({
  contacts: z.array(contact),
  sites: z.array(site),
});

export const siteDetail = site.extend({
  customer: customer.pick({ id: true, displayName: true }),
  contacts: z.array(contact),
  systems: z.array(wastewaterSystem),
});

export type CustomerInput = z.input<typeof customerInput>;
export type Customer = z.infer<typeof customer>;
export type CustomerListItem = z.infer<typeof customerListItem>;
export type CustomerDetail = z.infer<typeof customerDetail>;
export type ContactInput = z.input<typeof contactInput>;
export type Contact = z.infer<typeof contact>;
export type SiteInput = z.input<typeof siteInput>;
export type Site = z.infer<typeof site>;
export type SiteListItem = z.infer<typeof siteListItem>;
export type SiteDetail = z.infer<typeof siteDetail>;
export type SystemInput = z.input<typeof systemInput>;
export type WastewaterSystem = z.infer<typeof wastewaterSystem>;
