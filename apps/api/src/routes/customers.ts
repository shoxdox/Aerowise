import type { Database } from "@aerowise/db";
import {
  contact,
  contactInput,
  contactPatch,
  customer,
  customerDetail,
  customerInput,
  customerListItem,
  customerPatch,
  id,
  site,
  siteInput,
  toE164,
} from "@aerowise/domain";
import { queueSiteLocating } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { notFound, unprocessable } from "../lib/errors.ts";
import { definedOnly, jsonRow } from "../lib/json.ts";

const CUSTOMER_COLUMNS = [
  "id",
  "displayName",
  "billingLine1",
  "billingLine2",
  "billingCity",
  "billingState",
  "billingPostalCode",
  "status",
  "source",
  "tags",
  "notes",
  "createdAt",
  "updatedAt",
] as const;

export const CONTACT_COLUMNS = ["id", "customerId", "siteId", "name", "email", "phone", "type", "consentEmail", "consentSms"] as const;

/** A permit's own inspection interval is only recorded with where it was read. */
export const PERMIT_NOTE_NEEDED = "Say where the permit's inspection interval was read (permitIntervalNote)";

export const SITE_COLUMNS = [
  "id",
  "customerId",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "county",
  "lat",
  "lng",
  "locationSource",
  "geocodeStatus",
  "permitNumber",
  "permitIntervalMonths",
  "permitIntervalNote",
  "accessNotes",
  "gateCode",
  "safetyFlags",
  "schedulingNotes",
  "customerType",
  "active",
  "createdAt",
  "updatedAt",
] as const;

type SafetyFlag = z.infer<typeof site>["safetyFlags"][number];

export function siteRow<T extends { safetyFlags: string[]; createdAt: Date; updatedAt: Date }>(row: T) {
  return { ...jsonRow(row), safetyFlags: row.safetyFlags as SafetyFlag[] };
}

const params = z.object({ id });
const listQuery = z.object({
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const customerRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  const findCustomer = async (organizationId: string, customerId: string) => {
    const row = await db
      .selectFrom("customers")
      .select(CUSTOMER_COLUMNS)
      .where("organizationId", "=", organizationId)
      .where("id", "=", customerId)
      .executeTakeFirst();
    if (!row) throw notFound("Customer");
    return row;
  };

  app.get(
    "/customers",
    {
      config: { permission: "crm:read" },
      schema: {
        tags: ["customers"],
        summary: "List customers, searching name, site address and permit number",
        querystring: listQuery,
        response: { 200: z.object({ items: z.array(customerListItem), total: z.number().int() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const { search, limit, offset } = req.query;
      let base = db.selectFrom("customers as c").where("c.organizationId", "=", organizationId);
      if (search) {
        const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        base = base.where((eb) =>
          eb.or([
            eb("c.displayName", "ilike", pattern),
            eb.exists(
              eb
                .selectFrom("sites as s")
                .select("s.id")
                .whereRef("s.customerId", "=", "c.id")
                .where("s.organizationId", "=", organizationId)
                .where((se) => se.or([se("s.addressLine1", "ilike", pattern), se("s.permitNumber", "ilike", pattern)])),
            ),
          ]),
        );
      }
      const [items, count] = await Promise.all([
        base
          .select(CUSTOMER_COLUMNS.map((c) => `c.${c}` as const))
          .select((eb) =>
            eb
              .selectFrom("sites as s")
              .select(sql<number>`count(*)::int`.as("n"))
              .whereRef("s.customerId", "=", "c.id")
              .where("s.organizationId", "=", organizationId)
              .as("siteCount"),
          )
          .orderBy(sql`lower(c.display_name)`)
          .orderBy("c.id")
          .limit(limit)
          .offset(offset)
          .execute(),
        base.select(sql<number>`count(*)::int`.as("total")).executeTakeFirstOrThrow(),
      ]);
      return { items: items.map((row) => jsonRow({ ...row, siteCount: row.siteCount ?? 0 })), total: count.total };
    },
  );

  app.post(
    "/customers",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["customers"], summary: "Create a customer", body: customerInput, response: { 201: customer } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const row = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("customers")
          .values({ ...definedOnly(req.body), organizationId })
          .returning(CUSTOMER_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "customer.created", entityType: "customer", entityId: created.id, changes: req.body });
        return created;
      });
      return reply.status(201).send(jsonRow(row));
    },
  );

  app.get(
    "/customers/:id",
    {
      config: { permission: "crm:read" },
      schema: { tags: ["customers"], summary: "Customer with contacts and sites", params, response: { 200: customerDetail } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const row = await findCustomer(organizationId, req.params.id);
      const [contacts, sites] = await Promise.all([
        db
          .selectFrom("contacts")
          .select(CONTACT_COLUMNS)
          .where("organizationId", "=", organizationId)
          .where("customerId", "=", row.id)
          .orderBy("createdAt")
          .execute(),
        db
          .selectFrom("sites")
          .select(SITE_COLUMNS)
          .where("organizationId", "=", organizationId)
          .where("customerId", "=", row.id)
          .orderBy("createdAt")
          .execute(),
      ]);
      return { ...jsonRow(row), contacts, sites: sites.map(siteRow) };
    },
  );

  app.patch(
    "/customers/:id",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["customers"], summary: "Update a customer", params, body: customerPatch, response: { 200: customer } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const row = await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("customers")
          .set({ ...definedOnly(req.body), updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning(CUSTOMER_COLUMNS)
          .executeTakeFirst();
        if (!updated) throw notFound("Customer");
        await audit(trx, req, { action: "customer.updated", entityType: "customer", entityId: updated.id, changes: req.body });
        return updated;
      });
      return jsonRow(row);
    },
  );

  // A contact may be tied to one of the customer's own sites, never another customer's.
  const assertSiteBelongsToCustomer = async (organizationId: string, customerId: string, siteId: string | null | undefined) => {
    if (!siteId) return;
    const found = await db
      .selectFrom("sites")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("customerId", "=", customerId)
      .where("id", "=", siteId)
      .executeTakeFirst();
    if (!found) throw unprocessable("siteId does not belong to this customer");
  };

  /**
   * A number that replied STOP gets no texts until the customer texts START; the office
   * cannot sign it back up.
   */
  const assertNotOptedOut = async (organizationId: string, phone: string | null | undefined) => {
    const e164 = toE164(phone);
    if (!e164) return;
    const out = await db.selectFrom("smsOptOuts").select("phone").where("organizationId", "=", organizationId).where("phone", "=", e164).executeTakeFirst();
    if (out) throw unprocessable("This number replied STOP to our texts. Only the customer can turn texts back on, by texting START.");
  };

  app.post(
    "/customers/:id/contacts",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["contacts"], summary: "Add a contact to a customer", params, body: contactInput, response: { 201: contact } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const parent = await findCustomer(organizationId, req.params.id);
      await assertSiteBelongsToCustomer(organizationId, parent.id, req.body.siteId);
      if (req.body.consentSms) await assertNotOptedOut(organizationId, req.body.phone);
      const row = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("contacts")
          .values({ ...definedOnly(req.body), organizationId, customerId: parent.id })
          .returning(CONTACT_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "contact.created", entityType: "contact", entityId: created.id, changes: req.body });
        return created;
      });
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/contacts/:id",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["contacts"], summary: "Update a contact", params, body: contactPatch, response: { 200: contact } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const existing = await db
        .selectFrom("contacts")
        .select(["id", "customerId", "phone", "consentSms"])
        .where("organizationId", "=", organizationId)
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!existing) throw notFound("Contact");
      await assertSiteBelongsToCustomer(organizationId, existing.customerId, req.body.siteId);
      const consentSms = req.body.consentSms ?? existing.consentSms;
      if (consentSms && (req.body.consentSms === true || req.body.phone !== undefined)) {
        await assertNotOptedOut(organizationId, req.body.phone !== undefined ? req.body.phone : existing.phone);
      }
      return db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("contacts")
          .set({ ...definedOnly(req.body), updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", existing.id)
          .returning(CONTACT_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "contact.updated", entityType: "contact", entityId: updated.id, changes: req.body });
        return updated;
      });
    },
  );

  app.post(
    "/customers/:id/sites",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["sites"], summary: "Add a service site to a customer", params, body: siteInput, response: { 201: site } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const parent = await findCustomer(organizationId, req.params.id);
      const row = await db.transaction().execute(async (trx) => {
        const { lat, lng, ...fields } = definedOnly(req.body);
        const located = lat != null && lng != null;
        if (!located && (lat != null || lng != null)) throw unprocessable("Give both lat and lng, or neither");
        if (fields.permitIntervalMonths != null && !fields.permitIntervalNote) throw unprocessable(PERMIT_NOTE_NEEDED);
        const created = await trx
          .insertInto("sites")
          .values({ ...fields, ...(located ? { lat, lng, locationSource: "manual" as const } : {}), organizationId, customerId: parent.id })
          .returning(SITE_COLUMNS)
          .executeTakeFirstOrThrow();
        if (!located) await queueSiteLocating(trx, organizationId, `site:${created.id}`, now());
        await audit(trx, req, { action: "site.created", entityType: "site", entityId: created.id, changes: req.body });
        return created;
      });
      return reply.status(201).send(siteRow(row));
    },
  );
};
