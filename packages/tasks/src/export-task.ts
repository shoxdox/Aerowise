import type { Database, DB } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import { zipSync } from "fflate";
import { sql, type Transaction } from "kysely";
import { enqueue } from "./queue.ts";

export const EXPORT_DATA = "export.build";

type Executor = Database | Transaction<DB>;

/**
 * The CSV files of a full export: file name, table, and columns left out. Every column
 * of every row the organization owns goes in, except secrets that would let someone act
 * as the customer (an invoice's pay-link token) and signature images, which the signed
 * PDFs already show.
 */
export const EXPORT_TABLES: { file: string; table: string; omit?: string[] }[] = [
  { file: "customers.csv", table: "customers" },
  { file: "contacts.csv", table: "contacts" },
  { file: "sites.csv", table: "sites" },
  { file: "systems.csv", table: "wastewater_systems" },
  { file: "contracts.csv", table: "contracts" },
  { file: "visits.csv", table: "service_obligations" },
  { file: "jobs.csv", table: "jobs" },
  { file: "inspections.csv", table: "inspections" },
  { file: "inspection_values.csv", table: "inspection_values" },
  { file: "invoices.csv", table: "invoices", omit: ["public_token"] },
  { file: "invoice_lines.csv", table: "invoice_lines" },
  { file: "payments.csv", table: "payments" },
];

/** The stored documents of a full export: where each table keeps its file, and the folder it goes in. */
const DOCUMENTS: { table: string; key: string; folder: string; name: string }[] = [
  { table: "reports", key: "storage_key", folder: "reports", name: "id" },
  { table: "report_signatures", key: "storage_key", folder: "signed-reports", name: "id" },
  { table: "invoices", key: "pdf_storage_key", folder: "invoices", name: "id" },
  { table: "signed_documents", key: "pdf_storage_key", folder: "signed-documents", name: "id" },
  { table: "contract_documents", key: "storage_key", folder: "contract-documents", name: "id" },
];

export async function queueExport(db: Executor, organizationId: string, exportId: string, now: Date) {
  await enqueue(db, { kind: EXPORT_DATA, organizationId, payload: { exportId }, dedupeKey: `${EXPORT_DATA}:${exportId}`, runAt: now });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // A spreadsheet runs text starting with = + - @ as a formula; a leading quote stops it.
  // Numbers (a negative amount) are left alone.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) || safe !== text ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One table's rows for the organization as CSV, with a header row even when empty. */
async function tableCsv(db: Database, organizationId: string, table: string, omit: string[]) {
  const columns = (
    await sql<{ name: string }>`
      select column_name as name from information_schema.columns
      where table_schema = current_schema() and table_name = ${table} order by ordinal_position`.execute(db)
  ).rows
    .map((c) => c.name)
    .filter((c) => !omit.includes(c));
  const order = columns.includes("id") ? sql`order by id` : sql``;
  // Each row as JSON text, so nothing on the way (the camel-case plugin) renames its keys.
  const { rows } = await sql<{ j: string }>`
    select row_to_json(t)::text as j from (
      select ${sql.join(columns.map((c) => sql.ref(c)))} from ${sql.table(table)} where organization_id = ${organizationId} ${order}
    ) t`.execute(db);
  const lines = [columns.join(","), ...rows.map((r) => (JSON.parse(r.j) as Record<string, unknown>)).map((r) => columns.map((c) => csvCell(r[c])).join(","))];
  return { csv: `${lines.join("\r\n")}\r\n`, rows: rows.length };
}

/** Builds the zip of an organization's data and documents, stores it, and marks the export ready. */
export async function buildExport(db: Database, store: ObjectStore, organizationId: string, exportId: string, now: Date) {
  const exp = await db.selectFrom("dataExports").select("status").where("organizationId", "=", organizationId).where("id", "=", exportId).executeTakeFirst();
  if (!exp || exp.status !== "queued") return;
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  const contents: { file: string; rows: number }[] = [];
  for (const t of EXPORT_TABLES) {
    const { csv, rows } = await tableCsv(db, organizationId, t.table, t.omit ?? []);
    files[t.file] = enc.encode(csv);
    contents.push({ file: t.file, rows });
  }
  const missing: string[] = [];
  let documents = 0;
  for (const d of DOCUMENTS) {
    const { rows } = await sql<{ name: string; key: string }>`
      select ${sql.ref(d.name)}::text as name, ${sql.ref(d.key)} as key from ${sql.table(d.table)}
      where organization_id = ${organizationId} and ${sql.ref(d.key)} is not null order by 1`.execute(db);
    for (const row of rows) {
      const body = await store.get(row.key);
      const ext = /\.[a-z0-9]+$/i.exec(row.key)?.[0] ?? ".pdf";
      if (!body) missing.push(`${d.folder}/${row.name}${ext}`);
      else {
        files[`${d.folder}/${row.name}${ext}`] = new Uint8Array(body);
        documents++;
      }
    }
  }
  files["README.txt"] = enc.encode(
    [
      `Aerowise data export, made ${now.toISOString()}.`,
      "",
      "Each CSV file holds one kind of record, one row per record, with every column Aerowise keeps.",
      "Records refer to each other by id (a site's customer_id is a row in customers.csv).",
      "Dates are YYYY-MM-DD and times are UTC. Amounts ending in _cents are in cents.",
      "Documents (inspection reports, signed reports, invoices, signed agreements, uploaded contracts) are in folders named by the record's id.",
      ...(missing.length ? ["", "These documents are on record but their files could not be found:", ...missing] : []),
      "",
    ].join("\r\n"),
  );
  // Documents are already compressed; level 6 is for the CSVs.
  const zip = Buffer.from(zipSync(files, { level: 6 }));
  const key = `${organizationId}/exports/${exportId}.zip`;
  await store.put(key, zip, "application/zip");
  await db
    .updateTable("dataExports")
    .set({ status: "ready", finishedAt: now, storageKey: key, byteSize: zip.length, contents: JSON.stringify({ files: contents, documents, missing }) })
    .where("id", "=", exportId)
    .execute();
}

/** Records a failed export so the owner sees it and can ask again. */
export async function failExport(db: Database, organizationId: string, exportId: string, now: Date, error: string) {
  await db
    .updateTable("dataExports")
    .set({ status: "failed", finishedAt: now, error: error.slice(0, 1000) })
    .where("organizationId", "=", organizationId)
    .where("id", "=", exportId)
    .where("status", "=", "queued")
    .execute();
}
