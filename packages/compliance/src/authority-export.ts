import type { AuthorityExportRule, InspectionValues } from "@aerowise/domain";
import { DEMO_WATERMARK } from "@aerowise/reports";

// An authority's CSV for one filing: one header row and one data row, in the column layout
// its ruleset declares. The file goes into the filing's submission package like any other
// document, so it is made once, hashed and never changed. Making it files nothing: the
// office uploads it and records that, and only the authority's acknowledgment confirms it.

/**
 * A demo company's authority CSV starts with this column, on the header and the row, so the
 * file (or a row copied out of it) still says it is fictional. Same column as the data
 * export's (STG-07); the authority's own columns keep their names and order after it.
 */
export const AUTHORITY_CSV_DEMO_COLUMN = "aerowise_demo_notice";

/** Everything a column can be filled from, for one filing. */
export interface AuthorityExportFacts {
  filingId: string;
  submissionNo: number;
  submissionDate: string;
  inspectionDate: string | null;
  technicianName: string | null;
  technicianLicense: string | null;
  /** Inspection answers as on the authority report version in the package. */
  values: InspectionValues;
  ownerName: string;
  site: { addressLine1: string; city: string; state: string; postalCode: string | null; county: string | null; permitNumber: string | null };
  identifiers: Record<string, string>;
  providerName: string;
  responsibleProviderName: string | null;
  responsibleProviderMpNumber: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The sources whose values are calendar dates. */
const DATE_SOURCES: ReadonlySet<Column["source"]> = new Set(["inspection_date", "submission_date"]);

function formatDate(value: string, format: AuthorityExportRule["dateFormat"]) {
  if (!ISO_DATE.test(value) || format === "YYYY-MM-DD") return value;
  return `${value.slice(5, 7)}/${value.slice(8, 10)}/${value.slice(0, 4)}`;
}

function answer(value: InspectionValues[string] | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join("; ") : null;
  return String(value);
}

type Column = AuthorityExportRule["columns"][number];

/** A column's value for this filing, before date formatting; null when there is none. */
function columnValue(c: Column, facts: AuthorityExportFacts): string | null {
  switch (c.source) {
    case "filing_id":
      return facts.filingId;
    case "submission_number":
      return String(facts.submissionNo);
    case "submission_date":
      return facts.submissionDate;
    case "inspection_date":
      return facts.inspectionDate;
    case "technician_name":
      return facts.technicianName;
    case "technician_license":
      return facts.technicianLicense;
    case "field":
      return answer(facts.values[c.field!]);
    case "owner_name":
      return facts.ownerName;
    case "site_address_line1":
      return facts.site.addressLine1;
    case "site_city":
      return facts.site.city;
    case "site_state":
      return facts.site.state;
    case "site_postal_code":
      return facts.site.postalCode;
    case "site_county":
      return facts.site.county;
    case "site_permit_number":
      return facts.site.permitNumber;
    case "identifier":
      return facts.identifiers[c.identifier!] ?? null;
    case "provider_name":
      return facts.providerName;
    case "responsible_provider_name":
      return facts.responsibleProviderName;
    case "responsible_provider_mp_number":
      return facts.responsibleProviderMpNumber;
    case "constant":
      return c.value!;
  }
}

/** The headers of required columns this filing has no value for. */
export function missingExportColumns(layout: AuthorityExportRule, facts: AuthorityExportFacts): string[] {
  return layout.columns.filter((c) => c.required && !columnValue(c, facts)?.trim()).map((c) => c.header);
}

/**
 * One CSV cell. A spreadsheet runs text starting with = + - @ (or a tab or return) as a
 * formula, so such text gets a leading quote; plain numbers, negative ones included, are
 * left alone.
 */
export function csvCell(value: string | null): string {
  if (value === null) return "";
  const safe = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) || safe !== value ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const filenamePart = (v: string | null) => (v ?? "").replace(/[^A-Za-z0-9-]/g, "") || "none";

/** The authority CSV for one filing: its file name and bytes. */
export function authorityCsv(layout: AuthorityExportRule, facts: AuthorityExportFacts, opts: { demo: boolean }): { filename: string; content: Buffer } {
  const headers = layout.columns.map((c) => c.header);
  // Only the date sources take the layout's date format; every other value (a permit
  // number or answer that happens to look like a date) goes out as recorded.
  const row = layout.columns.map((c) => {
    const v = columnValue(c, facts);
    return v !== null && DATE_SOURCES.has(c.source) ? formatDate(v, layout.dateFormat) : v;
  });
  const lead = opts.demo ? [AUTHORITY_CSV_DEMO_COLUMN] : [];
  const notice = opts.demo ? [DEMO_WATERMARK] : [];
  const lines = [[...lead, ...headers].map(csvCell).join(","), [...notice, ...row].map(csvCell).join(",")];
  const text = `${lines.join("\r\n")}\r\n`;
  const name = layout.filename
    .replaceAll("{permitNumber}", filenamePart(facts.site.permitNumber))
    .replaceAll("{inspectionDate}", filenamePart(facts.inspectionDate))
    .replaceAll("{submissionDate}", filenamePart(facts.submissionDate))
    .replaceAll("{filingId}", facts.filingId.slice(0, 8));
  const bom = layout.encoding === "utf-8-bom" ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  return { filename: opts.demo ? `DEMO-${name}` : name, content: Buffer.concat([bom, Buffer.from(text, "utf8")]) };
}
