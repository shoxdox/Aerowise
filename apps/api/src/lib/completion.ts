import type { Database } from "@aerowise/db";
import { completionAnswers, dateInZone, workOrderLabel, type InspectionValues, type TemplateDefinition } from "@aerowise/domain";
import { renderCompletionSummary, watermarkPdf, type CompletionSummary } from "@aerowise/reports";
import { sql } from "kysely";
import { HttpError, notFound } from "./errors.ts";

// SW-7: the "Work completion summary" PDF, made when it is asked for from the work order and
// its completed field records (which do not change once completed). Customer-facing only: it is
// never an authority report, and a demo company's copy is stamped as fictional.

const dataUrlImage = (url: string | null) => {
  const m = url?.match(/^data:image\/png;base64,(.+)$/);
  return m ? Buffer.from(m[1]!, "base64") : null;
};

/** The completed work orders of these sites that have at least one completed field record, newest first. */
export async function completedWorkOrders(db: Database, organizationId: string, siteIds: string[]) {
  if (siteIds.length === 0) return [];
  return db
    .selectFrom("workOrders as w")
    .select(["w.id", "w.siteId", "w.number", "w.title", "w.completedAt"])
    .where("w.organizationId", "=", organizationId)
    .where("w.siteId", "in", siteIds)
    .where("w.status", "=", "completed")
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("workRecords as r")
          .select("r.id")
          .whereRef("r.organizationId", "=", "w.organizationId")
          .whereRef("r.workOrderId", "=", "w.id")
          .where("r.status", "=", "completed"),
      ),
    )
    .orderBy("w.completedAt", "desc")
    .limit(50)
    .execute();
}

/**
 * The summary PDF of a completed work order, or 404 when there is no such work order in the
 * company (or, from the portal, for that customer). 409 `not_completed` until the work is done.
 */
export async function completionSummaryPdf(db: Database, organizationId: string, workOrderId: string, at: Date, opts: { customerId?: string } = {}): Promise<Buffer> {
  let q = db
    .selectFrom("workOrders as w")
    .innerJoin("workTypes as t", (j) => j.onRef("t.id", "=", "w.workTypeId").onRef("t.organizationId", "=", "w.organizationId"))
    .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "w.customerId").onRef("c.organizationId", "=", "w.organizationId"))
    .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "w.siteId").onRef("s.organizationId", "=", "w.organizationId"))
    .select(["w.id", "w.number", "w.title", "w.status", "w.completedAt", "t.name as workType", "c.displayName as customerName", "s.addressLine1", "s.addressLine2", "s.city", "s.state", "s.postalCode"])
    .where("w.organizationId", "=", organizationId)
    .where("w.id", "=", workOrderId);
  if (opts.customerId) q = q.where("w.customerId", "=", opts.customerId);
  const wo = await q.executeTakeFirst();
  if (!wo) throw notFound("Work order");
  if (wo.status !== "completed" || !wo.completedAt) throw new HttpError(409, "not_completed", "The summary is ready once the work is completed");

  const org = await db.selectFrom("organizations").select(["name", "phone", "email", "timezone", "demo"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
  const records = await db
    .selectFrom("workRecords as r")
    .innerJoin("jobs as j", (j) => j.onRef("j.id", "=", "r.jobId").onRef("j.organizationId", "=", "r.organizationId"))
    .innerJoin("users as u", "u.id", "r.technicianUserId")
    .innerJoin("inspectionTemplates as f", "f.id", "r.templateId")
    .select(["r.offlineClientId", "r.finalVisit", "r.completedAt", "r.arrivedAt", "j.visitNumber", "u.name as technician", "f.definition"])
    // Read as text: the query builder would camel-case the answer keys.
    .select(sql<string>`r.answers::text`.as("answersText"))
    .where("r.organizationId", "=", organizationId)
    .where("r.workOrderId", "=", wo.id)
    .where("r.status", "=", "completed")
    .orderBy("r.completedAt")
    .execute();
  if (records.length === 0) throw new HttpError(409, "not_completed", "This work has no completed field record to summarize");
  const clientIds = records.map((r) => r.offlineClientId);
  const [photos, signatures] = await Promise.all([
    db
      .selectFrom("workAttachments")
      .select(["recordClientId", "photoKey", sql<number>`count(*)::int`.as("n")])
      .where("organizationId", "=", organizationId)
      .where("recordClientId", "in", clientIds)
      .groupBy(["recordClientId", "photoKey"])
      .execute(),
    db
      .selectFrom("signedDocuments")
      .select(["recordClientId", "requirementKey", "signerName", "signatureImage", "signedAt"])
      .where("organizationId", "=", organizationId)
      .where("kind", "=", "work_completion")
      .where("recordClientId", "in", clientIds)
      .orderBy("signedAt")
      .execute(),
  ]);

  const day = (d: Date) => dateInZone(d, org.timezone);
  const summary: CompletionSummary = {
    companyName: org.name,
    companyContact: [org.phone, org.email].filter(Boolean).join(" · ") || null,
    workOrder: `${workOrderLabel(wo.number)} · ${wo.title}`,
    workType: wo.workType,
    customerName: wo.customerName,
    address: [wo.addressLine1, wo.addressLine2, `${wo.city}${wo.state ? `, ${wo.state}` : ""}${wo.postalCode ? ` ${wo.postalCode}` : ""}`].filter(Boolean).join(", "),
    completedOn: day(wo.completedAt),
    generatedOn: day(at),
    generatedAt: at.toISOString(),
    visits: records.map((r) => {
      const def = r.definition as TemplateDefinition;
      const label = (key: string, list: { key: string; label: string }[]) => list.find((x) => x.key === key)?.label ?? key;
      return {
        visitNumber: r.visitNumber ?? 1,
        date: day(r.completedAt ?? r.arrivedAt),
        technician: r.technician,
        answers: completionAnswers(def, JSON.parse(r.answersText) as InspectionValues),
        photos: photos.filter((p) => p.recordClientId === r.offlineClientId).map((p) => ({ label: label(p.photoKey, def.photos), count: Number(p.n) })),
        signatures: signatures
          .filter((x) => x.recordClientId === r.offlineClientId)
          .map((x) => ({ label: label(x.requirementKey ?? "", def.signatures ?? []), signerName: x.signerName, signedOn: day(x.signedAt), image: dataUrlImage(x.signatureImage) })),
        anotherVisitNeeded: !r.finalVisit,
      };
    }),
  };
  const pdf = await renderCompletionSummary(summary);
  return org.demo ? watermarkPdf(pdf) : pdf;
}
