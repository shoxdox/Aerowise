import type { Database } from "@aerowise/db";
import { formKey, formTemplate, formVersionInput, keyAllowedForPurpose, templatePurpose, type Feature } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { currentForms, FORM_COLUMNS, toForm } from "../lib/forms.ts";
import { featureOff } from "../lib/work-orders.ts";

// Work and intake forms (SW-F). The aerobic inspection form keeps its own routes
// (/inspection-template, /inspection-templates), which every earlier release uses.

const keyParams = z.object({ key: formKey });

export const formRoutes: FastifyPluginAsyncZod<{ db: Database; features: ReadonlySet<Feature> }> = async (app, { db, features }) => {
  app.get(
    "/form-templates",
    {
      config: { permission: "work:read" },
      schema: {
        tags: ["forms"],
        summary: "The forms the company uses now, one version per key",
        querystring: z.object({ purpose: templatePurpose.optional() }),
        response: { 200: z.object({ items: z.array(formTemplate) }) },
      },
    },
    async (req) => ({ items: await currentForms(db, req.requireAuth().organizationId, { purpose: req.query.purpose }) }),
  );

  app.get(
    "/form-templates/:key",
    {
      config: { permission: "work:read" },
      schema: { tags: ["forms"], summary: "The version of one form the company uses now", params: keyParams, response: { 200: formTemplate } },
    },
    async (req) => {
      const [form] = await currentForms(db, req.requireAuth().organizationId, { key: req.params.key });
      if (!form) throw notFound("Form");
      return form;
    },
  );

  app.post(
    "/form-templates/:key/versions",
    {
      config: { permission: "org:manage" },
      schema: {
        tags: ["forms"],
        summary: "Save a new version of a work form (earlier versions stay as they were)",
        params: keyParams,
        body: formVersionInput,
        response: { 201: formTemplate },
      },
    },
    async (req, reply) => {
      if (!features.has("work_orders")) throw featureOff();
      const { organizationId, userId } = req.requireAuth();
      const { key } = req.params;
      const row = await db.transaction().execute(async (trx) => {
        // The same lock the inspection form's versions use: one numbering per company.
        await sql`select pg_advisory_xact_lock(hashtext(${`inspection_templates:${organizationId}`}))`.execute(trx);
        const [current] = await currentForms(trx, organizationId, { key });
        if (!current) throw notFound("Form");
        // The inspection form has its own route; intake forms come with the plan builder.
        if (current.purpose !== "work" || !keyAllowedForPurpose(key, current.purpose)) {
          throw new HttpError(409, "wrong_purpose", "Only work forms can be changed here");
        }
        const latest = await trx
          .selectFrom("inspectionTemplates")
          .select(sql<number>`coalesce(max(version), 0)`.as("v"))
          .where("organizationId", "=", organizationId)
          .where("key", "=", key)
          .executeTakeFirstOrThrow();
        // A company's first own version follows the built-in one it replaces.
        const version = Math.max(Number(latest.v), current.builtIn ? current.version : 0) + 1;
        const created = await trx
          .insertInto("inspectionTemplates")
          .values({ organizationId, key, version, name: req.body.name, purpose: "work", definition: JSON.stringify(req.body.definition), createdBy: userId })
          .returning(FORM_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "form_template.versioned", entityType: "inspection_template", entityId: created.id, changes: { key, version } });
        return created;
      });
      return reply.status(201).send(toForm(row));
    },
  );
};
