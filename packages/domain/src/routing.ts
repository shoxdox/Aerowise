import { z } from "zod";
import { id } from "./crm.ts";

const date = z.iso.date();

export const GEOCODER_MODES = ["test", "census", "off"] as const;
export const LOCATION_SOURCES = ["manual", "geocoder"] as const;

/** Where technicians leave from, typed as an address and found on the map. */
export const routeStartInput = z.object({
  addressLine1: z.string().trim().min(1).max(200),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().length(2).toUpperCase().default("TX"),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Expected a ZIP code").nullish(),
  /** Coordinates to use as they are, instead of looking the address up. */
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export const routingSettingsPatch = z.object({
  /** null removes the start: routes then begin at their first stop. */
  start: routeStartInput.nullable().optional(),
  returnToStart: z.boolean().optional(),
  /** Average minutes on site per stop. */
  stopMinutes: z.number().int().min(0).max(480).optional(),
  /** Length of a technician's working day, in minutes. */
  dayMinutes: z.number().int().min(60).max(1440).optional(),
  /** Average driving speed between stops. */
  speedMph: z.number().int().min(5).max(80).optional(),
});

const point = z.object({ lat: z.number(), lng: z.number() });

export const routeStart = point.extend({ address: z.string() });

export const routingSettings = z.object({
  /** How addresses are found on the map: the built-in test stand-in, the US Census geocoder, or not at all. */
  geocoder: z.enum(GEOCODER_MODES),
  start: routeStart.nullable(),
  returnToStart: z.boolean(),
  stopMinutes: z.number().int(),
  dayMinutes: z.number().int(),
  speedMph: z.number().int(),
  /** Active sites by whether they are on the map. */
  sites: z.object({ located: z.number().int(), pending: z.number().int(), notFound: z.number().int() }),
});

export const routeLeg = z.object({
  fromJobId: id.nullable(),
  toJobId: id.nullable(),
  miles: z.number(),
  minutes: z.number().int(),
});

export const travelSummary = z.object({
  driveMiles: z.number(),
  driveMinutes: z.number().int(),
});

export const technicianRoute = travelSummary.extend({
  technicianId: id,
  technicianName: z.string(),
  stops: z.array(z.object({ jobId: id, status: z.string(), lat: z.number().nullable(), lng: z.number().nullable() })),
  legs: z.array(routeLeg),
  /** Time on site: each work visit's minutes from its kind of work, the average stop length for the rest. */
  serviceMinutes: z.number().int(),
  /** Driving plus time on site. */
  totalMinutes: z.number().int(),
  /** The day is longer than a working day. */
  overCapacity: z.boolean(),
  unlocatedJobIds: z.array(id),
});

export const routeDay = z.object({
  date,
  start: routeStart.nullable(),
  returnToStart: z.boolean(),
  dayMinutes: z.number().int(),
  technicians: z.array(technicianRoute),
});

export const optimizeInput = z.object({
  technicianId: id,
  scheduledDate: date,
  /** false (the default) only shows the better order; true puts it in place. */
  apply: z.boolean().default(false),
});

export const optimizeResult = z.object({
  applied: z.boolean(),
  /** The proposed order differs from the current one. */
  changed: z.boolean(),
  currentJobIds: z.array(id),
  proposedJobIds: z.array(id),
  before: travelSummary,
  after: travelSummary,
  /** Stops with no location, left at the end of the route. */
  unlocatedJobIds: z.array(id),
});

export const nearbyQuery = z.object({ technicianId: id, date });

export const nearbyVisit = z.object({
  obligationId: id,
  /** Extra driving to fit the visit into the day at its best place. */
  detourMiles: z.number(),
  detourMinutes: z.number().int(),
  /** The day would still fit in a working day with it added. */
  fits: z.boolean(),
});

export const nearbyResult = z.object({
  /** Located unscheduled visits due within 30 days of the date, closest to the route first. */
  items: z.array(nearbyVisit),
  /** Unscheduled visits whose site is not on the map. */
  unlocated: z.number().int(),
});

export const geocodeInput = z.object({
  /** Also try again the addresses that could not be found before. */
  retryNotFound: z.boolean().default(false),
});

export type RoutingSettings = z.infer<typeof routingSettings>;
export type RoutingSettingsPatch = z.input<typeof routingSettingsPatch>;
export type RouteDay = z.infer<typeof routeDay>;
export type TechnicianRoute = z.infer<typeof technicianRoute>;
export type OptimizeResult = z.infer<typeof optimizeResult>;
export type NearbyResult = z.infer<typeof nearbyResult>;
