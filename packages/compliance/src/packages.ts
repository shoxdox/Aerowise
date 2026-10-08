import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Database, DB } from "@aerowise/db";
import {
  addDays,
  CREDENTIAL_LABELS,
  type ContractFilingBasis,
  credentialProblems,
  exportLayoutFor,
  INSPECTING_CREDENTIALS,
  type CredentialKind,
  type FilingKind,
  type InspectionValues,
  type PackageDocument,
  type RulesetRules,
  siteScheduleProblem,
  type SubmissionMethod,
} from "@aerowise/domain";
import { fillPdfForm, renderCoverSheet } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import type { Transaction } from "kysely";
import { authorityCsv, type AuthorityExportFacts, missingExportColumns } from "./authority-export.ts";
import { amendmentsOf, latestAuthorityReport } from "./reports.ts";
import { reportSignature } from "./signatures.ts";
import { dateInZone, type ResolvedJurisdiction } from "./rulesets.ts";

// A submission package is everything one submission of a filing consists of: who it goes
// to, the message, the cover sheet's values and each document with its hash. It is built
// once per submission, stored, and never changed, so every retry sends the same bytes and
// the office can always show exactly what was filed.

type Executor = Database | Transaction<DB>;

const FORMS_DIR = fileURLToPath(new URL("../forms/", import.meta.url));
/** Official forms are US forms: dates go on them as MM/DD/YYYY. */
const formValue = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(5, 7)}/${v.slice(8, 10)}/${v.slice(0, 4)}` : v);

/** The authority's own form with the values filled in, after checking it is the copy the ruleset pinned. */
export async function fillOfficialForm(sheet: NonNullable<RulesetRules["coverSheet"]>, fields: { label: string; value: string | null }[]) {
  const form = sheet.officialForm!;
  const template = readFileSync(FORMS_DIR + form.file);
  if (sha256Hex(template) !== form.sha256) throw new Error(`The stored form ${form.file} is not the copy the ruleset was written against`);
  const values: Record<string, string> = {};
  for (const field of sheet.fields) {
    const value = fields.find((x) => x.label === field.label)?.value;
    if (field.formField && value) values[field.formField] = formValue(value);
  }
  return fillPdfForm(template, values);
}

export interface PackageFiling {
  id: string;
  organizationId: string;
  kind: FilingKind;
  siteId: string;
  inspectionId: string | null;
  contractId: string | null;
  signedDocumentId: string | null;
  contractDocumentId: string | null;
  submissionNo: number;
  submissionMethod: SubmissionMethod | null;
}

export interface StoredPackage {
  id: string;
  submissionNo: number;
  method: SubmissionMethod;
  recipient: string | null;
  subject: string;
  body: string;
  fields: { label: string; value: string | null; required: boolean }[];
  documents: PackageDocument[];
  manifestSha256: string;
  createdAt: Date;
}

/** The documents a package needs do not exist yet (a report or signed PDF still rendering). */
export class PackageNotReady extends Error {}

const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Everything the cover sheet, subject and readiness checks read about a filing. */
async function filingFacts(db: Executor, f: PackageFiling, resolved: ResolvedJurisdiction, at: Date) {
  const site = await db
    .selectFrom("sites as s")
    .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"))
    .innerJoin("organizations as o", "o.id", "s.organizationId")
    .select(["s.addressLine1", "s.addressLine2", "s.city", "s.state", "s.postalCode", "s.county", "s.permitNumber", "c.displayName", "o.name as orgName", "o.timezone", "o.responsibleCredentialId", "o.demo"])
    .where("s.organizationId", "=", f.organizationId)
    .where("s.id", "=", f.siteId)
    .executeTakeFirstOrThrow();
  const today = dateInZone(at, site.timezone);
  const [identifiers, responsible] = await Promise.all([
    db
      .selectFrom("siteAuthorityIdentifiers")
      .select(["kind", "value"])
      .where("organizationId", "=", f.organizationId)
      .where("siteId", "=", f.siteId)
      .where("jurisdictionId", "=", resolved.jurisdictionId)
      .execute(),
    site.responsibleCredentialId
      ? db
          .selectFrom("providerCredentials")
          .select(["holderName", "kind", "number", "active", "expiresOn"])
          .where("organizationId", "=", f.organizationId)
          .where("id", "=", site.responsibleCredentialId)
          .executeTakeFirst()
      : undefined,
  ]);
  let inspectionDate: string | null = null;
  let technician: { userId: string; name: string; license: string | null; credentials: { kind: string; number: string; active: boolean; expiresOn: string | null }[] } | null = null;
  if (f.inspectionId) {
    const insp = await db
      .selectFrom("inspections as i")
      .innerJoin("users as u", "u.id", "i.technicianUserId")
      .leftJoin("memberships as m", (j) => j.onRef("m.userId", "=", "i.technicianUserId").onRef("m.organizationId", "=", "i.organizationId"))
      .select(["i.completedAt", "i.technicianUserId", "u.name", "m.technicianLicense"])
      .where("i.organizationId", "=", f.organizationId)
      .where("i.id", "=", f.inspectionId)
      .executeTakeFirstOrThrow();
    inspectionDate = insp.completedAt ? dateInZone(insp.completedAt, site.timezone) : null;
    const credentials = await db
      .selectFrom("providerCredentials")
      .select(["kind", "number", "active", "expiresOn"])
      .where("organizationId", "=", f.organizationId)
      .where("userId", "=", insp.technicianUserId)
      .execute();
    technician = { userId: insp.technicianUserId, name: insp.name, license: insp.technicianLicense ?? null, credentials };
  }
  // The contract the filing is for, or the one in force on the inspection date.
  let contractQ = db
    .selectFrom("contracts")
    .select(["startOn", "endOn", "termMonths", "visitsPerTerm"])
    .where("organizationId", "=", f.organizationId)
    .where("siteId", "=", f.siteId);
  contractQ = f.contractId
    ? contractQ.where("id", "=", f.contractId)
    : contractQ.where("status", "=", "active").where("startOn", "<=", inspectionDate ?? today).where("endOn", ">=", inspectionDate ?? today);
  const contract = await contractQ.orderBy("startOn", "desc").executeTakeFirst();
  return {
    today,
    timezone: site.timezone,
    providerName: site.orgName,
    responsible: responsible ?? null,
    technician,
    ownerName: site.displayName,
    address: [site.addressLine1, site.addressLine2, site.city, [site.state, site.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    site: { addressLine1: site.addressLine1, city: site.city, state: site.state, postalCode: site.postalCode, county: site.county, permitNumber: site.permitNumber },
    demo: site.demo,
    permitNumber: site.permitNumber,
    identifiers: Object.fromEntries(identifiers.map((i) => [i.kind, i.value])) as Record<string, string>,
    contract: contract ?? null,
    inspectionDate,
  };
}

type Facts = Awaited<ReturnType<typeof filingFacts>>;

function fieldValue(source: NonNullable<RulesetRules["coverSheet"]>["fields"][number], facts: Facts): string | null {
  switch (source.source) {
    case "submission_date":
      return facts.today;
    case "provider_name":
      return facts.providerName;
    case "responsible_provider_name":
      return facts.responsible?.holderName ?? null;
    case "responsible_provider_mp_number":
      return facts.responsible?.kind === "tceq_maintenance_provider" ? facts.responsible.number : null;
    case "owner_name":
      return facts.ownerName;
    case "site_address":
      return facts.address;
    case "site_permit_number":
      return facts.permitNumber;
    case "contract_start":
      return facts.contract?.startOn ?? null;
    case "contract_end":
      return facts.contract?.endOn ?? null;
    case "inspections_per_year":
      return facts.contract ? String(Math.round((facts.contract.visitsPerTerm * 12) / facts.contract.termMonths)) : null;
    case "inspection_report_date":
      return facts.inspectionDate;
    case "identifier":
      return (source.identifier && facts.identifiers[source.identifier]) || null;
  }
}

/**
 * What the authority CSV is filled from: the filing's facts, plus the inspection answers as
 * on the authority report version going out (corrected answers count over the originals).
 */
async function exportFacts(db: Executor, f: PackageFiling, facts: Facts, reportId: string | null): Promise<AuthorityExportFacts> {
  let values: InspectionValues = {};
  if (f.inspectionId) {
    const [rows, report] = await Promise.all([
      db.selectFrom("inspectionValues").select(["fieldKey", "valueJson"]).where("organizationId", "=", f.organizationId).where("inspectionId", "=", f.inspectionId).execute(),
      reportId
        ? db.selectFrom("reports").select("snapshot").where("organizationId", "=", f.organizationId).where("id", "=", reportId).executeTakeFirst()
        : latestAuthorityReport(db, f.organizationId, f.inspectionId),
    ]);
    values = { ...Object.fromEntries(rows.map((v) => [v.fieldKey, v.valueJson as InspectionValues[string]])), ...amendmentsOf(report?.snapshot) };
  }
  return {
    filingId: f.id,
    submissionNo: f.submissionNo,
    submissionDate: facts.today,
    inspectionDate: facts.inspectionDate,
    technicianName: facts.technician?.name ?? null,
    technicianLicense: facts.technician?.license ?? null,
    values,
    ownerName: facts.ownerName,
    site: facts.site,
    identifiers: facts.identifiers,
    providerName: facts.providerName,
    responsibleProviderName: facts.responsible?.holderName ?? null,
    responsibleProviderMpNumber: facts.responsible?.kind === "tceq_maintenance_provider" ? facts.responsible.number : null,
  };
}

function fillTemplate(template: string, facts: Facts) {
  return template
    .replaceAll("{permitNumber}", facts.permitNumber ?? "not recorded")
    .replaceAll("{address}", facts.address)
    .replace(/\{identifier:([a-z0-9_]+)\}/g, (_, key: string) => facts.identifiers[key] ?? "not recorded");
}

/**
 * What stands between a filing and its authority, as sentences for the office: missing
 * authority identifiers, a missing or lapsed responsible provider license, required cover
 * sheet fields with no value. Inspection answers are checked by the adapter.
 */
export async function packageProblems(db: Executor, f: PackageFiling, resolved: ResolvedJurisdiction, at: Date): Promise<string[]> {
  const rules = resolved.rules;
  const facts = await filingFacts(db, f, resolved, at);
  const problems: string[] = [];
  for (const id of rules.identifiers ?? []) {
    const value = facts.identifiers[id.key];
    if (!value) {
      if (id.required) problems.push(`The site has no ${id.label} for ${resolved.authorityName}`);
    } else if (id.pattern && !new RegExp(id.pattern).test(value)) {
      problems.push(`The ${id.label} "${value}" is not in ${resolved.authorityName}'s format`);
    }
  }
  if (rules.provider?.responsibleProviderRequired) {
    if (!facts.responsible) problems.push("No responsible licensed maintenance provider is set for the organization (Settings, Credentials)");
    else if (facts.responsible.kind !== "tceq_maintenance_provider") problems.push(`The responsible provider's credential is a ${CREDENTIAL_LABELS[facts.responsible.kind as CredentialKind]}, not a TCEQ maintenance provider (MP) license`);
    else for (const p of credentialProblems(facts.responsible, facts.today)) problems.push(`The responsible provider's MP license ${facts.responsible.number} ${p}`);
  }
  if (f.kind === "inspection_report" && rules.provider?.technicianCredentialRequired && facts.technician) {
    const onDate = facts.inspectionDate ?? facts.today;
    const usable = facts.technician.credentials.filter((c) => INSPECTING_CREDENTIALS.includes(c.kind as CredentialKind) && !credentialProblems(c, onDate).length);
    if (!usable.length) problems.push(`${facts.technician.name} has no active TCEQ maintenance provider license or maintenance technician registration on record for ${onDate} (Settings, Credentials)`);
  }
  const sheet = rules.coverSheet;
  if (sheet?.appliesTo.includes(f.kind)) {
    for (const field of sheet.fields) {
      if (field.required && !fieldValue(field, facts) && !problems.some((p) => p.includes(field.label))) problems.push(`The cover sheet's required "${field.label}" has no value`);
    }
  }
  if (f.kind === "inspection_report" && rules.inspectionReports?.submission === "unknown") {
    problems.push(`${resolved.authorityName} has not published how inspection reports are submitted, so this report cannot be filed through Aerowise`);
  }
  if (f.kind === "contract" && rules.contracts?.submission === "unknown") {
    problems.push(`${resolved.authorityName} has not published how maintenance contracts are submitted, so this contract cannot be filed through Aerowise`);
  }
  if (f.submissionMethod === "csv_export") {
    const layout = exportLayoutFor(rules, f.kind);
    if (!layout) problems.push(`${resolved.authorityName}'s rules have no CSV layout for ${f.kind === "contract" ? "contracts" : "inspection reports"}, so this filing cannot be exported as CSV`);
    else {
      const missing = missingExportColumns(layout, await exportFacts(db, f, facts, null));
      if (missing.length) problems.push(`The authority CSV's required ${missing.length === 1 ? "column" : "columns"} ${missing.map((m) => `"${m}"`).join(", ")} ${missing.length === 1 ? "has" : "have"} no value`);
    }
  }
  if (f.kind === "contract" && f.contractId) problems.push(...(await contractTermProblems(db, f.organizationId, f.contractId, resolved, facts.today)));
  if (rules.service.categoryTerms || rules.labTests?.useCategories) {
    const site = await db.selectFrom("sites").select(["useCategory", "permitIntervalMonths"]).where("organizationId", "=", f.organizationId).where("id", "=", f.siteId).executeTakeFirstOrThrow();
    const schedule = siteScheduleProblem(rules, resolved.authorityName, site);
    if (schedule) problems.push(schedule);
  }
  return problems;
}

/**
 * What an authority asks of a contract's terms on top of 30 TAC 285.7 (Hays 10.V.2 and
 * 10.V.6): a renewal waits for the previous term's reports, and a contract taken over from
 * another provider covers a minimum term and number of visits.
 */
async function contractTermProblems(db: Executor, organizationId: string, contractId: string, resolved: ResolvedJurisdiction, today: string): Promise<string[]> {
  const rules = resolved.rules.contracts;
  if (!rules?.renewalNeedsPriorReports && !rules?.newProviderMinimum) return [];
  const k = await db
    .selectFrom("contracts")
    .select(["previousContractId", "filingBasis", "termMonths", "visitsPerTerm"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", contractId)
    .executeTakeFirstOrThrow();
  const problems: string[] = [];
  if (rules.renewalNeedsPriorReports && k.previousContractId) {
    const missing = await unsentPriorReports(db, organizationId, k.previousContractId, today);
    if (missing > 0) {
      problems.push(
        `${resolved.authorityName} accepts a renewal with the same provider only after every report from the previous contract has been submitted; ${missing} visit${missing === 1 ? " is" : "s are"} due by now without a sent report`,
      );
    }
  }
  const min = rules.newProviderMinimum;
  // A renewal or replacement with no earlier contract in Aerowise may follow another provider's.
  if (min && !k.previousContractId && (k.filingBasis === "renewal" || k.filingBasis === "replacement") && (k.termMonths < min.termMonths || k.visitsPerTerm < min.visits)) {
    problems.push(
      `If the previous contract was with another provider, ${resolved.authorityName} requires this one to run at least ${min.termMonths} months with ${min.visits} inspections, counting the first; it runs ${k.termMonths} months with ${k.visitsPerTerm}`,
    );
  }
  return problems;
}

/**
 * Visits of a contract that were due by `today` (or done) without a report that has gone to
 * the authority. Visits completed by an import were reported outside Aerowise and count as done.
 */
async function unsentPriorReports(db: Executor, organizationId: string, contractId: string, today: string): Promise<number> {
  const rows = await db
    .selectFrom("serviceObligations as o")
    .select("o.id")
    .where("o.organizationId", "=", organizationId)
    .where("o.contractId", "=", contractId)
    .where("o.status", "<>", "cancelled")
    .where("o.completedByImport", "is", null)
    .where((eb) => eb.or([eb("o.status", "=", "completed"), eb("o.dueOn", "<=", today)]))
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("jobs as j")
            .innerJoin("inspections as i", (x) => x.onRef("i.jobId", "=", "j.id").onRef("i.organizationId", "=", "j.organizationId"))
            .innerJoin("filings as f", (x) => x.onRef("f.inspectionId", "=", "i.id").onRef("f.organizationId", "=", "i.organizationId"))
            .select("f.id")
            .whereRef("j.obligationId", "=", "o.id")
            .whereRef("j.organizationId", "=", "o.organizationId")
            .where("f.kind", "=", "inspection_report")
            .where("f.status", "in", ["sent", "confirmed"]),
        ),
      ),
    )
    .execute();
  return rows.length;
}

async function documentsFor(db: Executor, f: PackageFiling): Promise<PackageDocument[]> {
  if (f.kind === "inspection_report") {
    const report = f.inspectionId ? await latestAuthorityReport(db, f.organizationId, f.inspectionId) : null;
    if (!report) throw new PackageNotReady("The authority report has not been made yet");
    // The maintenance provider's signed copy goes out when there is one (285.7(b)(3)).
    const signed = await reportSignature(db, f.organizationId, report.id);
    return [
      {
        role: "inspection_report",
        filename: signed ? `inspection-report-v${report.version}-signed.pdf` : `inspection-report-v${report.version}.pdf`,
        storageKey: signed?.storageKey ?? report.storageKey,
        contentType: report.contentType,
        sha256: signed?.sha256 ?? report.sha256,
        byteSize: signed?.byteSize ?? report.byteSize,
        sourceId: report.id,
        sourceVersion: report.version,
      },
    ];
  }
  if (f.signedDocumentId) {
    const d = await db
      .selectFrom("signedDocuments")
      .select(["id", "pdfStorageKey", "pdfSha256", "pdfByteSize"])
      .where("organizationId", "=", f.organizationId)
      .where("id", "=", f.signedDocumentId)
      .executeTakeFirstOrThrow();
    if (!d.pdfStorageKey || !d.pdfSha256 || !d.pdfByteSize) throw new PackageNotReady("The signed contract PDF has not been made yet");
    return [{ role: "contract", filename: "signed-contract.pdf", storageKey: d.pdfStorageKey, contentType: "application/pdf", sha256: d.pdfSha256, byteSize: d.pdfByteSize, sourceId: d.id, sourceVersion: null }];
  }
  if (f.contractDocumentId) {
    const d = await db
      .selectFrom("contractDocuments")
      .select(["id", "storageKey", "sha256", "byteSize", "contentType", "filename"])
      .where("organizationId", "=", f.organizationId)
      .where("id", "=", f.contractDocumentId)
      .executeTakeFirstOrThrow();
    return [{ role: "contract", filename: d.filename, storageKey: d.storageKey, contentType: d.contentType, sha256: d.sha256, byteSize: d.byteSize, sourceId: d.id, sourceVersion: null }];
  }
  throw new PackageNotReady("No signed copy of this contract is in Aerowise");
}

const rowToPackage = (r: { id: string; submissionNo: number; method: SubmissionMethod; recipient: string | null; subject: string; body: string; fields: unknown; documents: unknown; manifestSha256: string; createdAt: Date }): StoredPackage => ({
  id: r.id,
  submissionNo: r.submissionNo,
  method: r.method,
  recipient: r.recipient,
  subject: r.subject,
  body: r.body,
  fields: r.fields as StoredPackage["fields"],
  documents: r.documents as PackageDocument[],
  manifestSha256: r.manifestSha256,
  createdAt: r.createdAt,
});

const packageColumns = ["id", "submissionNo", "method", "recipient", "subject", "body", "fields", "documents", "manifestSha256", "createdAt"] as const;

export async function findPackage(db: Executor, organizationId: string, filingId: string, submissionNo: number): Promise<StoredPackage | null> {
  const row = await db
    .selectFrom("submissionPackages")
    .select(packageColumns)
    .where("organizationId", "=", organizationId)
    .where("filingId", "=", filingId)
    .where("submissionNo", "=", submissionNo)
    .executeTakeFirst();
  return row ? rowToPackage(row as Parameters<typeof rowToPackage>[0]) : null;
}

/**
 * The package for the filing's current submission, building and storing it the first time.
 * Throws PackageNotReady while a document it needs is still being made.
 */
export async function ensurePackage(ctx: { db: Database; store: ObjectStore; now: () => Date }, f: PackageFiling, resolved: ResolvedJurisdiction): Promise<StoredPackage> {
  const existing = await findPackage(ctx.db, f.organizationId, f.id, f.submissionNo);
  if (existing) return existing;
  const at = ctx.now();
  const rules = resolved.rules;
  const documents = await documentsFor(ctx.db, f);
  const facts = await filingFacts(ctx.db, f, resolved, at);
  const id = crypto.randomUUID();
  const sheet = rules.coverSheet?.appliesTo.includes(f.kind) ? rules.coverSheet : null;
  const fields = sheet ? sheet.fields.map((field) => ({ label: field.label, value: fieldValue(field, facts), required: field.required })) : [];
  if (sheet) {
    const pdf = sheet.officialForm
      ? await fillOfficialForm(sheet, fields)
      : await renderCoverSheet({ title: sheet.title, formReference: sheet.formReference, fields, instructions: sheet.instructions ?? null, packageReference: id, generatedAt: at.toISOString() });
    const storageKey = `${f.organizationId}/filings/${f.id}/package-${id}/cover-sheet.pdf`;
    await ctx.store.put(storageKey, pdf, "application/pdf");
    documents.unshift({ role: "cover_sheet", filename: "cover-sheet.pdf", storageKey, contentType: "application/pdf", sha256: sha256Hex(pdf), byteSize: pdf.length, sourceId: null, sourceVersion: null });
  }
  const method: SubmissionMethod = f.submissionMethod ?? rules.submission.method;
  // Filing by CSV export: the authority's CSV goes in the package after the filed document.
  const layout = method === "csv_export" ? exportLayoutFor(rules, f.kind) : null;
  if (method === "csv_export" && !layout) throw new Error(`${resolved.authorityName}'s rules have no CSV layout for this filing`);
  if (layout) {
    const filed = documents.find((d) => d.role === "inspection_report");
    const csv = authorityCsv(layout, await exportFacts(ctx.db, f, facts, filed?.sourceId ?? null), { demo: facts.demo });
    const storageKey = `${f.organizationId}/filings/${f.id}/package-${id}/${csv.filename}`;
    await ctx.store.put(storageKey, csv.content, "text/csv; charset=utf-8");
    documents.push({ role: "authority_csv", filename: csv.filename, storageKey, contentType: "text/csv; charset=utf-8", sha256: sha256Hex(csv.content), byteSize: csv.content.length, sourceId: null, sourceVersion: null });
  }
  const recipient = rules.submission.email?.to ?? null;
  const subjectTemplate = f.kind === "contract" ? (rules.submission.email?.contractSubject ?? "OSSF maintenance contract, permit {permitNumber}") : (rules.submission.email?.subject ?? "Aerobic maintenance report, permit {permitNumber}");
  const subject = fillTemplate(subjectTemplate, facts);
  const what = f.kind === "contract" ? `the signed maintenance contract for ${facts.address}` : `the aerobic system maintenance inspection report for ${facts.address}${facts.inspectionDate ? ` (inspected ${facts.inspectionDate})` : ""}`;
  const body = [
    `Attached is ${what}.`,
    facts.permitNumber ? `Permit: ${facts.permitNumber}` : null,
    ...(rules.identifiers ?? []).filter((i) => facts.identifiers[i.key]).map((i) => `${i.label}: ${facts.identifiers[i.key]}`),
    facts.responsible?.kind === "tceq_maintenance_provider" ? `Maintenance provider: ${facts.responsible.holderName}, TCEQ MP ${facts.responsible.number}` : null,
    f.submissionNo > 1 ? `This is resubmission ${f.submissionNo - 1} of this filing.` : null,
    "",
    "Attachments:",
    ...documents.map((d) => `- ${d.filename} (SHA-256 ${d.sha256})`),
    "",
    rules.confirmation.mode === "manual_reference" ? "Please reply with your confirmation or reference number." : "If you send an acknowledgment, please reply to this message.",
    "",
    facts.providerName,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
  const manifestSha256 = sha256Hex(JSON.stringify({ method, recipient, subject, body, fields, documents: documents.map((d) => ({ role: d.role, filename: d.filename, sha256: d.sha256 })) }));
  await ctx.db
    .insertInto("submissionPackages")
    .values({
      id,
      organizationId: f.organizationId,
      filingId: f.id,
      submissionNo: f.submissionNo,
      jurisdictionId: resolved.jurisdictionId,
      rulesetId: resolved.rulesetId,
      method,
      recipient,
      subject,
      body,
      fields: JSON.stringify(fields),
      documents: JSON.stringify(documents),
      manifestSha256,
      createdAt: at,
    })
    .onConflict((oc) => oc.columns(["filingId", "submissionNo"]).doNothing())
    .execute();
  // Another worker may have stored one first; theirs is the package.
  return (await findPackage(ctx.db, f.organizationId, f.id, f.submissionNo))!;
}

/** The contract filing deadline: N days before the previous contract ends, when there is one. */
/** Which 285.7 deadline a contract filing has, and the date it counts from. */
export interface ContractBasis {
  basis: ContractFilingBasis | null;
  basisOn: string | null;
  /** Worked out from the contract this one renews in Aerowise. */
  derived: boolean;
}

/**
 * A contract's filing basis: what a person recorded, or, for a contract renewed in
 * Aerowise, a renewal of the one it follows. Otherwise unknown: Aerowise does not guess
 * whether a first contract follows an initial policy, renews another provider's contract
 * or replaces a discontinued one.
 */
export function contractBasisOf(c: { filingBasis: ContractFilingBasis | null; filingBasisOn: string | null; previousEndOn: string | null }): ContractBasis {
  if (c.filingBasis) return { basis: c.filingBasis, basisOn: c.filingBasisOn, derived: false };
  if (c.previousEndOn) return { basis: "renewal", basisOn: c.previousEndOn, derived: true };
  return { basis: null, basisOn: null, derived: false };
}

/** 285.7(d)(3)(C): a replacement contract is due no later than 30 days after termination. */
const REPLACEMENT_DAYS = 30;

/**
 * The deadline for filing a contract under 30 TAC 285.7, which differs by kind of contract:
 * - initial two-year service policy: before the system is approved for use (285.7(c)); no date Aerowise knows
 * - first contract after that policy: 30 days before the policy expires (285.7(d)(2))
 * - later contracts: at least 30 days before the current contract expires (285.7(d)(2))
 * - a new contract after one was discontinued: no later than 30 days after termination (285.7(d)(3)(C))
 * None of this applies when a single-family owner maintains the system personally
 * (285.7(d)(4)), which is never a provider's contract.
 */
export function contractDeadline(rules: RulesetRules, b: ContractBasis): { deadlineOn: string | null; basis: string } {
  const days = rules.contracts?.renewalDaysBeforePreviousEnd ?? null;
  if (days === null) return { deadlineOn: null, basis: "This authority publishes no contract deadline" };
  switch (b.basis) {
    case "initial_policy":
      return { deadlineOn: null, basis: "Initial two-year service policy: due before the system is approved for use (30 TAC 285.7(c)). Aerowise does not know that date, so no deadline is set." };
    case "after_initial_policy":
      return { deadlineOn: addDays(b.basisOn!, -days), basis: `${days} days before the initial two-year service policy expires on ${b.basisOn} (30 TAC 285.7(d)(2))` };
    case "renewal":
      return {
        deadlineOn: addDays(b.basisOn!, -days),
        basis: `${days} days before the current contract expires on ${b.basisOn} (30 TAC 285.7(d)(2))${b.derived ? "; that is the contract this one renews in Aerowise" : ""}`,
      };
    case "replacement":
      return { deadlineOn: addDays(b.basisOn!, REPLACEMENT_DAYS), basis: `No later than ${REPLACEMENT_DAYS} days after the previous contract ended on ${b.basisOn} (30 TAC 285.7(d)(3)(C))` };
    default:
      return {
        deadlineOn: null,
        basis:
          "No deadline set: record whether this is the initial two-year service policy, the first contract after it, a renewal or a replacement after a contract was discontinued. 30 TAC 285.7 gives each a different deadline.",
      };
  }
}
