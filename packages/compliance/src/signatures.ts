import { createHash } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import { CREDENTIAL_LABELS, credentialProblems, INSPECTING_CREDENTIALS, type CredentialKind, type RulesetRules } from "@aerowise/domain";
import { renderReport, type ReportSnapshot } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import type { Transaction } from "kysely";
import { latestAuthorityReport, snapshotImages } from "./reports.ts";
import { dateInZone } from "./rulesets.ts";

type Executor = Database | Transaction<DB>;

export class SignatureError extends Error {}

const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * 30 TAC 285.7(b)(3): the maintenance provider signs every maintenance report. It is a
 * statewide rule, so it holds for every Texas authority, the fictional demo county included:
 * the demo shows the same sign-then-send a real provider works with.
 */
export function providerSignatureRequired(rules: RulesetRules) {
  return rules.jurisdiction.state === "TX";
}

/** Whether this person has an active TCEQ maintenance provider license on file with the organization. */
export async function holdsProviderLicense(db: Executor, organizationId: string, userId: string, onDate: string) {
  const mine = await db
    .selectFrom("providerCredentials")
    .select(["active", "expiresOn", "number"])
    .where("organizationId", "=", organizationId)
    .where("userId", "=", userId)
    .where("kind", "=", "tceq_maintenance_provider")
    .execute();
  return mine.some((c) => credentialProblems(c, onDate).length === 0);
}

/** The signature on one report version, if it has been signed. */
export async function reportSignature(db: Executor, organizationId: string, reportId: string) {
  return (
    (await db
      .selectFrom("reportSignatures as rs")
      .innerJoin("users as u", "u.id", "rs.signedBy")
      .innerJoin("providerCredentials as c", (j) => j.onRef("c.id", "=", "rs.credentialId").onRef("c.organizationId", "=", "rs.organizationId"))
      .select(["rs.id", "rs.reportId", "rs.signedBy", "u.name as signedByName", "rs.typedName", "rs.statement", "rs.signedAt", "rs.reportSha256", "rs.storageKey", "rs.sha256", "rs.byteSize", "rs.delegationNote", "rs.onBehalfOfCredentialId", "c.number as licenseNumber"])
      .where("rs.organizationId", "=", organizationId)
      .where("rs.reportId", "=", reportId)
      .executeTakeFirst()) ?? null
  );
}

/** The latest customer copy of an inspection's report, if one was made. */
async function latestCustomerReport(db: Executor, organizationId: string, inspectionId: string) {
  return (
    (await db
      .selectFrom("reports")
      .select(["id", "version", "snapshot", "sha256"])
      .where("organizationId", "=", organizationId)
      .where("inspectionId", "=", inspectionId)
      .where("audience", "=", "customer")
      .orderBy("version", "desc")
      .executeTakeFirst()) ?? null
  );
}

/**
 * The maintenance provider who signs this inspection's reports by default: the MP named on
 * the contract the visit belongs to, else the organization's responsible maintenance
 * provider. Null when neither is recorded.
 */
export async function contractProvider(db: Executor, organizationId: string, inspectionId: string) {
  const row = await db
    .selectFrom("inspections as i")
    .innerJoin("organizations as org", "org.id", "i.organizationId")
    .leftJoin("jobs as j", (j) => j.onRef("j.id", "=", "i.jobId").onRef("j.organizationId", "=", "i.organizationId").on("j.type", "=", "inspection"))
    .leftJoin("serviceObligations as o", (j) => j.onRef("o.id", "=", "j.obligationId").onRef("o.organizationId", "=", "j.organizationId"))
    .leftJoin("contracts as c", (j) => j.onRef("c.id", "=", "o.contractId").onRef("c.organizationId", "=", "o.organizationId"))
    .select(["c.providerCredentialId", "org.responsibleCredentialId"])
    .where("i.organizationId", "=", organizationId)
    .where("i.id", "=", inspectionId)
    .executeTakeFirst();
  const credentialId = row?.providerCredentialId ?? row?.responsibleCredentialId ?? null;
  if (!credentialId) return null;
  const c = await db
    .selectFrom("providerCredentials")
    .select(["id", "userId", "holderName", "number"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", credentialId)
    .executeTakeFirstOrThrow();
  return { credentialId: c.id, userId: c.userId, holderName: c.holderName, number: c.number, source: row?.providerCredentialId ? ("contract" as const) : ("organization" as const) };
}

const MIN_DELEGATION = 20;
const namedAs = (source: "contract" | "organization") => (source === "contract" ? "the maintenance provider named on this site's contract" : "the organization's responsible maintenance provider");

/**
 * What signing the latest authority report of an inspection would say, and what stops
 * this person from signing it now. Nothing is stored.
 */
export async function signingPreview(db: Executor, args: { organizationId: string; inspectionId: string; userId: string; at: Date }) {
  const report = await latestAuthorityReport(db, args.organizationId, args.inspectionId);
  if (!report) throw new SignatureError("This inspection has no authority report yet");
  const snapshot = report.snapshot as ReportSnapshot;
  const insp = await db
    .selectFrom("inspections as i")
    .innerJoin("organizations as o", "o.id", "i.organizationId")
    .select(["i.technicianUserId", "i.completedAt", "o.name as orgName", "o.timezone"])
    .where("i.organizationId", "=", args.organizationId)
    .where("i.id", "=", args.inspectionId)
    .executeTakeFirstOrThrow();
  const today = dateInZone(args.at, insp.timezone);
  const inspectedOn = dateInZone(insp.completedAt!, insp.timezone);
  const [mine, techCredentials, existing, provider] = await Promise.all([
    db
      .selectFrom("providerCredentials")
      .select(["id", "holderName", "number", "active", "expiresOn", "verifiedOn"])
      .where("organizationId", "=", args.organizationId)
      .where("userId", "=", args.userId)
      .where("kind", "=", "tceq_maintenance_provider")
      .orderBy("createdAt")
      .execute(),
    db
      .selectFrom("providerCredentials")
      .select(["kind", "number", "active", "expiresOn"])
      .where("organizationId", "=", args.organizationId)
      .where("userId", "=", insp.technicianUserId)
      .execute(),
    reportSignature(db, args.organizationId, report.id),
    contractProvider(db, args.organizationId, args.inspectionId),
  ]);
  const problems: string[] = [];
  const license = mine.find((c) => !credentialProblems(c, today).length && c.verifiedOn) ?? null;
  if (!mine.length) problems.push("Only a TCEQ licensed maintenance provider (MP) can sign maintenance reports, and no MP license is on file for you (Settings, Credentials)");
  else if (!license) {
    const c = mine[0]!;
    const why = credentialProblems(c, today);
    problems.push(why.length ? `Your MP license ${c.number} ${why[0]}` : `Your MP license ${c.number} has not been checked against TCEQ's license search yet (Settings, Credentials)`);
  }
  let performedBy: string;
  if (insp.technicianUserId === args.userId) {
    performedBy = `I performed the inspection on ${inspectedOn}.`;
  } else {
    // Someone else inspected: they must have been licensed or registered that day, and the
    // signer attests to employing and directly supervising them (285.7(b)(1), 285.2).
    const usable = techCredentials.find((c) => INSPECTING_CREDENTIALS.includes(c.kind as CredentialKind) && !credentialProblems(c, inspectedOn).length);
    if (!usable) problems.push(`${snapshot.technician.name} had no active TCEQ maintenance technician registration or MP license on record for ${inspectedOn}, so the report cannot be signed for that inspection`);
    performedBy = usable
      ? `The inspection was performed on ${inspectedOn} by ${snapshot.technician.name} (${CREDENTIAL_LABELS[usable.kind as CredentialKind]} ${usable.number}), who is employed by ${insp.orgName} and works under my direct supervision.`
      : `The inspection was performed on ${inspectedOn} by ${snapshot.technician.name}.`;
  }
  if (existing) problems.push(`Version ${report.version} of this report was already signed by ${existing.signedByName}`);
  if (!provider) problems.push("No maintenance provider is named for this site: record the MP on the site's contract, or set the organization's responsible MP (Settings, Credentials)");
  const holder = license ?? mine[0] ?? null;
  // The MP named for the site signs by default. Anyone else signs for them, and only with a
  // documented delegation and supervision, which the statement quotes.
  const delegatedFrom = provider && holder && provider.credentialId !== holder.id && provider.userId !== args.userId ? provider : null;
  const statementFor = (version: number, delegationNote?: string | null) =>
    [
      `I, ${holder?.holderName ?? "(name)"}, TCEQ licensed maintenance provider ${holder?.number ?? "(license number)"}, have reviewed this maintenance report (version ${version}) for ${snapshot.site.address} and sign it as the maintenance provider, as 30 TAC 285.7(b)(3) requires.`,
      performedBy,
      delegatedFrom
        ? `I sign for ${delegatedFrom.holderName} (MP ${delegatedFrom.number}), ${namedAs(delegatedFrom.source)}, under this documented delegation and supervision: ${delegationNote?.trim() || "(describe the delegation)"}`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
  return { report, snapshot, license, holderName: holder?.holderName ?? null, statement: statementFor(report.version), statementFor, problems, existing, provider, delegatedFrom };
}

/**
 * Whether this inspection's reports must carry the maintenance provider's signature before
 * they go to anyone. 30 TAC 285.7(b)(3) is statewide, so the answer is yes for any Texas
 * authority, and yes while no authority is recorded yet.
 */
export async function signatureRequiredForInspection(db: Executor, organizationId: string, inspectionId: string) {
  const row = await db
    .selectFrom("filings as f")
    .leftJoin("jurisdictionRulesets as r", "r.id", "f.rulesetId")
    .select(["f.rulesetId", "r.rules"])
    .where("f.organizationId", "=", organizationId)
    .where("f.inspectionId", "=", inspectionId)
    .executeTakeFirst();
  if (row?.rulesetId && row.rules) return providerSignatureRequired(row.rules as RulesetRules);
  return true;
}

/**
 * The copy of a report to give the customer: the signed one when it has been signed. When
 * a signature is required and missing, `ready` is false and it must not be delivered.
 */
export async function customerCopy(db: Executor, organizationId: string, reportId: string) {
  const r = await db
    .selectFrom("reports")
    .select(["id", "inspectionId", "audience", "storageKey", "sha256", "byteSize"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", reportId)
    .executeTakeFirst();
  if (!r) return null;
  const [signature, required] = await Promise.all([reportSignature(db, organizationId, r.id), signatureRequiredForInspection(db, organizationId, r.inspectionId)]);
  const copy = signature ? { storageKey: signature.storageKey, sha256: signature.sha256, byteSize: signature.byteSize } : { storageKey: r.storageKey, sha256: r.sha256, byteSize: r.byteSize };
  return { ...copy, reportId: r.id, inspectionId: r.inspectionId, audience: r.audience, signed: Boolean(signature), required, ready: Boolean(signature) || !required };
}

export const UNSIGNED_CUSTOMER_COPY = "The maintenance provider has not signed this report yet (30 TAC 285.7(b)(3)), so it cannot go to the customer";

/**
 * Signs the latest authority report of an inspection, and its latest customer copy, as the
 * signed-in licensed maintenance provider. Stores a signed copy of each (the report with a
 * signature block) next to the unsigned one; the filing sends the signed authority copy and
 * the customer gets the signed customer copy. A later version (a correction, or redrawn
 * complaint responses) needs its own signature.
 */
export async function signAuthorityReport(
  ctx: { db: Database; store: ObjectStore },
  args: { organizationId: string; inspectionId: string; userId: string; typedName: string; delegationNote?: string | null; at: Date },
) {
  const preview = await signingPreview(ctx.db, args);
  if (preview.problems.length) throw new SignatureError(preview.problems.join("; "));
  const license = preview.license!;
  if (!sameName(args.typedName, license.holderName)) throw new SignatureError(`Type your name as it appears on your MP license: ${license.holderName}`);
  const from = preview.delegatedFrom;
  const delegationNote = from ? (args.delegationNote?.trim() ?? "") : null;
  if (from && delegationNote!.length < MIN_DELEGATION) {
    throw new SignatureError(
      `You are not ${namedAs(from.source)} (${from.holderName}, MP ${from.number}). To sign for them, describe the documented delegation and your supervision (at least ${MIN_DELEGATION} characters)`,
    );
  }
  // The customer copy is signed with the authority copy, unless that version already was.
  const customer = await latestCustomerReport(ctx.db, args.organizationId, args.inspectionId);
  const targets = [{ report: preview.report, snapshot: preview.snapshot, audience: "authority" }];
  if (customer && !(await reportSignature(ctx.db, args.organizationId, customer.id))) targets.push({ report: customer as typeof preview.report, snapshot: customer.snapshot as ReportSnapshot, audience: "customer" });
  type Signed = { id: string; report: { id: string; version: number; sha256: string }; audience: string; signature: NonNullable<ReportSnapshot["signature"]>; storageKey: string; sha256: string; byteSize: number };
  const signed: Signed[] = [];
  for (const t of targets) {
    const signature: NonNullable<ReportSnapshot["signature"]> = {
      name: license.holderName,
      licenseLabel: CREDENTIAL_LABELS.tceq_maintenance_provider,
      licenseNumber: license.number,
      typedName: args.typedName.trim(),
      statement: preview.statementFor(t.report.version, delegationNote),
      signedAt: args.at.toISOString(),
      reportVersion: t.report.version,
      reportSha256: t.report.sha256,
    };
    const pdf = await renderReport({ ...t.snapshot, signature }, await snapshotImages(ctx.store, t.snapshot));
    const id = crypto.randomUUID();
    const storageKey = `${args.organizationId}/reports/${args.inspectionId}/${t.audience}-v${t.report.version}-signed-${id}.pdf`;
    await ctx.store.put(storageKey, pdf, "application/pdf");
    signed.push({ id, report: t.report, audience: t.audience, signature, storageKey, sha256: sha256Hex(pdf), byteSize: pdf.length });
  }
  const { id, sha256 } = signed[0]!;
  await ctx.db.transaction().execute(async (trx) => {
    for (const x of signed) {
      const inserted = await trx
        .insertInto("reportSignatures")
        .values({
          id: x.id,
          organizationId: args.organizationId,
          reportId: x.report.id,
          signedBy: args.userId,
          credentialId: license.id,
          typedName: x.signature.typedName,
          statement: x.signature.statement,
          signedAt: args.at,
          reportSha256: x.report.sha256,
          storageKey: x.storageKey,
          sha256: x.sha256,
          byteSize: x.byteSize,
          onBehalfOfCredentialId: from?.credentialId ?? null,
          delegationNote,
        })
        .onConflict((oc) => oc.columns(["organizationId", "reportId"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) throw new SignatureError("Someone signed this report at the same time");
    }
    const site = await trx.selectFrom("reports").select("siteId").where("organizationId", "=", args.organizationId).where("id", "=", preview.report.id).executeTakeFirstOrThrow();
    await trx
      .insertInto("complianceEvents")
      .values({
        organizationId: args.organizationId,
        siteId: site.siteId,
        eventType: "report_signed",
        occurredAt: args.at,
        actorUserId: args.userId,
        inspectionId: args.inspectionId,
        reportId: preview.report.id,
        summary:
          `Authority report version ${preview.report.version} signed by ${license.holderName}, MP ${license.number}` +
          (signed.length > 1 ? `, with customer copy version ${signed[1]!.report.version}` : "") +
          (from ? `, for ${from.holderName} (MP ${from.number}) under a documented delegation` : ""),
        details: JSON.stringify({
          signatureId: id,
          credentialId: license.id,
          reportSha256: preview.report.sha256,
          sha256,
          customer: signed[1] ? { signatureId: signed[1].id, reportId: signed[1].report.id, sha256: signed[1].sha256 } : null,
          onBehalfOfCredentialId: from?.credentialId ?? null,
          delegationNote,
        }),
      })
      .execute();
  });
  return { id, reportId: preview.report.id, version: preview.report.version, sha256, customerReportId: signed[1]?.report.id ?? null };
}
