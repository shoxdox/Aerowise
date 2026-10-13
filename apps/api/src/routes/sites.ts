import type { Database } from "@aerowise/db";
import { id, site, siteDetail, siteListItem, sitePatch, systemInput, systemPatch, wastewaterSystem } from "@aerowise/domain";
import { queueSiteLocating } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { notFound, unprocessable } from "../lib/errors.ts";
import { expiringContracts } from "../lib/expiring-contracts.ts";
import { organizationToday } from "../lib/today.ts";
import { definedOnly } from "../lib/json.ts";
import { CONTACT_COLUMNS, PERMIT_NOTE_NEEDED, SITE_COLUMNS, siteRow } from "./customers.ts";

const SYSTEM_COLUMNS = [
  "id",
  "siteId",
  "manufacturer",
  "model",
  "serial",
  "installedAt",
  "systemType",
  "treatmentType",
  "disposalType",
  "chlorinationMethod",
  "systemCategory",
  "notes",
  "active",
] as const;

const params = z.object({ id });
const ADDRESS_COLUMNS = ["addressLine1", "addressLine2", "city", "state", "postalCode"] as const;

export const siteRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  app.get(
    "/sites",
    {
      config: { permission: "crm:read" },
      schema: {
        tags: ["sites"],
        summary: "List service sites, searching address, city and permit number",
        querystring: z.object({
          search: z.string().trim().max(200).optional(),
          contractsExpiring: z.stringbool().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: z.object({ items: z.array(siteListItem), total: z.number().int() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const { search, limit, offset } = req.query;
      let base = db
        .selectFrom("sites as s")
        .innerJoin("customers as c", (join) =>
          join.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"),
        )
        .where("s.organizationId", "=", organizationId);
      if (req.query.contractsExpiring) {
        const today = await organizationToday(db, organizationId, now());
        base = base.where((eb) => eb.exists(expiringContracts(db, organizationId, today).select("k.id").where("k.siteId", "=", sql<string>`s.id`)));
      }
      if (search) {
        const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        base = base.where((eb) =>
          eb.or([eb("s.addressLine1", "ilike", pattern), eb("s.city", "ilike", pattern), eb("s.permitNumber", "ilike", pattern)]),
        );
      }
      const [items, count] = await Promise.all([
        base
          .select(SITE_COLUMNS.map((c) => `s.${c}` as const))
          .select("c.displayName as customerName")
          .orderBy("s.city")
          .orderBy("s.addressLine1")
          .orderBy("s.id")
          .limit(limit)
          .offset(offset)
          .execute(),
        base.select(sql<number>`count(*)::int`.as("total")).executeTakeFirstOrThrow(),
      ]);
      return { items: items.map(siteRow), total: count.total };
    },
  );

  app.get("/sites/:id/overview", { config: { permission: "crm:read" }, schema: { tags: ["sites"], summary: "Current operating context and next action for one authorized site", params } }, async (req) => {
    const { organizationId } = req.requireAuth();
    const site = await db.selectFrom("sites").select("id").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
    if (!site) throw notFound("Site");
    const today = await organizationToday(db, organizationId, now());
    const [contract, obligation, visit, report, issues] = await Promise.all([
      db.selectFrom("contracts").select(["id", "planName", "startOn", "endOn"]).where("organizationId", "=", organizationId).where("siteId", "=", site.id).where("status", "=", "active").where("startOn", "<=", today).where("endOn", ">=", today).orderBy("startOn", "desc").executeTakeFirst(),
      db.selectFrom("serviceObligations").select(["id", "dueOn", "serviceType"]).where("organizationId", "=", organizationId).where("siteId", "=", site.id).where("status", "=", "open").orderBy("dueOn").executeTakeFirst(),
      db.selectFrom("jobs as j").innerJoin("users as u", "u.id", "j.technicianUserId").select(["j.id", "j.scheduledDate", "u.name"]).where("j.organizationId", "=", organizationId).where("j.siteId", "=", site.id).where("j.status", "in", ["scheduled", "in_progress"]).orderBy("j.scheduledDate").executeTakeFirst(),
      db.selectFrom("reports as r").leftJoin("reportSignatures as sig", (j) => j.onRef("sig.reportId", "=", "r.id").onRef("sig.organizationId", "=", "r.organizationId")).leftJoin("filings as f", (j) => j.onRef("f.inspectionId", "=", "r.inspectionId").onRef("f.organizationId", "=", "r.organizationId")).select(["r.id", "r.version", "r.generatedAt", "sig.signedAt", "f.id as filingId", "f.status as filingStatus"]).where("r.organizationId", "=", organizationId).where("r.siteId", "=", site.id).where("r.audience", "=", "authority").orderBy("r.generatedAt", "desc").orderBy("r.version", "desc").executeTakeFirst(),
      db.selectFrom("issues").select(["id", "description", "severity", "workOrderId"]).where("organizationId", "=", organizationId).where("siteId", "=", site.id).where("status", "=", "open").orderBy("createdAt", "desc").execute(),
    ]);
    return { today, contract: contract ?? null, obligation: obligation ?? null, visit: visit ?? null, report: report ? { ...report, generatedAt: report.generatedAt.toISOString(), signedAt: report.signedAt?.toISOString() ?? null } : null, issues };
  });

  app.get(
    "/sites/:id",
    {
      config: { permission: "crm:read" },
      schema: { tags: ["sites"], summary: "Site with customer, contacts and wastewater systems", params, response: { 200: siteDetail } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const row = await db
        .selectFrom("sites as s")
        .innerJoin("customers as c", (join) =>
          join.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"),
        )
        .select(SITE_COLUMNS.map((c) => `s.${c}` as const))
        .select("c.displayName as customerName")
        .where("s.organizationId", "=", organizationId)
        .where("s.id", "=", req.params.id)
        .executeTakeFirst();
      if (!row) throw notFound("Site");
      const [contacts, systems] = await Promise.all([
        db
          .selectFrom("contacts")
          .select(CONTACT_COLUMNS)
          .where("organizationId", "=", organizationId)
          .where("customerId", "=", row.customerId)
          .where((eb) => eb.or([eb("siteId", "is", null), eb("siteId", "=", row.id)]))
          .orderBy("createdAt")
          .execute(),
        db
          .selectFrom("wastewaterSystems")
          .select(SYSTEM_COLUMNS)
          .where("organizationId", "=", organizationId)
          .where("siteId", "=", row.id)
          .orderBy("createdAt")
          .execute(),
      ]);
      const { customerName, ...rest } = row;
      return { ...siteRow(rest), customer: { id: row.customerId, displayName: customerName }, contacts, systems };
    },
  );

  app.patch(
    "/sites/:id",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["sites"], summary: "Update a site", params, body: sitePatch, response: { 200: site } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const row = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("sites")
          .select(["id", ...ADDRESS_COLUMNS, "locationSource", "permitIntervalMonths", "permitIntervalNote"])
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw notFound("Site");
        const { lat, lng, ...fields } = definedOnly(req.body);
        const permitMonths = fields.permitIntervalMonths !== undefined ? fields.permitIntervalMonths : current.permitIntervalMonths;
        const permitNote = fields.permitIntervalNote !== undefined ? fields.permitIntervalNote : current.permitIntervalNote;
        if (permitMonths != null && !permitNote) throw unprocessable(PERMIT_NOTE_NEEDED);
        const addressChanged = ADDRESS_COLUMNS.some((c) => fields[c] !== undefined && fields[c] !== current[c]);
        let location = {};
        if (lat !== undefined || lng !== undefined) {
          // Coordinates typed in by a person. Both, or neither to have the address looked up.
          if ((lat ?? null) === null !== ((lng ?? null) === null)) throw unprocessable("Give both lat and lng, or neither");
          location = lat != null ? { lat, lng, locationSource: "manual", geocodeStatus: null } : { lat: null, lng: null, locationSource: null, geocodeStatus: null };
        } else if (addressChanged) {
          // A new address: found coordinates are found again; typed ones are kept.
          location = current.locationSource === "manual" ? {} : { lat: null, lng: null, locationSource: null, geocodeStatus: null };
        }
        const updated = await trx
          .updateTable("sites")
          .set({ ...fields, ...location, updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", current.id)
          .returning(SITE_COLUMNS)
          .executeTakeFirstOrThrow();
        if (updated.lat === null && updated.geocodeStatus === null) {
          await queueSiteLocating(trx, organizationId, `site:${updated.id}:${updated.updatedAt.getTime()}`, now());
        }
        await audit(trx, req, { action: "site.updated", entityType: "site", entityId: updated.id, changes: req.body });
        return updated;
      });
      return siteRow(row);
    },
  );

  app.post(
    "/sites/:id/systems",
    {
      config: { permission: "crm:write" },
      schema: {
        tags: ["systems"],
        summary: "Add a wastewater system to a site",
        params,
        body: systemInput,
        response: { 201: wastewaterSystem },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const parent = await db
        .selectFrom("sites")
        .select("id")
        .where("organizationId", "=", organizationId)
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!parent) throw notFound("Site");
      const row = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("wastewaterSystems")
          .values({ ...definedOnly(req.body), organizationId, siteId: parent.id })
          .returning(SYSTEM_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "system.created", entityType: "wastewater_system", entityId: created.id, changes: req.body });
        return created;
      });
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/systems/:id",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["systems"], summary: "Update a wastewater system", params, body: systemPatch, response: { 200: wastewaterSystem } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      return db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("wastewaterSystems")
          .set({ ...definedOnly(req.body), updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning(SYSTEM_COLUMNS)
          .executeTakeFirst();
        if (!updated) throw notFound("Wastewater system");
        await audit(trx, req, { action: "system.updated", entityType: "wastewater_system", entityId: updated.id, changes: req.body });
        return updated;
      });
    },
  );
};
