import { createHash } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import { addDays, CREDENTIAL_LABELS, credentialProblems, INSPECTING_CREDENTIALS, type CredentialKind, type FilingKind, type PackageDocument, type RulesetRules, type SubmissionMethod } from "@aerowise/domain";
import { renderCoverSheet } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import type { Transaction } from "kysely";
import { latestAuthorityReport } from "./reports.ts";
import { dateInZone, type ResolvedJurisdiction } from "./rulesets.ts";

// A submission package is everything one submission of a filing consists of: who it goes
// to, the message, the cover sheet's values and each document with its hash. It is built
// once per submission, stored, and never changed, so every retry sends the same bytes and
// the office can always show exactly what was filed.

type Executor = Database | Transaction<DB>;

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
    .select(["s.addressLine1", "s.addressLine2", "s.city", "s.state", "s.postalCode", "s.permitNumber", "c.displayName", "o.name as orgName", "o.timezone", "o.responsibleCredentialId"])
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
  let technician: { userId: string; name: string; credentials: { kind: string; number: string; active: boolean; expiresOn: string | null }[] } | null = null;
  if (f.inspectionId) {
    const insp = await db
      .selectFrom("inspections as i")
      .innerJoin("users as u", "u.id", "i.technicianUserId")
      .select(["i.completedAt", "i.technicianUserId", "u.name"])
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
    technician = { userId: insp.technicianUserId, name: insp.name, credentials };
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
  return problems;
}

async function documentsFor(db: Executor, f: PackageFiling): Promise<PackageDocument[]> {
  if (f.kind === "inspection_report") {
    const report = f.inspectionId ? await latestAuthorityReport(db, f.organizationId, f.inspectionId) : null;
    if (!report) throw new PackageNotReady("The authority report has not been made yet");
    return [
      {
        role: "inspection_report",
        filename: `inspection-report-v${report.version}.pdf`,
        storageKey: report.storageKey,
        contentType: report.contentType,
        sha256: report.sha256,
        byteSize: report.byteSize,
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
    const pdf = await renderCoverSheet({ title: sheet.title, formReference: sheet.formReference, fields, instructions: sheet.instructions ?? null, packageReference: id, generatedAt: at.toISOString() });
    const storageKey = `${f.organizationId}/filings/${f.id}/package-${id}/cover-sheet.pdf`;
    await ctx.store.put(storageKey, pdf, "application/pdf");
    documents.unshift({ role: "cover_sheet", filename: "cover-sheet.pdf", storageKey, contentType: "application/pdf", sha256: sha256Hex(pdf), byteSize: pdf.length, sourceId: null, sourceVersion: null });
  }
  const method: SubmissionMethod = f.submissionMethod ?? rules.submission.method;
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
export function contractDeadline(rules: RulesetRules, previousEndOn: string | null): { deadlineOn: string | null; basis: string } {
  const days = rules.contracts?.renewalDaysBeforePreviousEnd ?? null;
  if (previousEndOn && days !== null) {
    return { deadlineOn: addDays(previousEndOn, -days), basis: `${days} days before the previous contract ends on ${previousEndOn} (30 TAC 285.7)` };
  }
  return { deadlineOn: null, basis: "No deadline is published for a first contract; file it promptly" };
}
