import { labTestStatuses } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { id, LAB_ANALYTE_LABELS, labTest, labTestInput, siteLabTests, type LabTest } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { organizationToday } from "../lib/today.ts";

const params = z.object({ id });

/**
 * Lab tests (BOD, TSS) an authority requires on a schedule. Results are recorded by the
 * office from the lab's report and never edited; a correction is a new record that
 * replaces the old one. Whether one is due comes from the site's ruleset.
 */
export const labTestRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  async function requireSite(organizationId: string, siteId: string) {
    const site = await db.selectFrom("sites").select("id").where("organizationId", "=", organizationId).where("id", "=", siteId).executeTakeFirst();
    if (!site) throw notFound("Site");
  }

  async function listFor(organizationId: string, siteId: string): Promise<LabTest[]> {
    const rows = await db
      .selectFrom("labTests as t")
      .innerJoin("users as u", "u.id", "t.recordedBy")
      .leftJoin("labTests as r", (j) => j.onRef("r.organizationId", "=", "t.organizationId").onRef("r.replacesId", "=", "t.id"))
      .select(["t.id", "t.siteId", "t.sampledOn", "t.labName", "t.labReference", "t.results", "t.notes", "t.replacesId", "r.id as replacedById", "u.name as recordedBy", "t.recordedAt"])
      .where("t.organizationId", "=", organizationId)
      .where("t.siteId", "=", siteId)
      .orderBy("t.sampledOn", "desc")
      .orderBy("t.recordedAt", "desc")
      .execute();
    return rows.map((r) => ({ ...r, results: r.results as LabTest["results"], replacedById: r.replacedById ?? null, recordedAt: r.recordedAt.toISOString() }));
  }

  app.get(
    "/sites/:id/lab-tests",
    {
      config: { permission: "filings:read" },
      schema: { tags: ["lab tests"], summary: "The lab tests a site's authority requires, when the next is due, and results on record", params, response: { 200: siteLabTests } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await requireSite(organizationId, req.params.id);
      const today = await organizationToday(db, organizationId, now());
      const [status] = await labTestStatuses(db, organizationId, today, { siteId: req.params.id });
      const requirement = status ? (({ siteId: _siteId, ...rest }) => rest)(status) : null;
      return { requirement, items: await listFor(organizationId, req.params.id) };
    },
  );

  app.post(
    "/sites/:id/lab-tests",
    {
      config: { permission: "filings:write" },
      schema: {
        tags: ["lab tests"],
        summary: "Record a lab test result, or a correction that replaces an earlier one",
        params,
        body: labTestInput,
        response: { 201: labTest },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      await requireSite(organizationId, req.params.id);
      const today = await organizationToday(db, organizationId, now());
      if (b.sampledOn > today) throw unprocessable("The sample date is in the future");
      const [status] = await labTestStatuses(db, organizationId, today, { siteId: req.params.id });
      const missing = (status?.analytes ?? []).filter((a) => !b.results.some((r) => r.analyte === a));
      if (missing.length > 0) throw unprocessable(`${status!.authorityName} requires ${missing.map((a) => LAB_ANALYTE_LABELS[a]).join(" and ")} results`);
      if (b.replacesId) {
        const old = await db.selectFrom("labTests").select("id").where("organizationId", "=", organizationId).where("siteId", "=", req.params.id).where("id", "=", b.replacesId).executeTakeFirst();
        if (!old) throw unprocessable("replacesId does not match a lab test at this site");
      }
      const at = now();
      const created = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto("labTests")
          .values({
            organizationId,
            siteId: req.params.id,
            sampledOn: b.sampledOn,
            labName: b.labName,
            labReference: b.labReference ?? null,
            results: JSON.stringify(b.results),
            notes: b.notes ?? null,
            replacesId: b.replacesId ?? null,
            recordedBy: userId,
            recordedAt: at,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
          .catch((err: { code?: string }) => {
            if (err.code === "23505") throw new HttpError(409, "already_replaced", "That lab test has already been corrected");
            throw err;
          });
        const values = b.results.map((r) => `${LAB_ANALYTE_LABELS[r.analyte]} ${r.value} mg/L`).join(", ");
        await trx
          .insertInto("complianceEvents")
          .values({
            organizationId,
            siteId: req.params.id,
            eventType: b.replacesId ? "lab_test_corrected" : "lab_test_recorded",
            occurredAt: at,
            actorUserId: userId,
            inspectionId: null,
            reportId: null,
            summary: `${b.replacesId ? "Lab test corrected" : "Lab test recorded"}: sampled ${b.sampledOn}, ${b.labName}: ${values}`,
            details: JSON.stringify({ labTestId: row.id, replacesId: b.replacesId ?? null }),
          })
          .execute();
        await audit(trx, req, { action: "lab_test.recorded", entityType: "lab_test", entityId: row.id, changes: b });
        return row.id;
      });
      const item = (await listFor(organizationId, req.params.id)).find((t) => t.id === created)!;
      return reply.status(201).send(item);
    },
  );
};
