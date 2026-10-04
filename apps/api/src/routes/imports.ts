import type { Database, DB } from "@aerowise/db";
import {
  analyzeImport,
  detectColumns,
  id,
  IMPORT_FIELDS,
  importDetail,
  importListItem,
  importMappingInput,
  importRowsInput,
  importUpload,
  MAX_IMPORT_BYTES,
  summarize,
  type AnalyzedRow,
  type ColumnMapping,
  type ExistingRecords,
} from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Insertable, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { insertContract, type Terms } from "../lib/contracts.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { parseSpreadsheet } from "../lib/import-parse.ts";
import { jsonRow } from "../lib/json.ts";

const params = z.object({ id });
const CHUNK = 500;

type ImportResult = { customers: number; sites: number; contracts: number };

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

export const importRoutes: FastifyPluginAsyncZod<{ db: Database }> = async (app, { db }) => {
  async function findImport(organizationId: string, importId: string) {
    const row = await db
      .selectFrom("imports")
      .select(["id", "filename", "status", "headers", "mapping", "createdAt", "committedAt", "error", "result"])
      .where("organizationId", "=", organizationId)
      .where("id", "=", importId)
      .executeTakeFirst();
    if (!row) throw notFound("Import");
    return { ...row, headers: row.headers as string[], mapping: row.mapping as ColumnMapping, result: row.result as ImportResult | null };
  }

  async function activePlans(organizationId: string) {
    const rows = await db
      .selectFrom("plans")
      .select(["id", "name", "termMonths", "visitsPerTerm", "priceCents", "billingFrequency", "serviceType"])
      .where("organizationId", "=", organizationId)
      .where("active", "=", true)
      .execute();
    return new Map<string, Terms>(
      rows.map(({ id: planId, name, ...p }) => [name, { ...p, planId, planName: name }]),
    );
  }

  /** Customers, sites and plans already on file, leaving out what this import itself created. */
  async function existingRecords(organizationId: string, importId: string, plans: Map<string, Terms>): Promise<ExistingRecords> {
    const [customers, contacts, sites] = await Promise.all([
      db
        .selectFrom("customers")
        .select(["id", "displayName"])
        .where("organizationId", "=", organizationId)
        .where((eb) => eb.or([eb("importId", "is", null), eb("importId", "!=", importId)]))
        .execute(),
      db.selectFrom("contacts").select(["customerId", "phone", "email"]).where("organizationId", "=", organizationId).execute(),
      db
        .selectFrom("sites")
        .select(["id", "addressLine1", "city", "permitNumber"])
        .where("organizationId", "=", organizationId)
        .where((eb) => eb.or([eb("importId", "is", null), eb("importId", "!=", importId)]))
        .execute(),
    ]);
    const byCustomer = new Map<string, { phones: string[]; emails: string[] }>();
    for (const c of contacts) {
      const entry = byCustomer.get(c.customerId) ?? { phones: [], emails: [] };
      if (c.phone) entry.phones.push(c.phone);
      if (c.email) entry.emails.push(c.email.toLowerCase());
      byCustomer.set(c.customerId, entry);
    }
    return {
      customers: customers.map((c) => ({ ...c, ...(byCustomer.get(c.id) ?? { phones: [], emails: [] }) })),
      sites,
      plans: [...plans.keys()],
    };
  }

  async function analyze(organizationId: string, imp: Awaited<ReturnType<typeof findImport>>) {
    const plans = await activePlans(organizationId);
    const [rows, existing] = await Promise.all([
      db
        .selectFrom("importRows")
        .select(["rowNo", "raw", "include", "customerId", "siteId", "contractId"])
        .where("organizationId", "=", organizationId)
        .where("importId", "=", imp.id)
        .orderBy("rowNo")
        .execute(),
      existingRecords(organizationId, imp.id, plans),
    ]);
    const analyzed = analyzeImport(
      rows.map((r) => ({ rowNo: r.rowNo, raw: r.raw as string[], include: r.include })),
      imp.mapping,
      existing,
    );
    rows.forEach((r, i) => {
      if (r.customerId && r.siteId) analyzed[i]!.result = { customerId: r.customerId, siteId: r.siteId, contractId: r.contractId };
    });
    return { rows: analyzed, plans };
  }

  async function detail(organizationId: string, importId: string) {
    const imp = await findImport(organizationId, importId);
    const { rows } = await analyze(organizationId, imp);
    return {
      ...jsonRow(imp),
      mapping: imp.mapping as Record<string, number>,
      summary: summarize(rows),
      rows: rows.map(({ customerKey: _, ...row }) => row),
    };
  }

  const requirePreview = (imp: { status: string }, allowFailed = false) => {
    if (imp.status === "preview" || (allowFailed && imp.status === "failed")) return;
    throw new HttpError(409, "import_closed", `This import is already ${imp.status}`);
  };

  app.get(
    "/imports",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["imports"], summary: "Recent imports", response: { 200: z.object({ items: z.array(importListItem) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const rows = await db
        .selectFrom("imports as i")
        .select(["i.id", "i.filename", "i.status", "i.createdAt", "i.committedAt", "i.result"])
        .select((eb) =>
          eb.selectFrom("importRows as r").select(sql<number>`count(*)::int`.as("n")).whereRef("r.importId", "=", "i.id").as("rowCount"),
        )
        .where("i.organizationId", "=", organizationId)
        .orderBy("i.createdAt", "desc")
        .limit(50)
        .execute();
      return { items: rows.map(({ rowCount, result, ...r }) => ({ ...jsonRow(r), result: result as ImportResult | null, rows: rowCount ?? 0 })) };
    },
  );

  app.post(
    "/imports",
    {
      config: { permission: "crm:write" },
      bodyLimit: Math.ceil((MAX_IMPORT_BYTES * 4) / 3) + 64 * 1024,
      schema: { tags: ["imports"], summary: "Upload a CSV or XLSX file and preview it", body: importUpload, response: { 201: importDetail } },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const bytes = Buffer.from(req.body.contentBase64, "base64");
      if (bytes.length === 0) throw unprocessable("The file is empty");
      if (bytes.length > MAX_IMPORT_BYTES) throw unprocessable("The file is larger than 10 MB");
      const sheet = await parseSpreadsheet(req.body.filename, bytes);
      const mapping = detectColumns(
        sheet.headers,
        sheet.rows.slice(0, 50).map((r) => r.raw),
      );
      const created = await db.transaction().execute(async (trx) => {
        const imp = await trx
          .insertInto("imports")
          .values({
            organizationId: auth.organizationId,
            filename: req.body.filename,
            headers: JSON.stringify(sheet.headers),
            mapping: JSON.stringify(mapping),
            createdBy: auth.userId,
            committedAt: null,
            error: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        for (const part of chunks(sheet.rows)) {
          await trx
            .insertInto("importRows")
            .values(
              part.map((r) => ({
                organizationId: auth.organizationId,
                importId: imp.id,
                rowNo: r.rowNo,
                raw: JSON.stringify(r.raw),
                include: null,
                customerId: null,
                siteId: null,
                contractId: null,
              })),
            )
            .execute();
        }
        await audit(trx, req, {
          action: "import.created",
          entityType: "import",
          entityId: imp.id,
          changes: { filename: req.body.filename, rows: sheet.rows.length, mapping },
        });
        return imp;
      });
      return reply.status(201).send(await detail(auth.organizationId, created.id));
    },
  );

  app.get(
    "/imports/:id",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["imports"], summary: "An import's preview: each row, its problems and duplicates", params, response: { 200: importDetail } },
    },
    async (req) => detail(req.requireAuth().organizationId, req.params.id),
  );

  app.put(
    "/imports/:id/mapping",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["imports"], summary: "Change which column holds which field", params, body: importMappingInput, response: { 200: importDetail } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const imp = await findImport(organizationId, req.params.id);
      requirePreview(imp, true);
      const mapping: ColumnMapping = {};
      const used = new Set<number>();
      for (const field of IMPORT_FIELDS) {
        const col = req.body.mapping[field];
        if (col === null || col === undefined) continue;
        if (col >= imp.headers.length) throw unprocessable(`The file has no column ${col + 1}`);
        if (used.has(col)) throw unprocessable(`Column "${imp.headers[col]}" is used for more than one field`);
        used.add(col);
        mapping[field] = col;
      }
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("imports").set({ mapping: JSON.stringify(mapping) }).where("id", "=", imp.id).execute();
        await audit(trx, req, { action: "import.mapping_changed", entityType: "import", entityId: imp.id, changes: { mapping } });
      });
      return detail(organizationId, imp.id);
    },
  );

  app.post(
    "/imports/:id/rows",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["imports"], summary: "Include or leave out rows", params, body: importRowsInput, response: { 200: importDetail } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const imp = await findImport(organizationId, req.params.id);
      requirePreview(imp, true);
      const { include, exclude } = req.body;
      if (include.some((n) => exclude.includes(n))) throw unprocessable("A row cannot be both included and left out");
      await db.transaction().execute(async (trx) => {
        for (const [rows, value] of [[include, true], [exclude, false]] as const) {
          if (rows.length === 0) continue;
          await trx
            .updateTable("importRows")
            .set({ include: value })
            .where("organizationId", "=", organizationId)
            .where("importId", "=", imp.id)
            .where("rowNo", "in", rows)
            .execute();
        }
        await audit(trx, req, { action: "import.rows_changed", entityType: "import", entityId: imp.id, changes: { include, exclude } });
      });
      return detail(organizationId, imp.id);
    },
  );

  app.post(
    "/imports/:id/commit",
    {
      config: { permission: "crm:write" },
      schema: {
        tags: ["imports"],
        summary: "Save the included rows, all or nothing",
        description: "Creates customers, contacts, sites, systems and contracts in one transaction. If anything fails, nothing is saved and the import is marked failed.",
        params,
        response: { 200: importDetail },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const imp = await findImport(organizationId, req.params.id);
      requirePreview(imp, true);
      const { rows, plans } = await analyze(organizationId, imp);
      const included = rows.filter((r) => r.include);
      if (included.length === 0) throw unprocessable("No rows are included");
      try {
        await db.transaction().execute(async (trx) => {
          const result = await saveRows(trx, organizationId, imp.id, included, plans);
          const done = await trx
            .updateTable("imports")
            .set({ status: "committed", committedAt: new Date(), error: null, result: JSON.stringify(result) })
            .where("id", "=", imp.id)
            .where("status", "in", ["preview", "failed"])
            .returning("id")
            .executeTakeFirst();
          // Two commits at once: the second finds the import already committed.
          if (!done) throw new HttpError(409, "import_closed", "This import was committed by someone else");
          await audit(trx, req, { action: "import.committed", entityType: "import", entityId: imp.id, changes: { ...result, rows: included.length } });
        });
      } catch (err) {
        if (err instanceof HttpError && err.code === "import_closed") throw err;
        const message = (err as Error).message;
        req.log.warn({ err, importId: imp.id }, "import failed and was rolled back");
        await db.transaction().execute(async (trx) => {
          await trx.updateTable("imports").set({ status: "failed", error: message }).where("id", "=", imp.id).execute();
          await audit(trx, req, { action: "import.failed", entityType: "import", entityId: imp.id, changes: { error: message } });
        });
        throw new HttpError(422, "import_failed", `Nothing was imported: ${message}`);
      }
      return detail(organizationId, imp.id);
    },
  );

  app.post(
    "/imports/:id/discard",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["imports"], summary: "Throw away an import that was not committed", params, response: { 200: importDetail } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const imp = await findImport(organizationId, req.params.id);
      requirePreview(imp, true);
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("imports").set({ status: "discarded" }).where("id", "=", imp.id).execute();
        await audit(trx, req, { action: "import.discarded", entityType: "import", entityId: imp.id });
      });
      return detail(organizationId, imp.id);
    },
  );
};

/** Inserts everything the included rows describe, in the caller's transaction. */
async function saveRows(trx: Transaction<DB>, organizationId: string, importId: string, rows: AnalyzedRow[], plans: Map<string, Terms>) {
  const customerIds = new Map<string, string>();
  const customers: Insertable<DB["customers"]>[] = [];
  const contacts: Insertable<DB["contacts"]>[] = [];
  const sites: Insertable<DB["sites"]>[] = [];
  const systems: Insertable<DB["wastewaterSystems"]>[] = [];
  const results: { rowNo: number; customerId: string; siteId: string; contractId: string | null }[] = [];

  for (const row of rows) {
    const r = row.record;
    let customerId = row.existingCustomer?.id ?? customerIds.get(row.customerKey);
    if (!customerId) {
      customerId = crypto.randomUUID();
      customerIds.set(row.customerKey, customerId);
      customers.push({
        id: customerId,
        organizationId,
        displayName: r.customerName!,
        source: "import",
        importId,
        notes: null,
        billingLine1: null,
        billingLine2: null,
        billingCity: null,
        billingState: null,
        billingPostalCode: null,
      });
      if (r.phone || r.email) contacts.push({ organizationId, customerId, siteId: null, name: r.customerName!, email: r.email, phone: r.phone });
    }
    const siteId = crypto.randomUUID();
    sites.push({
      id: siteId,
      organizationId,
      customerId,
      addressLine1: r.addressLine1!,
      addressLine2: r.addressLine2,
      city: r.city!,
      state: r.state,
      postalCode: r.postalCode,
      county: r.county,
      lat: null,
      lng: null,
      permitNumber: r.permitNumber,
      accessNotes: r.accessNotes,
      gateCode: r.gateCode,
      schedulingNotes: null,
      importId,
    });
    if (r.manufacturer || r.model || r.serial) systems.push({ organizationId, siteId, manufacturer: r.manufacturer, model: r.model, serial: r.serial });
    results.push({ rowNo: row.rowNo, customerId, siteId, contractId: null });
  }

  for (const part of chunks(customers)) await trx.insertInto("customers").values(part).execute();
  for (const part of chunks(contacts)) await trx.insertInto("contacts").values(part).execute();
  for (const part of chunks(sites)) await trx.insertInto("sites").values(part).execute();
  for (const part of chunks(systems)) await trx.insertInto("wastewaterSystems").values(part).execute();

  let contracts = 0;
  for (const [i, row] of rows.entries()) {
    const terms = row.record.planName ? plans.get(row.record.planName) : undefined;
    if (!terms || !row.record.contractStart) continue;
    results[i]!.contractId = await insertContract(trx, organizationId, { siteId: results[i]!.siteId, startOn: row.record.contractStart, terms, autoRenew: false });
    contracts++;
  }

  for (const part of chunks(results)) {
    await sql`
      update import_rows r
      set customer_id = v.customer_id, site_id = v.site_id, contract_id = v.contract_id
      from unnest(${part.map((p) => p.rowNo)}::int[], ${part.map((p) => p.customerId)}::uuid[], ${part.map((p) => p.siteId)}::uuid[], ${part.map((p) => p.contractId)}::uuid[])
        as v(row_no, customer_id, site_id, contract_id)
      where r.import_id = ${importId} and r.row_no = v.row_no`.execute(trx);
  }
  return { customers: customers.length, sites: sites.length, contracts };
}
