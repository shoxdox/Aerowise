import { createHash } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import { CREDENTIAL_LABELS, dateInZone, LAB_ANALYTE_LABELS, labResultsOverLimit, labTestRequirement, validateInspection, type CredentialKind, type LabAnalyte, type LabTestRule, type InspectionValues, type ReportedResponse, type RulesetRules, type TemplateDefinition } from "@aerowise/domain";
import { layoutSections, renderReport, reportIssues, reportSections, type Audience, type ReportSnapshot } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import type { Transaction } from "kysely";

// Inspection reports: the customer and authority copies made when an inspection is
// completed, and corrected versions made later. Every version is a new immutable row;
// nothing here ever changes a report that exists.

type Executor = Database | Transaction<DB>;

const AUDIENCES: Audience[] = ["customer", "authority"];

const joinAddress = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ") || null;
const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * The images a stored snapshot draws: the company logo it names, and on the customer copy
 * its photos. Used to redraw a stored report (the signed copy) exactly as it was made.
 */
export async function snapshotImages(store: ObjectStore, s: ReportSnapshot): Promise<Map<string, Buffer>> {
  const keys = [s.provider.logoKey, ...(s.audience === "customer" ? s.photos.map((p) => p.storageKey) : [])].filter((k): k is string => !!k);
  const images = new Map<string, Buffer>();
  for (const key of keys) {
    const data = await store.get(key);
    if (data) images.set(key, data);
  }
  return images;
}

/** A report problem the office has to fix, as opposed to a crash. */
export class ReportCorrectionError extends Error {}

async function loadInspection(db: Executor, organizationId: string, inspectionId: string) {
  const insp = await db
    .selectFrom("inspections as i")
    .innerJoin("organizations as org", "org.id", "i.organizationId")
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "i.siteId").onRef("s.organizationId", "=", "i.organizationId"))
    .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"))
    .innerJoin("users as u", "u.id", "i.technicianUserId")
    .innerJoin("memberships as m", (j) => j.onRef("m.userId", "=", "i.technicianUserId").onRef("m.organizationId", "=", "i.organizationId"))
    .innerJoin("inspectionTemplates as t", "t.id", "i.templateId")
    .select([
      "i.id",
      "i.siteId",
      "i.technicianUserId",
      "i.status",
      "i.validationStatus",
      "i.overrideReason",
      "i.arrivedAt",
      "i.completedAt",
      "i.arrivalLat",
      "i.arrivalLng",
      "i.completionLat",
      "i.completionLng",
      "i.accessIssue",
      "org.name as orgName",
      "org.phone as orgPhone",
      "org.email as orgEmail",
      "org.addressLine1 as orgAddress1",
      "org.city as orgCity",
      "org.state as orgState",
      "org.postalCode as orgPostal",
      "org.timezone",
      "org.responsibleCredentialId",
      "org.logoStorageKey",
      "s.addressLine1",
      "s.addressLine2",
      "s.city",
      "s.state",
      "s.postalCode",
      "s.county",
      "s.permitNumber",
      "c.id as customerId",
      "c.displayName as customerName",
      "u.name as technicianName",
      "m.technicianLicense",
      "t.id as templateId",
      "t.name as templateName",
      "t.version as templateVersion",
      "t.definition",
    ])
    .where("i.organizationId", "=", organizationId)
    .where("i.id", "=", inspectionId)
    .executeTakeFirst();
  if (!insp) throw new Error(`inspection ${inspectionId} not found`);
  if (insp.status !== "completed" || !insp.completedAt) throw new Error(`inspection ${inspectionId} is not completed`);
  return insp as typeof insp & { completedAt: Date };
}

/**
 * What the authority report says about owner complaints and monitoring notices, and which
 * requests still need a person to look at them.
 *
 * The reporting period runs from the previous completed inspection (or, for a site's first
 * report, from the day before the contract in force started) up to this inspection.
 * - `reported`: requests in the period that the office classified as an owner complaint or
 *   monitoring notice, plus earlier ones still unresolved (no response yet, or a response
 *   that left the problem outstanding), carried forward until they are resolved.
 * - `unreviewed`: requests in the period nobody has classified yet. Only these hold a
 *   filing. A missing or unfinished response does not: it is reported as outstanding
 *   (30 TAC 285.7 asks for "any responses to owner complaints", not finished repairs).
 * Requests from before the period are not asked about again.
 */
export async function responsesForInspection(db: Executor, organizationId: string, inspectionId: string) {
  const insp = await db
    .selectFrom("inspections")
    .select(["siteId", "completedAt"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", inspectionId)
    .executeTakeFirstOrThrow();
  if (!insp.completedAt) return { reported: [] as ReportedResponse[], unreviewed: [] as { id: string; receivedAt: string; description: string }[], since: null as string | null };
  const completedAt = insp.completedAt;
  const previous = await db
    .selectFrom("inspections")
    .select("completedAt")
    .where("organizationId", "=", organizationId)
    .where("siteId", "=", insp.siteId)
    .where("status", "=", "completed")
    .where("completedAt", "<", completedAt)
    .orderBy("completedAt", "desc")
    .limit(1)
    .executeTakeFirst();
  let since: Date | null = previous?.completedAt ?? null;
  if (!since) {
    const day = completedAt.toISOString().slice(0, 10);
    const contract = await db
      .selectFrom("contracts")
      .select("startOn")
      .where("organizationId", "=", organizationId)
      .where("siteId", "=", insp.siteId)
      .where("startOn", "<=", day)
      .where("endOn", ">=", day)
      .orderBy("startOn", "desc")
      .executeTakeFirst();
    // A day early, so no time zone can push a request on the start date out of the period.
    if (contract) since = new Date(new Date(`${contract.startOn}T00:00:00Z`).getTime() - 86_400_000);
  }
  const rows = await db
    .selectFrom("serviceRequests")
    .select(["id", "description", "receivedAt", "reportClassification", "responseAction", "respondedAt", "responseOutcome"])
    .where("organizationId", "=", organizationId)
    .where("siteId", "=", insp.siteId)
    .where("receivedAt", "<=", completedAt)
    .orderBy("receivedAt")
    .orderBy("id")
    .execute();
  const inPeriod = (r: (typeof rows)[number]) => !since || r.receivedAt > since;
  const reportable = (r: (typeof rows)[number]) => r.reportClassification === "owner_complaint" || r.reportClassification === "monitoring_notice";
  // Resolved as of this inspection: a response recorded by then that closed the problem.
  const resolvedBy = (r: (typeof rows)[number]) => r.responseOutcome === "resolved" && r.respondedAt !== null && r.respondedAt <= completedAt;
  return {
    reported: rows
      .filter((r) => reportable(r) && (inPeriod(r) || !resolvedBy(r)))
      .map(
        (r): ReportedResponse => ({
          requestId: r.id,
          classification: r.reportClassification as ReportedResponse["classification"],
          receivedAt: r.receivedAt.toISOString(),
          description: r.description,
          responseAction: r.responseAction,
          respondedAt: r.respondedAt?.toISOString() ?? null,
          outcome: r.responseAction ? (r.responseOutcome ?? "outstanding") : null,
          carriedOver: !inPeriod(r),
        }),
      ),
    unreviewed: rows.filter((r) => inPeriod(r) && r.reportClassification === null).map((r) => ({ id: r.id, receivedAt: r.receivedAt.toISOString(), description: r.description })),
    since: since?.toISOString() ?? null,
  };
}

/** Licenses and registrations a person holds in an organization, labelled by kind. */
async function credentialsOf(db: Executor, organizationId: string, userId: string) {
  const rows = await db
    .selectFrom("providerCredentials")
    .select(["kind", "number"])
    .where("organizationId", "=", organizationId)
    .where("userId", "=", userId)
    .where("active", "=", true)
    .orderBy("kind")
    .execute();
  return rows.map((r) => ({ kind: r.kind, label: CREDENTIAL_LABELS[r.kind as CredentialKind], number: r.number }));
}

async function responsibleProvider(db: Executor, organizationId: string, credentialId: string | null) {
  if (!credentialId) return null;
  const c = await db
    .selectFrom("providerCredentials")
    .select(["holderName", "kind", "number"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", credentialId)
    .executeTakeFirst();
  return c ? { name: c.holderName, label: CREDENTIAL_LABELS[c.kind as CredentialKind], number: c.number } : null;
}

/**
 * The rules the inspection's filing recorded, or null when there is no filing yet. The
 * authority copy is laid out and filled from these, not from whatever is in force later.
 */
async function filingRules(db: Executor, organizationId: string, inspectionId: string) {
  const row = await db
    .selectFrom("filings as f")
    .innerJoin("jurisdictionRulesets as r", "r.id", "f.rulesetId")
    .innerJoin("jurisdictions as j", "j.id", "r.jurisdictionId")
    .select(["r.rules", "j.key"])
    .where("f.organizationId", "=", organizationId)
    .where("f.inspectionId", "=", inspectionId)
    .executeTakeFirst();
  return row ? { rules: row.rules as RulesetRules, jurisdictionKey: row.key } : null;
}

/**
 * The "Lab results" section of the authority copy, only where the ruleset asks for lab
 * results on the report (Justin, 2026-10-05): the latest sample on record by the day of
 * the inspection, each result against the authority's limit.
 */
async function labResultsSection(db: Executor, organizationId: string, siteId: string, rule: LabTestRule, onOrBefore: string): Promise<ReportSnapshot["sections"][number]> {
  const test = await db
    .selectFrom("labTests as t")
    .select(["t.sampledOn", "t.labName", "t.labReference", "t.results"])
    .where("t.organizationId", "=", organizationId)
    .where("t.siteId", "=", siteId)
    .where("t.sampledOn", "<=", onOrBefore)
    .where((w) => w.not(w.exists(w.selectFrom("labTests as r").select("r.id").whereRef("r.organizationId", "=", "t.organizationId").whereRef("r.replacesId", "=", "t.id"))))
    .orderBy("t.sampledOn", "desc")
    .orderBy("t.recordedAt", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!test) return { title: "Lab results", rows: [{ label: "Latest sample", value: "None on record", failed: true }] };
  const results = test.results as { analyte: LabAnalyte; value: number }[];
  const over = labResultsOverLimit(rule, results);
  return {
    title: "Lab results",
    rows: [
      { label: "Sampled on", value: String(test.sampledOn), failed: false },
      { label: "Lab", value: [test.labName, test.labReference].filter(Boolean).join(", "), failed: false },
      ...rule.analytes.map((a) => {
        const r = results.find((x) => x.analyte === a);
        const limit = rule.limits?.[a];
        return {
          label: `${LAB_ANALYTE_LABELS[a]} (mg/L)`,
          value: r ? `${r.value}${limit !== undefined ? ` (limit ${limit})` : ""}` : "Not tested",
          failed: !r || over.some((o) => o.analyte === a),
        };
      }),
    ],
  };
}

interface SnapshotOptions {
  reportId: string;
  now: Date;
  amendments?: InspectionValues;
  correction?: ReportSnapshot["correction"];
}

async function buildSnapshot(db: Executor, store: ObjectStore, organizationId: string, inspectionId: string, audience: Audience, opts: SnapshotOptions) {
  const insp = await loadInspection(db, organizationId, inspectionId);
  const [values, issues, photos, system, credentials, provider, responses, filed] = await Promise.all([
    db.selectFrom("inspectionValues").select(["fieldKey", "valueJson"]).where("organizationId", "=", organizationId).where("inspectionId", "=", inspectionId).execute(),
    db.selectFrom("issues").select(["type", "severity", "description"]).where("organizationId", "=", organizationId).where("inspectionId", "=", inspectionId).orderBy("createdAt").execute(),
    db
      .selectFrom("attachments")
      .select(["photoKey", "storageKey", "contentType", "capturedAt"])
      .where("organizationId", "=", organizationId)
      .where("inspectionId", "=", inspectionId)
      .orderBy("createdAt")
      .execute(),
    db
      .selectFrom("wastewaterSystems")
      .select(["manufacturer", "model", "serial", "disposalType", "chlorinationMethod"])
      .where("organizationId", "=", organizationId)
      .where("siteId", "=", insp.siteId)
      .where("active", "=", true)
      .orderBy("createdAt")
      .limit(1)
      .executeTakeFirst(),
    credentialsOf(db, organizationId, insp.technicianUserId),
    responsibleProvider(db, organizationId, insp.responsibleCredentialId),
    audience === "authority" ? responsesForInspection(db, organizationId, inspectionId) : null,
    audience === "authority" ? filingRules(db, organizationId, inspectionId) : null,
  ]);
  const layout = filed?.rules.report ? { rule: filed.rules.report, jurisdictionKey: filed.jurisdictionKey, rulesetVersion: filed.rules.version } : null;
  const site = filed?.rules.labTests?.onReport
    ? await db.selectFrom("sites").select("customerType").where("organizationId", "=", organizationId).where("id", "=", insp.siteId).executeTakeFirstOrThrow()
    : null;
  const labRule = filed && site ? labTestRequirement(filed.rules, site.customerType) : null;
  const labSection = labRule ? await labResultsSection(db, organizationId, insp.siteId, labRule, dateInZone(insp.completedAt, insp.timezone)) : null;
  const def = insp.definition as TemplateDefinition;
  const answers: InspectionValues = { ...Object.fromEntries(values.map((v) => [v.fieldKey, v.valueJson as InspectionValues[string]])), ...(opts.amendments ?? {}) };
  const photoLabel = (key: string) => def.photos.find((p) => p.key === key)?.label ?? key;
  const images = new Map<string, Buffer>();
  if (insp.logoStorageKey) {
    const logo = await store.get(insp.logoStorageKey);
    if (logo) images.set(insp.logoStorageKey, logo);
  }
  if (audience === "customer") {
    for (const p of photos) {
      const data = await store.get(p.storageKey);
      if (data) images.set(p.storageKey, data);
    }
  }
  const snapshot: ReportSnapshot = {
    audience,
    reportId: opts.reportId,
    generatedAt: opts.now.toISOString(),
    timezone: insp.timezone,
    provider: {
      name: insp.orgName,
      phone: insp.orgPhone,
      email: insp.orgEmail,
      address: joinAddress([insp.orgAddress1, insp.orgCity, [insp.orgState, insp.orgPostal].filter(Boolean).join(" ")]),
      logoKey: insp.logoStorageKey,
    },
    customer: { name: insp.customerName },
    site: {
      address: joinAddress([insp.addressLine1, insp.addressLine2, insp.city, [insp.state, insp.postalCode].filter(Boolean).join(" ")])!,
      county: insp.county,
      permitNumber: insp.permitNumber,
    },
    system: system ?? null,
    technician: { name: insp.technicianName, license: insp.technicianLicense, credentials },
    responsibleProvider: audience === "authority" ? provider : null,
    responses: responses?.reported.map(({ requestId: _r, ...rest }) => rest),
    correction: opts.correction ?? null,
    inspection: {
      id: insp.id,
      arrivedAt: insp.arrivedAt.toISOString(),
      completedAt: insp.completedAt.toISOString(),
      arrivalGps: insp.arrivalLat !== null && insp.arrivalLng !== null ? { lat: insp.arrivalLat, lng: insp.arrivalLng } : null,
      completionGps: insp.completionLat !== null && insp.completionLng !== null ? { lat: insp.completionLat, lng: insp.completionLng } : null,
      validationStatus: insp.validationStatus,
      overrideReason: insp.overrideReason,
      accessIssue: insp.accessIssue,
    },
    template: { id: insp.templateId, name: insp.templateName, version: insp.templateVersion },
    layout: layout ? { title: layout.rule.title, formReference: layout.rule.formReference, jurisdictionKey: layout.jurisdictionKey, rulesetVersion: layout.rulesetVersion } : null,
    sections: [...(layout ? layoutSections(def, answers, layout.rule) : reportSections(def, answers, audience)), ...(labSection ? [labSection] : [])],
    issues: reportIssues(issues, audience),
    // Photos go on the customer copy; the authority copy is the form itself.
    photos: audience === "customer" ? photos.map((p) => ({ label: photoLabel(p.photoKey), storageKey: p.storageKey, contentType: p.contentType, capturedAt: p.capturedAt?.toISOString() ?? null })) : [],
  };
  return { insp, snapshot, images, def, answers, responseIds: responses?.reported.map((r) => r.requestId) ?? [] };
}

/** Called in the transaction that stores a new report, for follow-ups like texts. */
export type OnReportCreated = (trx: Transaction<DB>, report: { id: string; audience: Audience; customerId: string; siteId: string; version: number }) => Promise<void>;

/**
 * Makes the customer and authority PDFs for a completed inspection. Safe to run again:
 * a copy that already exists is left alone, so a retry after a crash only makes what is
 * missing.
 */
export async function generateReports(db: Database, store: ObjectStore, organizationId: string, inspectionId: string, now: Date = new Date(), onCreated?: OnReportCreated) {
  await loadInspection(db, organizationId, inspectionId);
  const existing = await db.selectFrom("reports").select("audience").where("organizationId", "=", organizationId).where("inspectionId", "=", inspectionId).execute();
  const missing = AUDIENCES.filter((a) => !existing.some((e) => e.audience === a));
  const created: { id: string; audience: Audience }[] = [];
  for (const audience of missing) {
    const reportId = crypto.randomUUID();
    const { insp, snapshot, images } = await buildSnapshot(db, store, organizationId, inspectionId, audience, { reportId, now });
    const pdf = await renderReport(snapshot, images);
    const storageKey = `${organizationId}/reports/${inspectionId}/${audience}-v1-${reportId}.pdf`;
    await store.put(storageKey, pdf, "application/pdf");
    const sha256 = sha256Hex(pdf);
    await db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("reports")
        .values({ id: reportId, organizationId, inspectionId, siteId: insp.siteId, audience, templateId: insp.templateId, snapshot: JSON.stringify(snapshot), storageKey, byteSize: pdf.length, sha256 })
        .onConflict((oc) => oc.columns(["organizationId", "inspectionId", "audience", "version"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      // Another worker made this copy first; keep theirs.
      if (!inserted) return;
      await trx
        .insertInto("complianceEvents")
        .values({
          organizationId,
          siteId: insp.siteId,
          eventType: "report_generated",
          occurredAt: now,
          actorUserId: null,
          inspectionId,
          reportId,
          summary: audience === "customer" ? "Customer report generated" : "Authority report generated",
          details: JSON.stringify({ audience, sha256 }),
        })
        .execute();
      await onCreated?.(trx, { id: reportId, audience, customerId: insp.customerId, siteId: insp.siteId, version: 1 });
      created.push({ id: reportId, audience });
    });
  }
  return created;
}

/**
 * Makes the next version of one copy of an inspection's report, linked to the version it
 * replaces, with the reason printed on it. `amendments` correct individual answers; the
 * merged answers must still pass the template's checks. Earlier versions are untouched.
 */
export async function writeReportVersion(
  db: Database,
  store: ObjectStore,
  args: { organizationId: string; inspectionId: string; audience: Audience; reason: string; amendments?: InspectionValues; actorUserId: string | null; now: Date },
) {
  const latest = await db
    .selectFrom("reports")
    .select(["id", "version", "snapshot"])
    .where("organizationId", "=", args.organizationId)
    .where("inspectionId", "=", args.inspectionId)
    .where("audience", "=", args.audience)
    .orderBy("version", "desc")
    .executeTakeFirst();
  if (!latest) throw new ReportCorrectionError("This inspection has no report to correct yet");
  // Corrections build on each other: earlier amendments stay unless amended again.
  const amendments: InspectionValues = { ...amendmentsOf(latest.snapshot), ...(args.amendments ?? {}) };
  const reportId = crypto.randomUUID();
  const version = latest.version + 1;
  const amendedFields = Object.keys(args.amendments ?? {});
  const { insp, snapshot, images, def, answers } = await buildSnapshot(db, store, args.organizationId, args.inspectionId, args.audience, {
    reportId,
    now: args.now,
    amendments,
    correction: { version, supersedesReportId: latest.id, reason: args.reason, amendedFields },
  });
  const unknown = amendedFields.filter((k) => !def.fields.some((f) => f.key === k));
  if (unknown.length) throw new ReportCorrectionError(`Not a field on this inspection's form: ${unknown.join(", ")}`);
  if (amendedFields.length) {
    const photoCounts = Object.fromEntries(def.photos.map((p) => [p.key, Number.MAX_SAFE_INTEGER]));
    const problems = validateInspection(def, answers, photoCounts).filter((p) => amendedFields.includes(p.key));
    if (problems.length) throw new ReportCorrectionError(problems.map((p) => p.message).join("; "));
  }
  // Kept on the snapshot so the next correction, and the filing checks, see them. Stored as
  // a list: jsonb object keys come back camelCased by the database client, field keys would not.
  snapshot.correction!.amendments = Object.entries(amendments).map(([key, value]) => ({ key, value }));
  const pdf = await renderReport(snapshot, images);
  const storageKey = `${args.organizationId}/reports/${args.inspectionId}/${args.audience}-v${version}-${reportId}.pdf`;
  await store.put(storageKey, pdf, "application/pdf");
  const sha256 = sha256Hex(pdf);
  await db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("reports")
      .values({
        id: reportId,
        organizationId: args.organizationId,
        inspectionId: args.inspectionId,
        siteId: insp.siteId,
        audience: args.audience,
        version,
        templateId: insp.templateId,
        snapshot: JSON.stringify(snapshot),
        storageKey,
        byteSize: pdf.length,
        sha256,
        supersedesReportId: latest.id,
        correctionReason: args.reason,
        correctedBy: args.actorUserId,
      })
      .onConflict((oc) => oc.columns(["organizationId", "inspectionId", "audience", "version"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!inserted) throw new ReportCorrectionError("Someone else corrected this report at the same time; reload and try again");
    await trx
      .insertInto("complianceEvents")
      .values({
        organizationId: args.organizationId,
        siteId: insp.siteId,
        eventType: "report_corrected",
        occurredAt: args.now,
        actorUserId: args.actorUserId,
        inspectionId: args.inspectionId,
        reportId,
        summary: `${args.audience === "customer" ? "Customer" : "Authority"} report corrected (version ${version}): ${args.reason.slice(0, 200)}`,
        details: JSON.stringify({ audience: args.audience, version, supersedesReportId: latest.id, amendedFields, sha256 }),
      })
      .execute();
  });
  return { id: reportId, version, supersedesReportId: latest.id };
}

/** The responses printed on the latest authority report, by service request id order. */
export async function latestAuthorityReport(db: Executor, organizationId: string, inspectionId: string) {
  return (
    (await db
      .selectFrom("reports")
      .select(["id", "version", "snapshot", "storageKey", "contentType", "sha256", "byteSize"])
      .where("organizationId", "=", organizationId)
      .where("inspectionId", "=", inspectionId)
      .where("audience", "=", "authority")
      .orderBy("version", "desc")
      .executeTakeFirst()) ?? null
  );
}

/** Two lists of responses say the same thing (what the authority would read). */
export function sameResponses(a: ReportSnapshot["responses"] | undefined, b: ReportSnapshot["responses"] | undefined) {
  // Field by field: jsonb does not keep key order, so the stored copy cannot be compared as text.
  const flat = (rs: ReportSnapshot["responses"] | undefined) =>
    JSON.stringify((rs ?? []).map((r) => [r.classification, r.receivedAt, r.description, r.responseAction, r.respondedAt, r.outcome ?? null, r.carriedOver ?? false]));
  return flat(a) === flat(b);
}

/** Answers on the latest authority report: the inspection's, with any corrections over them. */
export function amendmentsOf(snapshot: unknown): InspectionValues {
  const list = (snapshot as ReportSnapshot | null)?.correction?.amendments ?? [];
  return Object.fromEntries(list.map((a) => [a.key, a.value as InspectionValues[string]]));
}

/** Rebuilds what the authority copy would say now, without storing anything. */
export async function currentAuthorityResponses(db: Executor, organizationId: string, inspectionId: string) {
  const r = await responsesForInspection(db, organizationId, inspectionId);
  return r.reported.map(({ requestId: _r, ...rest }) => rest);
}
