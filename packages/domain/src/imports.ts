import { z } from "zod";
import { id } from "./crm.ts";
import { addDays, addMonths } from "./schedule.ts";

// Importing customers and sites from a provider's spreadsheet: which column is which,
// how values are cleaned, and what the preview shows before anything is saved.

export const IMPORT_FIELDS = [
  "customerName",
  "firstName",
  "lastName",
  "phone",
  "email",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "county",
  "permitNumber",
  "gateCode",
  "accessNotes",
  "manufacturer",
  "model",
  "serial",
  "planName",
  "contractStart",
  "contractEnd",
  "lastInspection",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  customerName: "Customer name",
  firstName: "First name",
  lastName: "Last name",
  phone: "Phone",
  email: "Email",
  addressLine1: "Service address",
  addressLine2: "Address line 2",
  city: "City",
  state: "State",
  postalCode: "ZIP",
  county: "County",
  permitNumber: "Permit number",
  gateCode: "Gate code",
  accessNotes: "Access notes",
  manufacturer: "Unit make",
  model: "Unit model",
  serial: "Unit serial",
  planName: "Plan",
  contractStart: "Contract start",
  contractEnd: "Contract end",
  lastInspection: "Last inspection",
};

/** Header words that identify each field, after lowercasing and dropping punctuation. */
const SYNONYMS: Record<ImportField, string[]> = {
  customerName: ["customer", "customer name", "name", "full name", "client", "client name", "owner", "owner name", "account", "account name", "homeowner"],
  firstName: ["first", "first name", "firstname", "given name"],
  lastName: ["last", "last name", "lastname", "surname", "family name"],
  phone: ["phone", "phone number", "phone no", "telephone", "tel", "cell", "cell phone", "mobile", "mobile phone", "primary phone", "home phone"],
  email: ["email", "e mail", "email address", "mail"],
  addressLine1: ["address", "service address", "site address", "street", "street address", "address 1", "address line 1", "property address", "location", "physical address"],
  addressLine2: ["address 2", "address line 2", "unit", "apt", "suite"],
  city: ["city", "town", "service city", "site city"],
  state: ["state", "st", "province"],
  postalCode: ["zip", "zip code", "zipcode", "postal", "postal code", "postcode"],
  county: ["county", "parish"],
  permitNumber: ["permit", "permit number", "permit no", "permit num", "permit id", "ossf permit", "license", "license number"],
  gateCode: ["gate", "gate code", "access code", "lock code"],
  accessNotes: ["notes", "access notes", "directions", "site notes", "comments"],
  manufacturer: ["manufacturer", "make", "brand", "unit make", "system make", "unit brand"],
  model: ["model", "unit model", "system model"],
  serial: ["serial", "serial number", "serial no", "sn", "s n", "unit serial"],
  planName: ["plan", "service plan", "contract type", "plan name"],
  contractStart: ["contract start", "start date", "start", "contract date", "effective date", "contract start date"],
  contractEnd: ["contract end", "end date", "end", "contract end date", "expiration", "expiration date", "expires", "expiry", "contract expiration", "contract expires", "renewal date"],
  lastInspection: ["last inspection", "last inspection date", "last inspected", "last service", "last service date", "last visit", "last visit date", "inspection date"],
};

const normHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/#/g, " no ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

export type ColumnMapping = Partial<Record<ImportField, number>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What a column's values look like, for columns whose header says nothing useful. */
function sniff(values: string[]): ImportField | null {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (filled.length < 3) return null;
  const share = (re: RegExp) => filled.filter((v) => re.test(v)).length / filled.length;
  if (share(EMAIL_RE) >= 0.6) return "email";
  if (share(/^\+?1?[\s.-]*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}$/) >= 0.6) return "phone";
  if (share(/^\d{5}(-\d{4})?$/) >= 0.8) return "postalCode";
  return null;
}

/**
 * Picks a column for each field: an exact header match first, then a header that
 * contains a synonym, then what the values look like. Each column is used once.
 */
export function detectColumns(headers: string[], sample: string[][]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  const normalized = headers.map(normHeader);
  const assign = (field: ImportField, col: number) => {
    if (mapping[field] !== undefined || used.has(col)) return;
    mapping[field] = col;
    used.add(col);
  };
  for (const field of IMPORT_FIELDS) {
    const col = normalized.findIndex((h, i) => !used.has(i) && SYNONYMS[field].includes(h));
    if (col >= 0) assign(field, col);
  }
  for (const field of IMPORT_FIELDS) {
    if (mapping[field] !== undefined) continue;
    // Longer synonyms first, so "service address" wins over "address".
    const words = [...SYNONYMS[field]].filter((w) => w.length > 3).sort((a, b) => b.length - a.length);
    const col = normalized.findIndex((h, i) => !used.has(i) && words.some((w) => ` ${h} `.includes(` ${w} `)));
    if (col >= 0) assign(field, col);
  }
  headers.forEach((_, col) => {
    if (used.has(col)) return;
    const field = sniff(sample.map((row) => row[col] ?? ""));
    if (field) assign(field, col);
  });
  // A full name column makes separate first/last columns unnecessary, and vice versa.
  if (mapping.customerName !== undefined) {
    delete mapping.firstName;
    delete mapping.lastName;
  }
  return mapping;
}

// Saved column choices. When an import is saved, the organization's choice of column for
// each field is kept by header name, and offered on the next file.

/** One saved choice: this field came from the column with this header. */
export type SavedColumn = { field: ImportField; header: string };

/** Identifies a file layout: the same headers in the same order, however they are typed. */
export const headerKey = (headers: string[]) => headers.map(normHeader).join("|");

/** The column choices of a mapping, by header name, for saving. */
export function savedColumns(headers: string[], mapping: ColumnMapping): SavedColumn[] {
  return IMPORT_FIELDS.filter((f) => mapping[f] !== undefined && headers[mapping[f]!] !== undefined).map((field) => ({ field, header: headers[mapping[field]!]! }));
}

/**
 * Applies saved choices to a new file's headers. For a file with the same layout the saved
 * choices replace detection entirely, including fields left out on purpose. For another
 * layout, each saved choice whose header is in the file wins over detection, and detection
 * fills in the rest.
 */
export function applySavedColumns(headers: string[], detected: ColumnMapping, saved: SavedColumn[], sameLayout: boolean): ColumnMapping {
  const normalized = headers.map(normHeader);
  const mapping: ColumnMapping = sameLayout ? {} : { ...detected };
  const applied = new Set<ImportField>();
  for (const { field, header } of saved) {
    if (!IMPORT_FIELDS.includes(field)) continue;
    const col = normalized.indexOf(normHeader(header));
    if (col < 0) continue;
    for (const f of IMPORT_FIELDS) if (mapping[f] === col) delete mapping[f];
    mapping[field] = col;
    applied.add(field);
  }
  // A full name column and separate first/last columns do not mix.
  const splitName = applied.has("firstName") || applied.has("lastName");
  if (applied.has("customerName") && !splitName) {
    delete mapping.firstName;
    delete mapping.lastName;
  } else if (splitName && !applied.has("customerName")) delete mapping.customerName;
  return mapping;
}

/** How well a mapping covers the fields every row needs, to pick a workbook's likely sheet. */
export function mappingScore(mapping: ColumnMapping): number {
  const name = mapping.customerName !== undefined || mapping.firstName !== undefined || mapping.lastName !== undefined;
  return (name ? 1 : 0) + (mapping.addressLine1 !== undefined ? 1 : 0) + (mapping.city !== undefined ? 1 : 0);
}

/** Ten US digits formatted as (512) 555-0100, or null when it is not a US number. */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

export const normalizeText = (raw: string | undefined) => {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
};

/** A key that matches the same street address however it was typed. */
export function addressKey(line1: string, city: string): string {
  const abbreviations: Record<string, string> = { road: "rd", street: "st", drive: "dr", lane: "ln", trail: "trl", avenue: "ave", court: "ct", circle: "cir", highway: "hwy", boulevard: "blvd", county: "co", ranch: "rr", north: "n", south: "s", east: "e", west: "w" };
  const words = `${line1} ${city}`
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => abbreviations[w] ?? w);
  return words.join(" ");
}

/** Accepts 2026-03-01, 3/1/2026, 3/1/26 and Excel dates already turned into ISO. */
export function normalizeDate(raw: string): string | null {
  const t = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t))) {
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += 2000;
  } else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

// API shapes.

export const IMPORT_STATUSES = ["preview", "committed", "failed", "discarded", "undone"] as const;
export const IMPORT_ROW_STATUSES = ["ready", "warning", "duplicate", "error"] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

/** The cleaned values of a row, as they will be saved. */
export const importRecord = z.object({
  customerName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string(),
  postalCode: z.string().nullable(),
  county: z.string().nullable(),
  permitNumber: z.string().nullable(),
  gateCode: z.string().nullable(),
  accessNotes: z.string().nullable(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  serial: z.string().nullable(),
  planName: z.string().nullable(),
  /** The contract's first and last day. With a plan, a missing one is worked out from the plan's term. */
  contractStart: z.string().nullable(),
  contractEnd: z.string().nullable(),
  /** The last inspection before Aerowise; visits up to it count as done. */
  lastInspection: z.string().nullable(),
});
export type ImportRecord = z.infer<typeof importRecord>;

export const importRow = z.object({
  rowNo: z.number().int(),
  status: z.enum(IMPORT_ROW_STATUSES),
  /** Whether the row will be saved on commit. Errors never are; duplicates are not unless chosen. */
  include: z.boolean(),
  record: importRecord,
  messages: z.array(z.string()),
  /** What the import will do with the row that depends on today's date; never changes its status. */
  notes: z.array(z.string()),
  /** Where an existing customer will get this site, instead of a new customer. */
  existingCustomer: z.object({ id, displayName: z.string() }).nullable(),
  duplicateOf: z.object({ kind: z.enum(["row", "site"]), rowNo: z.number().int().nullable(), siteId: id.nullable(), label: z.string() }).nullable(),
  result: z.object({ customerId: id, siteId: id, contractId: id.nullable() }).nullable(),
});
export type ImportRow = z.infer<typeof importRow>;

export const importSummary = z.object({
  rows: z.number().int(),
  ready: z.number().int(),
  warning: z.number().int(),
  duplicate: z.number().int(),
  error: z.number().int(),
  included: z.number().int(),
});

export const IMPORT_MAPPING_SOURCES = ["detected", "saved", "edited"] as const;

export const importSheet = z.object({ name: z.string(), headers: z.array(z.string()), rows: z.number().int() });

export const importDetail = z.object({
  id,
  filename: z.string(),
  status: z.enum(IMPORT_STATUSES),
  /** Every sheet of the workbook that has data; a CSV file has one. */
  sheets: z.array(importSheet),
  /** The sheet being previewed and imported, an index into sheets. */
  sheetIndex: z.number().int(),
  headers: z.array(z.string()),
  mapping: z.record(z.string(), z.number().int()),
  /** Where the column choices came from: detection, the organization's saved choices, or a person on this import. */
  mappingSource: z.enum(IMPORT_MAPPING_SOURCES),
  summary: importSummary,
  createdAt: z.iso.datetime({ offset: true }),
  committedAt: z.iso.datetime({ offset: true }).nullable(),
  undoneAt: z.iso.datetime({ offset: true }).nullable(),
  error: z.string().nullable(),
  result: z.object({ customers: z.number().int(), sites: z.number().int(), contracts: z.number().int() }).nullable(),
  rows: z.array(importRow),
});
export type ImportDetail = z.infer<typeof importDetail>;

/** What undoing a committed import would delete, and the work that stops it. */
export const importUndoCheck = z.object({
  canUndo: z.boolean(),
  /** Why it cannot be undone when that is not about work done (not committed, already undone). */
  reason: z.string().nullable(),
  removes: z.object({ customers: z.number().int(), sites: z.number().int(), contracts: z.number().int(), visits: z.number().int() }),
  blockers: z.array(z.object({ table: z.string(), label: z.string(), count: z.number().int() })),
});
export type ImportUndoCheck = z.infer<typeof importUndoCheck>;

export const importListItem = importDetail
  .pick({ id: true, filename: true, status: true, createdAt: true, committedAt: true, result: true })
  .extend({ rows: z.number().int() });
export type ImportListItem = z.infer<typeof importListItem>;

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;

export const importUpload = z.object({
  filename: z.string().trim().min(1).max(200),
  /** The file's bytes, base64-encoded, so the upload stays a JSON request. */
  contentBase64: z.string().min(1).max(Math.ceil((MAX_IMPORT_BYTES * 4) / 3) + 4),
});

export const importMappingInput = z.object({
  mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.number().int().min(0).nullable()),
});

export const importSheetInput = z.object({ sheetIndex: z.number().int().min(0) });

export const importRowsInput = z.object({
  /** Row numbers to include or leave out. */
  include: z.array(z.number().int().min(1)).max(MAX_IMPORT_ROWS).default([]),
  exclude: z.array(z.number().int().min(1)).max(MAX_IMPORT_ROWS).default([]),
});

// Building the preview. Pure, so the API and the tests share one definition of what a
// row will become.

export interface ExistingRecords {
  customers: { id: string; displayName: string; phones: string[]; emails: string[] }[];
  sites: { id: string; addressLine1: string; city: string; permitNumber: string | null }[];
  /** Active plans, matched by name without regard to case. */
  /** `notImported`: why this plan's contracts are not created by an import (SW-9: it has pumping or maintenance). */
  plans: { name: string; termMonths: number; visitsPerTerm: number; notImported?: string }[];
  /** Today in the organization's time zone. */
  today: string;
}

export interface AnalyzedRow extends ImportRow {
  /** Rows with the same key become one customer. */
  customerKey: string;
}

/** "Example", "example county" and "Example County" all name the same county. */
function countyName(raw: string | null): string | null {
  const base = raw?.replace(/\s+county$/i, "").trim();
  if (!base) return null;
  return `${base.replace(/\b\w/g, (c) => c.toUpperCase())} County`;
}

const STATE_NAMES: Record<string, string> = { texas: "TX", tex: "TX" };

function recordFrom(raw: string[], mapping: ColumnMapping, messages: string[]): ImportRecord {
  const cell = (field: ImportField) => (mapping[field] === undefined ? undefined : raw[mapping[field]!]);
  const text = (field: ImportField) => normalizeText(cell(field));
  const name =
    text("customerName") ?? normalizeText([cell("firstName") ?? "", cell("lastName") ?? ""].join(" "));

  const rawPhone = text("phone");
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) messages.push(`Phone "${rawPhone}" is not a 10-digit US number and was left out`);
  const rawEmail = text("email");
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (rawEmail && !email) messages.push(`Email "${rawEmail}" is not a valid address and was left out`);

  const rawState = text("state");
  let state = "TX";
  if (rawState) {
    if (/^[a-z]{2}$/i.test(rawState)) state = rawState.toUpperCase();
    else if (STATE_NAMES[rawState.toLowerCase()]) state = STATE_NAMES[rawState.toLowerCase()]!;
    else messages.push(`State "${rawState}" was not recognized; TX was used`);
  }

  const rawZip = text("postalCode");
  let postalCode: string | null = null;
  if (rawZip) {
    // Spreadsheets drop the leading zero of a ZIP stored as a number.
    const z = /^\d{4}$/.test(rawZip) ? `0${rawZip}` : rawZip;
    if (/^\d{5}(-\d{4})?$/.test(z)) postalCode = z;
    else messages.push(`ZIP "${rawZip}" is not a ZIP code and was left out`);
  }

  const date = (field: "contractStart" | "contractEnd" | "lastInspection") => {
    const raw = text(field);
    const value = raw ? normalizeDate(raw) : null;
    if (raw && !value) messages.push(`${IMPORT_FIELD_LABELS[field]} "${raw}" is not a date`);
    return value;
  };

  return {
    customerName: name,
    phone,
    email,
    addressLine1: text("addressLine1"),
    addressLine2: text("addressLine2"),
    city: text("city"),
    state,
    postalCode,
    county: countyName(text("county")),
    permitNumber: text("permitNumber")?.toUpperCase() ?? null,
    gateCode: text("gateCode"),
    accessNotes: text("accessNotes"),
    manufacturer: text("manufacturer"),
    model: text("model"),
    serial: text("serial"),
    planName: text("planName"),
    contractStart: date("contractStart"),
    contractEnd: date("contractEnd"),
    lastInspection: date("lastInspection"),
  };
}

/**
 * Turns raw rows into what the import will save: cleaned values, problems, duplicates of
 * earlier rows or of sites already on file, and which existing customer a row belongs to.
 */
export function analyzeImport(
  rows: { rowNo: number; raw: string[]; include: boolean | null }[],
  mapping: ColumnMapping,
  existing: ExistingRecords,
): AnalyzedRow[] {
  const customersByName = new Map<string, ExistingRecords["customers"]>();
  for (const c of existing.customers) {
    const key = c.displayName.trim().toLowerCase();
    customersByName.set(key, [...(customersByName.get(key) ?? []), c]);
  }
  const sitesByKey = new Map(existing.sites.map((s) => [addressKey(s.addressLine1, s.city), s]));
  const sitesByPermit = new Map(existing.sites.filter((s) => s.permitNumber).map((s) => [s.permitNumber!.toUpperCase(), s]));
  const plans = new Map(existing.plans.map((p) => [p.name.toLowerCase(), p]));

  const rowsByKey = new Map<string, number>();
  const rowsByPermit = new Map<string, number>();
  const rowsByName = new Map<string, { rowNo: number; phone: string | null; email: string | null }[]>();

  return rows.map(({ rowNo, raw, include }) => {
    const messages: string[] = [];
    const errors: string[] = [];
    const record = recordFrom(raw, mapping, messages);
    if (!record.customerName) errors.push("No customer name");
    if (!record.addressLine1) errors.push("No service address");
    if (!record.city) errors.push("No city");

    const notes: string[] = [];
    contractTerms(record, plans, existing.today, messages, notes);

    // Which customer this row belongs to.
    const nameKey = (record.customerName ?? "").toLowerCase();
    let existingCustomer: ImportRow["existingCustomer"] = null;
    let customerKey = `row:${rowNo}`;
    if (record.customerName) {
      const sameName = customersByName.get(nameKey) ?? [];
      const match = sameName.find(
        (c) => (record.phone && c.phones.includes(record.phone)) || (record.email && c.emails.includes(record.email)),
      );
      if (match) {
        existingCustomer = { id: match.id, displayName: match.displayName };
        customerKey = `customer:${match.id}`;
      } else {
        if (sameName.length) messages.push(`A customer named ${record.customerName} already exists with a different phone and email; a new customer will be created`);
        const earlier = rowsByName.get(nameKey) ?? [];
        const sameContact = earlier.find((r) => (record.phone && r.phone === record.phone) || (record.email && r.email === record.email));
        if (sameContact) customerKey = `row:${sameContact.rowNo}`;
        else if (earlier.length) messages.push(`Same name as row ${earlier[0]!.rowNo} but no shared phone or email; imported as a separate customer`);
        if (!sameContact) rowsByName.set(nameKey, [...earlier, { rowNo, phone: record.phone, email: record.email }]);
      }
    }

    // Duplicates: the same address or permit earlier in the file, or already on file.
    let duplicateOf: ImportRow["duplicateOf"] = null;
    if (record.addressLine1 && record.city) {
      const key = addressKey(record.addressLine1, record.city);
      const site = sitesByKey.get(key) ?? (record.permitNumber ? sitesByPermit.get(record.permitNumber) : undefined);
      const earlierRow = rowsByKey.get(key) ?? (record.permitNumber ? rowsByPermit.get(record.permitNumber) : undefined);
      if (site) duplicateOf = { kind: "site", rowNo: null, siteId: site.id, label: `${site.addressLine1}, ${site.city}${site.permitNumber ? ` (permit ${site.permitNumber})` : ""}` };
      else if (earlierRow !== undefined) duplicateOf = { kind: "row", rowNo: earlierRow, siteId: null, label: `Row ${earlierRow}` };
      if (!rowsByKey.has(key)) rowsByKey.set(key, rowNo);
      if (record.permitNumber && !rowsByPermit.has(record.permitNumber)) rowsByPermit.set(record.permitNumber, rowNo);
    }

    const status: ImportRowStatus = errors.length ? "error" : duplicateOf ? "duplicate" : messages.length ? "warning" : "ready";
    return {
      rowNo,
      status,
      include: status === "error" ? false : (include ?? status !== "duplicate"),
      record,
      messages: [...errors, ...messages],
      notes,
      existingCustomer,
      duplicateOf,
      result: null,
      customerKey,
    };
  });
}

/**
 * Settles the contract a row describes: the plan, both dates (one may be worked out from
 * the plan's term), and what its visits will look like.
 */
function contractTerms(record: ImportRecord, plans: Map<string, ExistingRecords["plans"][number]>, today: string, messages: string[], notes: string[]) {
  const dated = record.contractStart || record.contractEnd;
  const plan = record.planName ? plans.get(record.planName.toLowerCase()) : undefined;
  if (record.planName) record.planName = plan?.name ?? record.planName;
  if (!record.planName) {
    if (dated) messages.push("Contract dates given without a plan; no contract will be created");
  } else if (!plan) messages.push(`No active plan named "${record.planName}"; no contract will be created`);
  else if (plan.notImported) messages.push(plan.notImported);
  else if (!dated) messages.push("No contract start or end date; no contract will be created");

  if (!plan || plan.notImported || !dated) {
    if (record.lastInspection) messages.push("Last inspection is only used with a contract; no visits are scheduled from it");
    return;
  }

  // The end date is what renewals run on, so when both are given and disagree, it wins.
  const fromEnd = record.contractEnd ? addMonths(addDays(record.contractEnd, 1), -plan.termMonths) : null;
  const startOn = fromEnd ?? record.contractStart!;
  const endOn = addDays(addMonths(startOn, plan.termMonths), -1);
  if (record.contractStart && fromEnd && fromEnd !== record.contractStart) {
    messages.push(`Contract start ${record.contractStart} does not fit a ${plan.termMonths}-month plan ending ${endOn}; the contract starts ${startOn}`);
  }
  record.contractStart = startOn;
  record.contractEnd = endOn;

  if (record.lastInspection && record.lastInspection > today) {
    messages.push(`Last inspection ${record.lastInspection} is in the future and was left out`);
    record.lastInspection = null;
  }
  const firstVisitDue = addDays(addMonths(startOn, plan.termMonths / plan.visitsPerTerm), -1);
  if (endOn < today) notes.push(`Contract ended on ${endOn}; it is imported for renewal and its visits are not scheduled`);
  else if (!record.lastInspection && firstVisitDue < today) notes.push("No last inspection date; visits due since the contract started will show as overdue");
}

export function summarize(rows: Pick<ImportRow, "status" | "include">[]) {
  const count = (s: ImportRowStatus) => rows.filter((r) => r.status === s).length;
  return {
    rows: rows.length,
    ready: count("ready"),
    warning: count("warning"),
    duplicate: count("duplicate"),
    error: count("error"),
    included: rows.filter((r) => r.include).length,
  };
}
