import { loadCatalog, requirementsOf, resolveSite } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import {
  canTransition,
  id,
  jobCancelInput,
  JOB_STATE_MACHINE,
  reorderInput,
  reschedulePatch,
  scheduleInput,
  stop,
  technician,
  type JobStatus,
  type Stop,
} from "@aerowise/domain";
import { serviceEndForVisit } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { organizationToday } from "../lib/today.ts";

const params = z.object({ id });
const date = z.iso.date();

// Members who can be sent on a route. Small providers often have the owner inspecting too.
const ASSIGNABLE_ROLES = ["technician", "owner"] as const;

export const scheduleRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  /** Live jobs joined with everything a stop card shows. */
  const stopQuery = (organizationId: string) =>
    db
      .selectFrom("jobs as j")
      .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "j.siteId").onRef("s.organizationId", "=", "j.organizationId"))
      .innerJoin("customers as c", (k) => k.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"))
      .innerJoin("users as u", "u.id", "j.technicianUserId")
      .leftJoin("serviceObligations as o", (k) => k.onRef("o.id", "=", "j.obligationId").onRef("o.organizationId", "=", "j.organizationId"))
      .select([
        "j.id as jobId",
        "j.status",
        "j.routePosition",
        "j.scheduledDate",
        "j.technicianUserId as technicianId",
        "u.name as technicianName",
        "j.notes",
        "j.onTheWayAt",
        "o.id as obligationId",
        "o.sequence",
        "o.dueOn",
        "o.windowEnd",
        "s.id as siteId",
        "s.addressLine1",
        "s.addressLine2",
        "s.city",
        "s.state",
        "s.postalCode",
        "s.lat",
        "s.lng",
        "s.gateCode",
        "s.accessNotes",
        "s.schedulingNotes",
        "s.safetyFlags",
        "s.permitNumber",
        "s.county",
        "s.jurisdictionId",
        "s.customerType",
        "c.id as customerId",
        "c.displayName as customerName",
      ])
      .select((eb) => [
        eb
          .selectFrom("contacts as ct")
          .select("ct.phone")
          .whereRef("ct.customerId", "=", "c.id")
          .where("ct.organizationId", "=", organizationId)
          .where("ct.phone", "is not", null)
          .orderBy(sql`ct.type = 'primary'`, "desc")
          .orderBy("ct.createdAt")
          .limit(1)
          .as("customerPhone"),
        eb
          .selectFrom("wastewaterSystems as w")
          .select(sql<string>`json_build_object('manufacturer', w.manufacturer, 'model', w.model, 'disposalType', w.disposal_type, 'chlorinationMethod', w.chlorination_method)`.as("x"))
          .whereRef("w.siteId", "=", "s.id")
          .where("w.organizationId", "=", organizationId)
          .where("w.active", "=", true)
          .orderBy("w.createdAt")
          .limit(1)
          .as("system"),
      ])
      .where("j.organizationId", "=", organizationId)
      .where("j.status", "<>", "cancelled")
      .orderBy("j.scheduledDate")
      .orderBy("u.name")
      .orderBy("j.routePosition")
      .orderBy("j.createdAt");

  type StopRow = Awaited<ReturnType<ReturnType<typeof stopQuery>["execute"]>>[number];
  const toStop = (r: StopRow): Stop => ({
    jobId: r.jobId,
    status: r.status,
    routePosition: r.routePosition,
    scheduledDate: r.scheduledDate,
    technicianId: r.technicianId,
    technicianName: r.technicianName,
    notes: r.notes,
    onTheWayAt: r.onTheWayAt?.toISOString() ?? null,
    obligation: r.obligationId && r.sequence !== null && r.dueOn && r.windowEnd
      ? { id: r.obligationId, sequence: r.sequence, dueOn: r.dueOn, windowEnd: r.windowEnd }
      : null,
    site: {
      id: r.siteId,
      addressLine1: r.addressLine1,
      addressLine2: r.addressLine2,
      city: r.city,
      state: r.state,
      postalCode: r.postalCode,
      lat: r.lat,
      lng: r.lng,
      gateCode: r.gateCode,
      accessNotes: r.accessNotes,
      schedulingNotes: r.schedulingNotes,
      safetyFlags: r.safetyFlags as Stop["site"]["safetyFlags"],
      permitNumber: r.permitNumber,
    },
    customer: { id: r.customerId, displayName: r.customerName, phone: r.customerPhone ?? null },
    system: (r.system as unknown as Stop["system"]) ?? null,
  });

  async function assertAssignable(organizationId: string, userId: string) {
    const m = await db
      .selectFrom("memberships as m")
      .innerJoin("users as u", "u.id", "m.userId")
      .select("m.userId")
      .where("m.organizationId", "=", organizationId)
      .where("m.userId", "=", userId)
      .where("m.active", "=", true)
      .where("u.active", "=", true)
      .where("m.role", "in", ASSIGNABLE_ROLES)
      .executeTakeFirst();
    if (!m) throw unprocessable("technicianId is not an active technician in this organization");
  }

  const nextPosition = async (organizationId: string, technicianId: string, scheduledDate: string) => {
    const r = await db
      .selectFrom("jobs")
      .select(sql<number>`coalesce(max(route_position), 0) + 1`.as("next"))
      .where("organizationId", "=", organizationId)
      .where("technicianUserId", "=", technicianId)
      .where("scheduledDate", "=", scheduledDate)
      .where("status", "<>", "cancelled")
      .executeTakeFirstOrThrow();
    return Number(r.next);
  };

  const loadStop = async (organizationId: string, jobId: string) => {
    const row = await stopQuery(organizationId).where("j.id", "=", jobId).executeTakeFirst();
    if (!row) throw notFound("Job");
    return toStop(row);
  };

  /** A visit is never put on a day after its contract's recorded last day of service. */
  const assertWithinService = async (organizationId: string, obligationId: string, scheduledDate: string) => {
    const endsOn = await serviceEndForVisit(db, organizationId, obligationId);
    if (endsOn && scheduledDate > endsOn) throw unprocessable(`Service under this contract ends after ${endsOn}, so the visit cannot be scheduled on ${scheduledDate}`);
  };

  app.get(
    "/technicians",
    {
      config: { permission: "schedule:read" },
      schema: { tags: ["schedule"], summary: "Members who can be assigned jobs", response: { 200: z.object({ items: z.array(technician) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const items = await db
        .selectFrom("memberships as m")
        .innerJoin("users as u", "u.id", "m.userId")
        .select(["u.id", "u.name", "m.technicianLicense"])
        .where("m.organizationId", "=", organizationId)
        .where("m.active", "=", true)
        .where("u.active", "=", true)
        .where("m.role", "in", ASSIGNABLE_ROLES)
        .orderBy(sql`m.role = 'technician'`, "desc")
        .orderBy("u.name")
        .execute();
      return { items };
    },
  );

  app.get(
    "/schedule",
    {
      config: { permission: "schedule:read" },
      schema: {
        tags: ["schedule"],
        summary: "Scheduled jobs between two dates, by day, technician and route order",
        querystring: z
          .object({ from: date, to: date, technicianId: id.optional() })
          .refine((q) => q.from <= q.to, { message: "from must be on or before to" })
          .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 62, { message: "Range is limited to 62 days" }),
        response: { 200: z.object({ items: z.array(stop) }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      let q = stopQuery(organizationId).where("j.scheduledDate", ">=", req.query.from).where("j.scheduledDate", "<=", req.query.to);
      if (req.query.technicianId) q = q.where("j.technicianUserId", "=", req.query.technicianId);
      return { items: (await q.execute()).map(toStop) };
    },
  );

  app.get(
    "/route",
    {
      config: { permission: "route:read" },
      schema: {
        tags: ["schedule"],
        summary: "The signed-in technician's stops for a day, in route order",
        querystring: z.object({ date: date.optional() }),
        response: { 200: z.object({ date, items: z.array(stop) }) },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const day = req.query.date ?? (await organizationToday(db, organizationId, now()));
      const rows = await stopQuery(organizationId).where("j.technicianUserId", "=", userId).where("j.scheduledDate", "=", day).execute();
      // The phone checks the authority's requirements offline, so each stop carries them.
      const catalog = await loadCatalog(db);
      const items = rows.map((r) => {
        const resolved = resolveSite(catalog, { county: r.county, state: r.state, jurisdictionId: r.jurisdictionId }, day);
        return { ...toStop(r), requirements: resolved ? requirementsOf(resolved, r.customerType) : null };
      });
      return { date: day, items };
    },
  );

  app.post(
    "/jobs",
    {
      config: { permission: "schedule:write" },
      schema: { tags: ["schedule"], summary: "Schedule a due visit, or an extra retest visit, to a technician on a day", body: scheduleInput, response: { 201: stop } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const { obligationId, retestOfInspectionId, technicianId, scheduledDate, notes } = req.body;
      let ob: { id: string | null; siteId: string };
      if (obligationId) {
        const found = await db
          .selectFrom("serviceObligations")
          .select(["id", "siteId", "status"])
          .where("organizationId", "=", organizationId)
          .where("id", "=", obligationId)
          .executeTakeFirst();
        if (!found) throw unprocessable("obligationId does not match a visit in this organization");
        if (found.status !== "open") throw unprocessable(`This visit is ${found.status}`);
        await assertWithinService(organizationId, found.id, scheduledDate);
        ob = found;
      } else {
        // An extra visit to retest after a report: it uses none of the contract's visits.
        const insp = await db
          .selectFrom("inspections")
          .select(["siteId", "status"])
          .where("organizationId", "=", organizationId)
          .where("id", "=", retestOfInspectionId!)
          .executeTakeFirst();
        if (!insp) throw unprocessable("retestOfInspectionId does not match an inspection in this organization");
        if (insp.status !== "completed") throw unprocessable("Only a completed inspection can be retested");
        ob = { id: null, siteId: insp.siteId };
      }
      await assertAssignable(organizationId, technicianId);
      const position = await nextPosition(organizationId, technicianId, scheduledDate);
      const jobId = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("jobs")
          .values({
            organizationId,
            siteId: ob.siteId,
            obligationId: ob.id,
            stateMachineVersion: JOB_STATE_MACHINE.version,
            scheduledDate,
            technicianUserId: technicianId,
            routePosition: position,
            notes: notes ?? null,
            cancelledAt: null,
            cancelReason: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
          .catch((err) => {
            if ((err as { code?: string }).code === "23505") throw new HttpError(409, "already_scheduled", "This visit is already scheduled");
            throw err;
          });
        await audit(trx, req, { action: "job.scheduled", entityType: "job", entityId: created.id, changes: req.body });
        return created.id;
      });
      return reply.status(201).send(await loadStop(organizationId, jobId));
    },
  );

  app.patch(
    "/jobs/:id",
    {
      config: { permission: "schedule:write" },
      schema: { tags: ["schedule"], summary: "Move a scheduled job to another technician or day", params, body: reschedulePatch, response: { 200: stop } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const job = await db
        .selectFrom("jobs")
        .select(["id", "status", "technicianUserId", "scheduledDate", "obligationId"])
        .where("organizationId", "=", organizationId)
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!job) throw notFound("Job");
      if (job.status !== "scheduled") throw new HttpError(409, "not_reschedulable", `A ${job.status.replace("_", " ")} job cannot be moved`);
      const technicianId = req.body.technicianId ?? job.technicianUserId;
      const scheduledDate = req.body.scheduledDate ?? job.scheduledDate;
      if (req.body.scheduledDate !== undefined && job.obligationId) await assertWithinService(organizationId, job.obligationId, scheduledDate);
      const moved = technicianId !== job.technicianUserId || scheduledDate !== job.scheduledDate;
      if (req.body.technicianId) await assertAssignable(organizationId, technicianId);
      const routePosition = moved ? await nextPosition(organizationId, technicianId, scheduledDate) : undefined;
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("jobs")
          .set({
            technicianUserId: technicianId,
            scheduledDate,
            ...(routePosition !== undefined ? { routePosition } : {}),
            ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}),
            updatedAt: new Date(),
          })
          .where("organizationId", "=", organizationId)
          .where("id", "=", job.id)
          .execute();
        await audit(trx, req, { action: "job.rescheduled", entityType: "job", entityId: job.id, changes: req.body });
      });
      return loadStop(organizationId, job.id);
    },
  );

  app.post(
    "/jobs/:id/cancel",
    {
      config: { permission: "schedule:write" },
      schema: {
        tags: ["schedule"],
        summary: "Unschedule a job; its visit goes back to unscheduled work",
        params,
        body: jobCancelInput,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const job = await db
        .selectFrom("jobs")
        .select(["id", "status"])
        .where("organizationId", "=", organizationId)
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!job) throw notFound("Job");
      if (!canTransition(job.status as JobStatus, "cancelled")) {
        throw new HttpError(409, "invalid_transition", `A ${job.status.replace("_", " ")} job cannot be cancelled`);
      }
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("jobs")
          .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: req.body.reason, updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", job.id)
          .execute();
        await audit(trx, req, { action: "job.cancelled", entityType: "job", entityId: job.id, changes: req.body });
      });
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/schedule/reorder",
    {
      config: { permission: "schedule:write" },
      schema: {
        tags: ["schedule"],
        summary: "Set the stop order of a technician's day",
        body: reorderInput,
        response: { 200: z.object({ items: z.array(stop) }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const { technicianId, scheduledDate, jobIds } = req.body;
      await db.transaction().execute(async (trx) => {
        // Lock the day's jobs so two dispatchers cannot interleave reorders.
        const current = await trx
          .selectFrom("jobs")
          .select("id")
          .where("organizationId", "=", organizationId)
          .where("technicianUserId", "=", technicianId)
          .where("scheduledDate", "=", scheduledDate)
          .where("status", "<>", "cancelled")
          .forUpdate()
          .execute();
        const expected = new Set(current.map((j) => j.id));
        if (expected.size !== jobIds.length || new Set(jobIds).size !== jobIds.length || !jobIds.every((j) => expected.has(j))) {
          throw unprocessable("jobIds must list every job on that technician's day exactly once");
        }
        for (const [i, jobId] of jobIds.entries()) {
          await trx.updateTable("jobs").set({ routePosition: i + 1, updatedAt: new Date() }).where("id", "=", jobId).execute();
        }
        await audit(trx, req, { action: "route.reordered", entityType: "technician_day", entityId: technicianId, changes: req.body });
      });
      const rows = await stopQuery(organizationId)
        .where("j.technicianUserId", "=", technicianId)
        .where("j.scheduledDate", "=", scheduledDate)
        .execute();
      return { items: rows.map(toStop) };
    },
  );
};
