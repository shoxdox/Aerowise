import type { Database } from "@aerowise/db";
import { id, serviceItem, serviceItemInput, serviceItemListQuery, serviceItemPatch, type Feature } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound } from "../lib/errors.ts";

// The service item catalog (SW-3 of the service workflows plan): what a company charges for,
// by the hour, gallon, foot, visit or each. Lines copy an item's description and price, so
// changing or switching off an item never changes a line already written.

const params = z.object({ id });
const COLUMNS = ["id", "name", "description", "unit", "unitPriceCents", "taxable", "category", "active"] as const;

const duplicateName = (err: unknown, name: string | undefined) => {
  if ((err as { code?: string }).code === "23505") throw new HttpError(409, "duplicate_name", `There is already an active service item named ${name ?? "that"}`);
  throw err;
};

export const serviceItemRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; features: ReadonlySet<Feature> }> = async (app, { db, now, features }) => {
  app.get(
    "/service-items",
    {
      config: { permission: "work:read" },
      schema: { tags: ["work"], summary: "The company's service items, by name", querystring: serviceItemListQuery, response: { 200: z.object({ items: z.array(serviceItem) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      let q = db.selectFrom("serviceItems").select(COLUMNS).where("organizationId", "=", organizationId);
      if (req.query.active !== "all") q = q.where("active", "=", req.query.active === "true");
      return { items: await q.orderBy("name").execute() };
    },
  );

  app.post(
    "/service-items",
    { config: { permission: "invoices:write" }, schema: { tags: ["work"], summary: "Add a service item", body: serviceItemInput, response: { 201: serviceItem } } },
    async (req, reply) => {
      if (!features.has("service_items")) throw new HttpError(409, "feature_off", "Service items are not switched on for this deployment");
      const { organizationId } = req.requireAuth();
      const created = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto("serviceItems")
          .values({ organizationId, ...req.body, updatedAt: now() })
          .returning(COLUMNS)
          .executeTakeFirstOrThrow()
          .catch((err) => duplicateName(err, req.body.name));
        await audit(trx, req, { action: "service_item.created", entityType: "service_item", entityId: row.id, changes: req.body });
        return row;
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/service-items/:id",
    {
      config: { permission: "invoices:write" },
      schema: { tags: ["work"], summary: "Change or switch off a service item", description: "Lines already written keep their own description and price.", params, body: serviceItemPatch, response: { 200: serviceItem } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      return db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable("serviceItems")
          .set({ ...req.body, updatedAt: now() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning(COLUMNS)
          .executeTakeFirst()
          .catch((err) => duplicateName(err, req.body.name));
        if (!row) throw notFound("Service item");
        await audit(trx, req, { action: "service_item.updated", entityType: "service_item", entityId: row.id, changes: req.body });
        return row;
      });
    },
  );
};
