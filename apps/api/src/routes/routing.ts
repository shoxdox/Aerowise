import type { Database } from "@aerowise/db";
import {
  addDays,
  geocodeInput,
  nearbyQuery,
  nearbyResult,
  optimizeInput,
  optimizeResult,
  routeDay,
  routingSettings,
  routingSettingsPatch,
  type RoutingSettings,
  type TechnicianRoute,
} from "@aerowise/domain";
import { detourMiles, driveMinutes, GeocodeError, oneLine, planRoute, summarizeRoute, type Geocoder, type Point, type RouteStop } from "@aerowise/routing";
import { queueSiteLocating } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, unprocessable } from "../lib/errors.ts";

const date = z.iso.date();

interface DayStop {
  jobId: string;
  status: string;
  technicianId: string;
  technicianName: string;
  lat: number | null;
  lng: number | null;
}

const pointOf = (s: { lat: number | null; lng: number | null }): Point | null => (s.lat !== null && s.lng !== null ? { lat: s.lat, lng: s.lng } : null);
const routeStop = (s: DayStop): RouteStop => ({ id: s.jobId, point: pointOf(s) });

export const routingRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; geocoder: Geocoder | null }> = async (app, { db, now, geocoder }) => {
  async function settingsOf(organizationId: string): Promise<RoutingSettings> {
    const [o, counts] = await Promise.all([
      db
        .selectFrom("organizations")
        .select(["routeStartAddress", "routeStartLat", "routeStartLng", "routeReturnToStart", "routeStopMinutes", "routeDayMinutes", "routeSpeedMph"])
        .where("id", "=", organizationId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("sites")
        .select([
          sql<number>`count(*) filter (where lat is not null)::int`.as("located"),
          sql<number>`count(*) filter (where lat is null and geocode_status is null)::int`.as("pending"),
          sql<number>`count(*) filter (where geocode_status = 'not_found')::int`.as("notFound"),
        ])
        .where("organizationId", "=", organizationId)
        .where("active", "=", true)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      geocoder: geocoder?.kind ?? "off",
      start:
        o.routeStartLat !== null && o.routeStartLng !== null
          ? { address: o.routeStartAddress ?? "", lat: o.routeStartLat, lng: o.routeStartLng }
          : null,
      returnToStart: o.routeReturnToStart,
      stopMinutes: o.routeStopMinutes,
      dayMinutes: o.routeDayMinutes,
      speedMph: o.routeSpeedMph,
      sites: counts,
    };
  }

  /** The day's live jobs, every technician, in route order. */
  const dayStops = (organizationId: string, day: string, technicianId?: string) => {
    let q = db
      .selectFrom("jobs as j")
      .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "j.siteId").onRef("s.organizationId", "=", "j.organizationId"))
      .innerJoin("users as u", "u.id", "j.technicianUserId")
      .select(["j.id as jobId", "j.status", "j.technicianUserId as technicianId", "u.name as technicianName", "s.lat", "s.lng"])
      .where("j.organizationId", "=", organizationId)
      .where("j.scheduledDate", "=", day)
      .where("j.status", "<>", "cancelled");
    if (technicianId) q = q.where("j.technicianUserId", "=", technicianId);
    return q.orderBy("u.name").orderBy("j.technicianUserId").orderBy("j.routePosition").orderBy("j.createdAt");
  };

  const routeOptions = (s: RoutingSettings) => ({ start: s.start, returnToStart: s.returnToStart, model: { speedMph: s.speedMph } });

  function technicianRoute(s: RoutingSettings, stops: DayStop[]): TechnicianRoute {
    const summary = summarizeRoute(stops.map(routeStop), routeOptions(s));
    const serviceMinutes = stops.length * s.stopMinutes;
    const totalMinutes = summary.driveMinutes + serviceMinutes;
    return {
      technicianId: stops[0]!.technicianId,
      technicianName: stops[0]!.technicianName,
      stops: stops.map((x) => ({ jobId: x.jobId, status: x.status, lat: x.lat, lng: x.lng })),
      legs: summary.legs.map((l) => ({ fromJobId: l.fromId, toJobId: l.toId, miles: l.miles, minutes: l.minutes })),
      driveMiles: summary.driveMiles,
      driveMinutes: summary.driveMinutes,
      serviceMinutes,
      totalMinutes,
      overCapacity: totalMinutes > s.dayMinutes,
      unlocatedJobIds: summary.unlocatedIds,
    };
  }

  /** Stops already started or done keep their place at the front of the route. */
  function plan(s: RoutingSettings, stops: DayStop[]) {
    const fixed = stops.filter((x) => x.status !== "scheduled").map(routeStop);
    const movable = stops.filter((x) => x.status === "scheduled").map(routeStop);
    const proposed = planRoute({ start: s.start, returnToStart: s.returnToStart, fixed, movable });
    const byId = new Map(stops.map((x) => [x.jobId, routeStop(x)]));
    const before = summarizeRoute(stops.map(routeStop), routeOptions(s));
    const after = summarizeRoute(proposed.map((i) => byId.get(i)!), routeOptions(s));
    const current = stops.map((x) => x.jobId);
    return {
      changed: proposed.some((i, k) => i !== current[k]),
      currentJobIds: current,
      proposedJobIds: proposed,
      before: { driveMiles: before.driveMiles, driveMinutes: before.driveMinutes },
      after: { driveMiles: after.driveMiles, driveMinutes: after.driveMinutes },
      unlocatedJobIds: before.unlocatedIds,
    };
  }

  // ---- Settings ----

  app.get(
    "/routing/settings",
    {
      config: { permission: "schedule:read" },
      schema: { tags: ["routing"], summary: "Where routes start, the travel estimate's numbers, and how many sites are on the map", response: { 200: routingSettings } },
    },
    async (req) => settingsOf(req.requireAuth().organizationId),
  );

  app.patch(
    "/routing/settings",
    {
      config: { permission: "org:manage" },
      schema: {
        tags: ["routing"],
        summary: "Set where technicians start their day and the numbers travel estimates use",
        description: "A start address is looked up on the map unless `lat` and `lng` are given with it.",
        body: routingSettingsPatch,
        response: { 200: routingSettings },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const { start, returnToStart, stopMinutes, dayMinutes, speedMph } = req.body;
      let startColumns = {};
      if (start === null) startColumns = { routeStartAddress: null, routeStartLat: null, routeStartLng: null };
      if (start) {
        if ((start.lat === undefined) !== (start.lng === undefined)) throw unprocessable("Give both lat and lng, or neither");
        let point: Point | null = start.lat !== undefined && start.lng !== undefined ? { lat: start.lat, lng: start.lng } : null;
        if (!point) {
          if (!geocoder) throw unprocessable("Finding addresses is turned off on this server. Enter the start's latitude and longitude.");
          try {
            point = await geocoder.geocode(start);
          } catch (err) {
            if (err instanceof GeocodeError) throw new HttpError(502, "geocoder_unavailable", "The map service did not answer. Try again, or enter latitude and longitude.");
            throw err;
          }
          if (!point) throw unprocessable("That address could not be found on the map. Check it, or enter latitude and longitude.");
        }
        startColumns = { routeStartAddress: oneLine(start), routeStartLat: point.lat, routeStartLng: point.lng };
      }
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("organizations")
          .set({
            ...startColumns,
            ...(returnToStart !== undefined ? { routeReturnToStart: returnToStart } : {}),
            ...(stopMinutes !== undefined ? { routeStopMinutes: stopMinutes } : {}),
            ...(dayMinutes !== undefined ? { routeDayMinutes: dayMinutes } : {}),
            ...(speedMph !== undefined ? { routeSpeedMph: speedMph } : {}),
          })
          .where("id", "=", organizationId)
          .execute();
        await audit(trx, req, { action: "routing.settings_changed", entityType: "organization", entityId: organizationId, changes: { ...req.body, ...startColumns } });
      });
      return settingsOf(organizationId);
    },
  );

  app.post(
    "/routing/locate-sites",
    {
      config: { permission: "schedule:write" },
      schema: {
        tags: ["routing"],
        summary: "Look up every site that is not on the map yet",
        description: "Runs in the background. With `retryNotFound`, addresses that could not be found before are tried again.",
        body: geocodeInput,
        response: { 202: z.object({ pending: z.number().int() }) },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      if (!geocoder) throw unprocessable("Finding addresses is turned off on this server.");
      const pending = await db.transaction().execute(async (trx) => {
        if (req.body.retryNotFound) {
          await trx.updateTable("sites").set({ geocodeStatus: null }).where("organizationId", "=", organizationId).where("geocodeStatus", "=", "not_found").execute();
        }
        const r = await trx
          .selectFrom("sites")
          .select(sql<number>`count(*)::int`.as("n"))
          .where("organizationId", "=", organizationId)
          .where("lat", "is", null)
          .where("geocodeStatus", "is", null)
          .where("active", "=", true)
          .executeTakeFirstOrThrow();
        await queueSiteLocating(trx, organizationId, `manual:${now().getTime()}`, now());
        await audit(trx, req, { action: "routing.locate_sites", entityType: "organization", entityId: organizationId, changes: { ...req.body, pending: r.n } });
        return r.n;
      });
      return reply.status(202).send({ pending });
    },
  );

  // ---- A day's routes ----

  app.get(
    "/routing/day",
    {
      config: { permission: "schedule:read" },
      schema: {
        tags: ["routing"],
        summary: "Each technician's route for a day: stops on the map, driving between them, and whether the day fits",
        querystring: z.object({ date }),
        response: { 200: routeDay },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const [s, rows] = await Promise.all([settingsOf(organizationId), dayStops(organizationId, req.query.date).execute()]);
      const byTech = new Map<string, DayStop[]>();
      for (const r of rows) byTech.set(r.technicianId, [...(byTech.get(r.technicianId) ?? []), r]);
      return {
        date: req.query.date,
        start: s.start,
        returnToStart: s.returnToStart,
        dayMinutes: s.dayMinutes,
        technicians: [...byTech.values()].map((stops) => technicianRoute(s, stops)),
      };
    },
  );

  app.post(
    "/routing/optimize",
    {
      config: { permission: "schedule:write" },
      schema: {
        tags: ["routing"],
        summary: "Find the shortest stop order for a technician's day, and optionally put it in place",
        description:
          "Stops already started or done stay first. Stops whose site is not on the map go last. The current order is kept unless the new one is meaningfully shorter.",
        body: optimizeInput,
        response: { 200: optimizeResult },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const { technicianId, scheduledDate, apply } = req.body;
      const s = await settingsOf(organizationId);
      if (!apply) {
        const stops = await dayStops(organizationId, scheduledDate, technicianId).execute();
        return { applied: false, ...plan(s, stops) };
      }
      return db.transaction().execute(async (trx) => {
        // Lock the day's jobs, as a manual reorder does, so the plan is made from what is there.
        await trx
          .selectFrom("jobs")
          .select("id")
          .where("organizationId", "=", organizationId)
          .where("technicianUserId", "=", technicianId)
          .where("scheduledDate", "=", scheduledDate)
          .where("status", "<>", "cancelled")
          .forUpdate()
          .execute();
        const stops = await dayStops(organizationId, scheduledDate, technicianId).execute();
        const result = plan(s, stops);
        if (result.changed) {
          for (const [i, jobId] of result.proposedJobIds.entries()) {
            await trx.updateTable("jobs").set({ routePosition: i + 1, updatedAt: new Date() }).where("organizationId", "=", organizationId).where("id", "=", jobId).execute();
          }
          await audit(trx, req, {
            action: "route.optimized",
            entityType: "technician_day",
            entityId: technicianId,
            changes: { scheduledDate, jobIds: result.proposedJobIds, before: result.before, after: result.after },
          });
        }
        return { applied: result.changed, ...result };
      });
    },
  );

  app.get(
    "/routing/nearby",
    {
      config: { permission: "schedule:read" },
      schema: {
        tags: ["routing"],
        summary: "Unscheduled visits ranked by how little driving they add to a technician's day",
        description: "Visits due within 30 days of the date (overdue ones too) whose site is on the map, closest first.",
        querystring: nearbyQuery,
        response: { 200: nearbyResult },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const { technicianId, date: day } = req.query;
      const [s, stops, visits] = await Promise.all([
        settingsOf(organizationId),
        dayStops(organizationId, day, technicianId).execute(),
        db
          .selectFrom("serviceObligations as o")
          .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "o.siteId").onRef("s.organizationId", "=", "o.organizationId"))
          .select(["o.id", "s.lat", "s.lng"])
          .where("o.organizationId", "=", organizationId)
          .where("o.status", "=", "open")
          .where("o.dueOn", "<=", addDays(day, 30))
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(
                selectFrom("jobs as j")
                  .select("j.id")
                  .whereRef("j.obligationId", "=", "o.id")
                  .whereRef("j.organizationId", "=", "o.organizationId")
                  .where("j.status", "<>", "cancelled"),
              ),
            ),
          )
          .execute(),
      ]);
      const route = stops.map(pointOf).filter((p): p is Point => p !== null);
      const dayMinutes = stops.length ? technicianRoute(s, stops).totalMinutes : 0;
      const items = visits
        .filter((v) => pointOf(v))
        .map((v) => {
          const miles = detourMiles(route, pointOf(v)!, { start: s.start, returnToStart: s.returnToStart });
          const minutes = Math.round(driveMinutes(miles, { speedMph: s.speedMph }));
          return { obligationId: v.id, detourMiles: miles, detourMinutes: minutes, fits: dayMinutes + minutes + s.stopMinutes <= s.dayMinutes };
        })
        .sort((a, b) => a.detourMiles - b.detourMiles);
      return { items, unlocated: visits.length - items.length };
    },
  );
};
