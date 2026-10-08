import { z } from "zod";
import { id } from "./crm.ts";
import { WORK_CATEGORIES } from "./work.ts";

// A small catalog of what a company charges for: labor by the hour, pumping by the gallon,
// parts and fees. Work order lines and invoice lines can start from an item, and keep their
// own copy of its description and price. See the service workflows plan §3.2.

export const SERVICE_ITEM_UNITS = ["each", "hour", "gallon", "foot", "visit"] as const;
export type ServiceItemUnit = (typeof SERVICE_ITEM_UNITS)[number];
export const SERVICE_ITEM_UNIT_LABELS: Record<ServiceItemUnit, string> = { each: "each", hour: "per hour", gallon: "per gallon", foot: "per foot", visit: "per visit" };

export const serviceItem = z.object({
  id,
  name: z.string(),
  description: z.string().nullable(),
  unit: z.enum(SERVICE_ITEM_UNITS),
  unitPriceCents: z.number().int(),
  taxable: z.boolean(),
  category: z.enum(WORK_CATEGORIES).nullable(),
  active: z.boolean(),
});
export type ServiceItem = z.infer<typeof serviceItem>;

export const serviceItemFields = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable(),
  unit: z.enum(SERVICE_ITEM_UNITS),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
  taxable: z.boolean(),
  category: z.enum(WORK_CATEGORIES).nullable(),
  active: z.boolean(),
});
export const serviceItemInput = serviceItemFields.extend({
  description: serviceItemFields.shape.description.default(null),
  unit: serviceItemFields.shape.unit.default("each"),
  taxable: serviceItemFields.shape.taxable.default(false),
  category: serviceItemFields.shape.category.default(null),
  active: serviceItemFields.shape.active.default(true),
});
export const serviceItemPatch = serviceItemFields.partial();
export const serviceItemListQuery = z.object({ active: z.enum(["true", "false", "all"]).default("true") });

/** What a line costs, for a quantity in thousandths: half a cent rounds up, as the database does. */
export const milliAmount = (quantityMilli: number, unitPriceCents: number) => Math.round((quantityMilli * unitPriceCents) / 1000);
