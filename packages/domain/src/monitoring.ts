import { z } from "zod";
import { CUSTOMER_TYPES } from "./contracts.ts";
import { id } from "./crm.ts";

// Electronic monitoring on a wastewater system (an autodialer or remote telemetry that
// notifies someone automatically when the system alarms). Some authorities allow a longer
// time between inspections for systems that have it.

export const MONITORING_METHODS = ["autodialer", "remote_telemetry", "other"] as const;
export const MONITORING_METHOD_LABELS: Record<(typeof MONITORING_METHODS)[number], string> = {
  autodialer: "Autodialer",
  remote_telemetry: "Remote telemetry",
  other: "Other",
};

/** The ruleset part: the longer interval allowed for monitored systems, and for which types. */
export const monitoredServiceRule = z.object({
  intervalMonths: z.number().int().min(1).max(24),
  appliesTo: z.array(z.enum(CUSTOMER_TYPES)).min(1),
  /** What the authority says qualifies, in its words, with the source. */
  note: z.string().max(1000).optional(),
});

const date = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);

export const monitoringInput = z.object({
  method: z.enum(MONITORING_METHODS),
  /** The device or service: make, model, monitoring company. */
  description: text(200),
  /** Who is notified automatically when it alarms, and how. */
  notifies: text(200),
  startedOn: date,
  /** When someone confirmed it works and notifies as described. */
  checkedOn: date,
});

export const monitoringEndInput = z.object({ endedOn: date, reason: text(500) });

export const systemMonitoring = z.object({
  id,
  systemId: id,
  method: z.enum(MONITORING_METHODS),
  description: z.string(),
  notifies: z.string(),
  startedOn: date,
  checkedOn: date,
  endedOn: date.nullable(),
  endReason: z.string().nullable(),
  recordedBy: z.string(),
  recordedAt: z.iso.datetime({ offset: true }),
});
export type SystemMonitoring = z.infer<typeof systemMonitoring>;
