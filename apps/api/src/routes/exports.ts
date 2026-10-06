import type { Database } from "@aerowise/db";
import { dataExport, id, type DataExport } from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import { queueExport } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound } from "../lib/errors.ts";

const params = z.object({ id });

/**
 * Full data exports for the owner. Asking for one is allowed while the organization is
 * read-only: a lapsed company can always take its data with it.
 */
export const exportRoutes: FastifyPluginAsyncZod<{ db: Database; store: ObjectStore; now: () => Date }> = async (app, { db, store, now }) => {
  const list = (organizationId: string) =>
    db
      .selectFrom("dataExports as e")
      .innerJoin("users as u", "u.id", "e.requestedBy")
      .select(["e.id", "e.status", "e.requestedAt", "u.name as requestedBy", "e.finishedAt", "e.byteSize", "e.contents", "e.error", "e.storageKey"])
      .where("e.organizationId", "=", organizationId)
      .orderBy("e.requestedAt", "desc");

  const toItem = ({ storageKey: _, ...r }: Awaited<ReturnType<ReturnType<typeof list>["executeTakeFirstOrThrow"]>>): DataExport => ({
    ...r,
    requestedAt: r.requestedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    contents: r.contents as DataExport["contents"],
  });

  app.get(
    "/exports",
    {
      config: { permission: "data:export" },
      schema: { tags: ["exports"], summary: "Recent data exports", response: { 200: z.object({ items: z.array(dataExport) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      return { items: (await list(organizationId).limit(10).execute()).map(toItem) };
    },
  );

  app.post(
    "/exports",
    {
      config: { permission: "data:export", allowedWhenReadOnly: true },
      schema: {
        tags: ["exports"],
        summary: "Export everything: a zip of CSV files and documents, built in the background",
        response: { 201: dataExport },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      const exportId = await db.transaction().execute(async (trx) => {
        // One at a time: a second request while one is being built gets that one.
        const pending = await trx
          .selectFrom("dataExports")
          .select("id")
          .where("organizationId", "=", organizationId)
          .where("status", "=", "queued")
          .forUpdate()
          .executeTakeFirst();
        if (pending) return pending.id;
        const created = await trx
          .insertInto("dataExports")
          .values({ organizationId, requestedBy: userId, requestedAt: at })
          .returning("id")
          .executeTakeFirstOrThrow();
        await queueExport(trx, organizationId, created.id, at);
        await audit(trx, req, { action: "data_export.requested", entityType: "data_export", entityId: created.id });
        return created.id;
      });
      return reply.status(201).send(toItem(await list(organizationId).where("e.id", "=", exportId).executeTakeFirstOrThrow()));
    },
  );

  app.get(
    "/exports/:id/download",
    {
      config: { permission: "data:export" },
      schema: { tags: ["exports"], summary: "Download a finished export", params },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const row = await list(organizationId).where("e.id", "=", req.params.id).executeTakeFirst();
      if (!row) throw notFound("Export");
      if (row.status !== "ready" || !row.storageKey) throw new HttpError(409, "export_not_ready", "This export is not ready");
      const data = await store.get(row.storageKey);
      if (!data) throw notFound("Export file");
      const day = row.requestedAt.toISOString().slice(0, 10);
      const { demo } = await db.selectFrom("organizations").select("demo").where("id", "=", organizationId).executeTakeFirstOrThrow();
      return reply
        .type("application/zip")
        .header("content-disposition", `attachment; filename="aerowise-${demo ? "DEMO-" : ""}export-${day}.zip"`)
        .header("x-content-type-options", "nosniff")
        .send(data);
    },
  );
};
