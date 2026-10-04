import { createHash } from "node:crypto";
import type { Database } from "@aerowise/db";
import type { InspectionValues, TemplateDefinition } from "@aerowise/domain";
import { renderReport, reportIssues, reportSections, type Audience, type ReportSnapshot } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";

export const GENERATE_REPORTS = "reports.generate";

const AUDIENCES: Audience[] = ["customer", "authority"];

const joinAddress = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ") || null;

/**
 * Makes the customer and authority PDFs for a completed inspection. Safe to run again:
 * a copy that already exists is left alone, so a retry after a crash only makes what is
 * missing.
 */
export async function generateReports(db: Database, store: ObjectStore, organizationId: string, inspectionId: string, now: Date = new Date()) {
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
      "s.addressLine1",
      "s.addressLine2",
      "s.city",
      "s.state",
      "s.postalCode",
      "s.county",
      "s.permitNumber",
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

  const existing = await db.selectFrom("reports").select("audience").where("organizationId", "=", organizationId).where("inspectionId", "=", inspectionId).execute();
  const missing = AUDIENCES.filter((a) => !existing.some((e) => e.audience === a));
  if (missing.length === 0) return [];

  const [values, issues, photos, system] = await Promise.all([
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
  ]);

  const def = insp.definition as TemplateDefinition;
  const answers: InspectionValues = Object.fromEntries(values.map((v) => [v.fieldKey, v.valueJson as InspectionValues[string]]));
  const photoLabel = (key: string) => def.photos.find((p) => p.key === key)?.label ?? key;
  const images = new Map<string, Buffer>();
  for (const p of photos) {
    const data = await store.get(p.storageKey);
    if (data) images.set(p.storageKey, data);
  }

  const created: { id: string; audience: Audience }[] = [];
  for (const audience of missing) {
    const reportId = crypto.randomUUID();
    const snapshot: ReportSnapshot = {
      audience,
      reportId,
      generatedAt: now.toISOString(),
      timezone: insp.timezone,
      provider: {
        name: insp.orgName,
        phone: insp.orgPhone,
        email: insp.orgEmail,
        address: joinAddress([insp.orgAddress1, insp.orgCity, [insp.orgState, insp.orgPostal].filter(Boolean).join(" ")]),
      },
      customer: { name: insp.customerName },
      site: {
        address: joinAddress([insp.addressLine1, insp.addressLine2, insp.city, [insp.state, insp.postalCode].filter(Boolean).join(" ")])!,
        county: insp.county,
        permitNumber: insp.permitNumber,
      },
      system: system ?? null,
      technician: { name: insp.technicianName, license: insp.technicianLicense },
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
      sections: reportSections(def, answers, audience),
      issues: reportIssues(issues, audience),
      // Photos go on the customer copy; the authority copy is the form itself.
      photos: audience === "customer" ? photos.map((p) => ({ label: photoLabel(p.photoKey), storageKey: p.storageKey, contentType: p.contentType, capturedAt: p.capturedAt?.toISOString() ?? null })) : [],
    };
    const pdf = await renderReport(snapshot, images);
    const storageKey = `${organizationId}/reports/${inspectionId}/${audience}-v1-${reportId}.pdf`;
    await store.put(storageKey, pdf, "application/pdf");
    await db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("reports")
        .values({
          id: reportId,
          organizationId,
          inspectionId,
          siteId: insp.siteId,
          audience,
          templateId: insp.templateId,
          snapshot: JSON.stringify(snapshot),
          storageKey,
          byteSize: pdf.length,
          sha256: createHash("sha256").update(pdf).digest("hex"),
        })
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
          details: JSON.stringify({ audience, sha256: createHash("sha256").update(pdf).digest("hex") }),
        })
        .execute();
      created.push({ id: reportId, audience });
    });
  }
  return created;
}
