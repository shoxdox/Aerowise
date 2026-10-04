import { createHash } from "node:crypto";
import type { Database, DB } from "@aerowise/db";
import { CREDENTIAL_LABELS, credentialProblems, INSPECTING_CREDENTIALS, type CredentialKind, type RulesetRules } from "@aerowise/domain";
import { renderReport, type ReportSnapshot } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import type { Transaction } from "kysely";
import { latestAuthorityReport } from "./reports.ts";
import { dateInZone } from "./rulesets.ts";

type Executor = Database | Transaction<DB>;

export class SignatureError extends Error {}

const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * 30 TAC 285.7(b)(3): the maintenance provider signs every maintenance report. It is a
 * statewide rule, so it holds for every real Texas authority profile. Only the fictional
 * demo rulesets (no profile, never loaded in production) go without it.
 */
export function providerSignatureRequired(rules: RulesetRules) {
  return Boolean(rules.profile);
}

/** The signature on one report version, if it has been signed. */
export async function reportSignature(db: Executor, organizationId: string, reportId: string) {
  return (
    (await db
      .selectFrom("reportSignatures as rs")
      .innerJoin("users as u", "u.id", "rs.signedBy")
      .innerJoin("providerCredentials as c", (j) => j.onRef("c.id", "=", "rs.credentialId").onRef("c.organizationId", "=", "rs.organizationId"))
      .select(["rs.id", "rs.reportId", "rs.signedBy", "u.name as signedByName", "rs.typedName", "rs.statement", "rs.signedAt", "rs.reportSha256", "rs.storageKey", "rs.sha256", "rs.byteSize", "c.number as licenseNumber"])
      .where("rs.organizationId", "=", organizationId)
      .where("rs.reportId", "=", reportId)
      .executeTakeFirst()) ?? null
  );
}

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
  const [mine, techCredentials, existing] = await Promise.all([
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
  const holder = license ?? mine[0] ?? null;
  const statement = [
    `I, ${holder?.holderName ?? "(name)"}, TCEQ licensed maintenance provider ${holder?.number ?? "(license number)"}, have reviewed this maintenance report (version ${report.version}) for ${snapshot.site.address} and sign it as the maintenance provider, as 30 TAC 285.7(b)(3) requires.`,
    performedBy,
  ].join(" ");
  return { report, snapshot, license, holderName: holder?.holderName ?? null, statement, problems, existing };
}

/**
 * Signs the latest authority report of an inspection as the signed-in licensed maintenance
 * provider. Stores a signed copy (the report with a signature block) next to the unsigned
 * one; the filing sends the signed copy. A later version (a correction, or redrawn
 * complaint responses) needs its own signature.
 */
export async function signAuthorityReport(ctx: { db: Database; store: ObjectStore }, args: { organizationId: string; inspectionId: string; userId: string; typedName: string; at: Date }) {
  const preview = await signingPreview(ctx.db, args);
  if (preview.problems.length) throw new SignatureError(preview.problems.join("; "));
  const license = preview.license!;
  if (!sameName(args.typedName, license.holderName)) throw new SignatureError(`Type your name as it appears on your MP license: ${license.holderName}`);
  const signature: NonNullable<ReportSnapshot["signature"]> = {
    name: license.holderName,
    licenseLabel: CREDENTIAL_LABELS.tceq_maintenance_provider,
    licenseNumber: license.number,
    typedName: args.typedName.trim(),
    statement: preview.statement,
    signedAt: args.at.toISOString(),
    reportVersion: preview.report.version,
    reportSha256: preview.report.sha256,
  };
  const pdf = await renderReport({ ...preview.snapshot, signature });
  const id = crypto.randomUUID();
  const storageKey = `${args.organizationId}/reports/${args.inspectionId}/authority-v${preview.report.version}-signed-${id}.pdf`;
  await ctx.store.put(storageKey, pdf, "application/pdf");
  const sha256 = sha256Hex(pdf);
  await ctx.db.transaction().execute(async (trx) => {
    const inserted = await trx
      .insertInto("reportSignatures")
      .values({
        id,
        organizationId: args.organizationId,
        reportId: preview.report.id,
        signedBy: args.userId,
        credentialId: license.id,
        typedName: signature.typedName,
        statement: signature.statement,
        signedAt: args.at,
        reportSha256: preview.report.sha256,
        storageKey,
        sha256,
        byteSize: pdf.length,
      })
      .onConflict((oc) => oc.columns(["organizationId", "reportId"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!inserted) throw new SignatureError("Someone signed this report at the same time");
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
        summary: `Authority report version ${preview.report.version} signed by ${license.holderName}, MP ${license.number}`,
        details: JSON.stringify({ signatureId: id, credentialId: license.id, reportSha256: preview.report.sha256, sha256 }),
      })
      .execute();
  });
  return { id, reportId: preview.report.id, version: preview.report.version, sha256 };
}
