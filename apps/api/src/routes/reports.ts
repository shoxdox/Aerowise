import type { Database } from "@aerowise/db";
import { complianceEvent, id, report, type ComplianceEvent, type Report } from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound } from "../lib/errors.ts";
import type { UrlSigner } from "../storage/signed-urls.ts";

const params = z.object({ id });

export const reportRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; store: ObjectStore; signer: UrlSigner }> = async (app, { db, now, store, signer }) => {
  const reportUrl = (organizationId: string, reportId: string) => signer.url(organizationId, reportId, now().getTime(), "report-files");

  app.get(
    "/inspections/:id/reports",
    {
      config: { permission: "inspections:read" },
      schema: {
        tags: ["reports"],
        summary: "The report PDFs made for an inspection",
        description: "`pending` is true while a completed inspection's reports are still being made.",
        params,
        response: { 200: z.object({ items: z.array(report), pending: z.boolean() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const insp = await db
        .selectFrom("inspections")
        .select(["id", "status"])
        .where("organizationId", "=", organizationId)
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!insp) throw notFound("Inspection");
      const rows = await db
        .selectFrom("reports")
        .select(["id", "inspectionId", "audience", "version", "generatedAt", "byteSize", "sha256"])
        .where("organizationId", "=", organizationId)
        .where("inspectionId", "=", insp.id)
        .orderBy("audience", "desc")
        .orderBy("version")
        .execute();
      const items: Report[] = rows.map((r) => ({ ...r, generatedAt: r.generatedAt.toISOString(), url: reportUrl(organizationId, r.id) }));
      return { items, pending: insp.status === "completed" && rows.length < 2 };
    },
  );

  app.get(
    "/report-files/:id",
    {
      // Authorized by the signature, like /files; bound to the report's own organization.
      config: { public: true },
      schema: { tags: ["reports"], summary: "Download a report PDF through a signed link", params, querystring: z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }) },
    },
    async (req, reply) => {
      const row = await db.selectFrom("reports").select(["id", "organizationId", "storageKey", "audience", "inspectionId"]).where("id", "=", req.params.id).executeTakeFirst();
      if (!row || !signer.verify(row.organizationId, row.id, req.query.exp, req.query.sig, now().getTime(), "report-files")) throw notFound("File");
      const data = await store.get(row.storageKey);
      if (!data) throw notFound("File");
      return reply
        .type("application/pdf")
        .header("content-disposition", `inline; filename="inspection-${row.inspectionId.slice(0, 8)}-${row.audience}.pdf"`)
        .header("x-content-type-options", "nosniff")
        .send(data);
    },
  );

  app.get(
    "/sites/:id/compliance-events",
    {
      config: { permission: "inspections:read" },
      schema: {
        tags: ["reports"],
        summary: "The site's compliance history, newest first",
        params,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }),
        response: { 200: z.object({ items: z.array(complianceEvent) }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const site = await db.selectFrom("sites").select("id").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!site) throw notFound("Site");
      const rows = await db
        .selectFrom("complianceEvents as e")
        .leftJoin("users as u", "u.id", "e.actorUserId")
        .leftJoin("reports as r", (j) => j.onRef("r.id", "=", "e.reportId").onRef("r.organizationId", "=", "e.organizationId"))
        .select(["e.id", "e.eventType", "e.occurredAt", "e.summary", "e.inspectionId", "u.name as actorName", "r.id as reportId", "r.audience"])
        .where("e.organizationId", "=", organizationId)
        .where("e.siteId", "=", site.id)
        .orderBy("e.occurredAt", "desc")
        .orderBy("e.id")
        .limit(req.query.limit)
        .execute();
      const items: ComplianceEvent[] = rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        occurredAt: r.occurredAt.toISOString(),
        summary: r.summary,
        actorName: r.actorName,
        inspectionId: r.inspectionId,
        report: r.reportId && r.audience ? { id: r.reportId, audience: r.audience, url: reportUrl(organizationId, r.reportId) } : null,
      }));
      return { items };
    },
  );
};
