import type { Database, DB } from "@aerowise/db";
import { id, MONITORING_METHOD_LABELS, monitoringEndInput, monitoringInput, systemMonitoring, type SystemMonitoring } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { organizationToday } from "../lib/today.ts";

const params = z.object({ id });

/**
 * Electronic monitoring on a system. Where a ruleset allows it, a site with monitoring on
 * record gets a longer interval between inspections, so a record says what the monitoring
 * is, who it notifies, and when a person checked it works. Ending it is recorded, not deleted.
 */
export const monitoringRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  const list = (organizationId: string) =>
    db
      .selectFrom("systemMonitoring as m")
      .innerJoin("wastewaterSystems as w", (j) => j.onRef("w.id", "=", "m.systemId").onRef("w.organizationId", "=", "m.organizationId"))
      .innerJoin("users as u", "u.id", "m.recordedBy")
      .select(["m.id", "m.systemId", "m.method", "m.description", "m.notifies", "m.startedOn", "m.checkedOn", "m.endedOn", "m.endReason", "u.name as recordedBy", "m.recordedAt", "w.siteId"])
      .where("m.organizationId", "=", organizationId);
  const toItem = ({ siteId: _siteId, ...r }: Awaited<ReturnType<ReturnType<typeof list>["executeTakeFirstOrThrow"]>>): SystemMonitoring => ({ ...r, recordedAt: r.recordedAt.toISOString() });

  async function timeline(trx: Transaction<DB>, organizationId: string, siteId: string, userId: string, at: Date, eventType: string, summary: string, monitoringId: string) {
    await trx
      .insertInto("complianceEvents")
      .values({ organizationId, siteId, eventType, occurredAt: at, actorUserId: userId, inspectionId: null, reportId: null, summary, details: JSON.stringify({ monitoringId }) })
      .execute();
  }

  app.get(
    "/sites/:id/monitoring",
    {
      config: { permission: "crm:read" },
      schema: { tags: ["systems"], summary: "Electronic monitoring recorded on a site's systems, newest first", params, response: { 200: z.object({ items: z.array(systemMonitoring) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const site = await db.selectFrom("sites").select("id").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!site) throw notFound("Site");
      const rows = await list(organizationId).where("w.siteId", "=", site.id).orderBy("m.startedOn", "desc").orderBy("m.recordedAt", "desc").execute();
      return { items: rows.map(toItem) };
    },
  );

  app.post(
    "/systems/:id/monitoring",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["systems"], summary: "Record electronic monitoring on a system", params, body: monitoringInput, response: { 201: systemMonitoring } },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      const system = await db.selectFrom("wastewaterSystems").select(["id", "siteId", "active"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!system) throw notFound("Wastewater system");
      if (!system.active) throw unprocessable("This system is inactive");
      const today = await organizationToday(db, organizationId, now());
      if (b.checkedOn > today) throw unprocessable("The check date is in the future");
      if (b.checkedOn < b.startedOn) throw unprocessable("It cannot be checked before it started");
      const at = now();
      const created = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto("systemMonitoring")
          .values({ organizationId, systemId: system.id, ...b, endedOn: null, endReason: null, endedBy: null, recordedBy: userId, recordedAt: at })
          .returning("id")
          .executeTakeFirstOrThrow()
          .catch((err: { code?: string }) => {
            if (err.code === "23505") throw new HttpError(409, "monitoring_exists", "This system already has monitoring on record; end it first");
            throw err;
          });
        await timeline(trx, organizationId, system.siteId, userId, at, "monitoring_recorded", `Electronic monitoring recorded: ${MONITORING_METHOD_LABELS[b.method]}, ${b.description}; notifies ${b.notifies}; checked ${b.checkedOn}`, row.id);
        await audit(trx, req, { action: "monitoring.recorded", entityType: "system_monitoring", entityId: row.id, changes: b });
        return row.id;
      });
      return reply.status(201).send(toItem(await list(organizationId).where("m.id", "=", created).executeTakeFirstOrThrow()));
    },
  );

  app.post(
    "/monitoring/:id/end",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["systems"], summary: "Record that a system's electronic monitoring ended", params, body: monitoringEndInput, response: { 200: systemMonitoring } },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const m = await trx
          .selectFrom("systemMonitoring as m")
          .innerJoin("wastewaterSystems as w", (j) => j.onRef("w.id", "=", "m.systemId").onRef("w.organizationId", "=", "m.organizationId"))
          .select(["m.id", "m.startedOn", "m.endedOn", "w.siteId"])
          .where("m.organizationId", "=", organizationId)
          .where("m.id", "=", req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!m) throw notFound("Monitoring record");
        if (m.endedOn) throw new HttpError(409, "already_ended", "This monitoring has already ended");
        if (req.body.endedOn < m.startedOn) throw unprocessable("It cannot end before it started");
        await trx.updateTable("systemMonitoring").set({ endedOn: req.body.endedOn, endReason: req.body.reason, endedBy: userId }).where("id", "=", m.id).execute();
        await timeline(trx, organizationId, m.siteId, userId, at, "monitoring_ended", `Electronic monitoring ended ${req.body.endedOn}: ${req.body.reason}`, m.id);
        await audit(trx, req, { action: "monitoring.ended", entityType: "system_monitoring", entityId: m.id, changes: req.body });
      });
      return toItem(await list(organizationId).where("m.id", "=", req.params.id).executeTakeFirstOrThrow());
    },
  );
};
