import { createHash } from "node:crypto";
import { readLoads, volumeText } from "./pumping-records.ts";
import { dateInZone, formatGallons, invoiceSnapshot, WASTE_TYPE_LABELS } from "@aerowise/domain";
import { completionSummaryPdf } from "./completion-summary.ts";
import type { Database, DB } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import { DEMO_WATERMARK, renderDisposalLog, renderInvoice, watermarkPdf } from "@aerowise/reports";
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
  { file: "plans.csv", table: "plans" },
  { file: "imports.csv", table: "imports" },
  { file: "import_rows.csv", table: "import_rows" },
  { file: "import_mappings.csv", table: "import_mappings" },
  { file: "sms_messages.csv", table: "sms_messages" },
  { file: "sms_opt_outs.csv", table: "sms_opt_outs" },
  { file: "email_sends.csv", table: "email_sends", omit: ["response"] },
  { file: "email_events.csv", table: "email_events", omit: ["payload"] },
  { file: "quickbooks_links.csv", table: "quickbooks_links" },
  { file: "billing_periods.csv", table: "billing_periods", omit: ["hosted_invoice_url"] },
  { file: "billing_events.csv", table: "billing_events" },
  { file: "plan_reminders.csv", table: "plan_reminders" },
  { file: "customers.csv", table: "customers" },
  { file: "contacts.csv", table: "contacts" },
  { file: "sites.csv", table: "sites" },
  { file: "systems.csv", table: "wastewater_systems" },
  { file: "plan_versions.csv", table: "plan_versions" },
  { file: "contracts.csv", table: "contracts" },
  { file: "contract_coverage_rules.csv", table: "contract_coverage_rules" },
  { file: "contract_service_cycles.csv", table: "contract_service_cycles" },
  { file: "visits.csv", table: "service_obligations" },
  { file: "jobs.csv", table: "jobs" },
  { file: "inspections.csv", table: "inspections" },
  { file: "inspection_values.csv", table: "inspection_values" },
  { file: "inspection_photos.csv", table: "attachments" },
  { file: "inspection_held_records.csv", table: "inspection_sync_conflicts" },
  { file: "issues.csv", table: "issues" },
  { file: "reports.csv", table: "reports" },
  { file: "report_signatures.csv", table: "report_signatures", omit: ["signature_image"] },
  { file: "filings.csv", table: "filings" },
  { file: "filing_attempts.csv", table: "filing_attempts" },
  { file: "submission_packages.csv", table: "submission_packages" },
  { file: "compliance_events.csv", table: "compliance_events" },
  { file: "provider_credentials.csv", table: "provider_credentials" },
  { file: "site_authority_assignments.csv", table: "site_authority_assignments" },
  { file: "site_authority_identifiers.csv", table: "site_authority_identifiers" },
  { file: "contract_documents.csv", table: "contract_documents" },
  { file: "customer_deliveries.csv", table: "customer_deliveries" },
  { file: "renewals.csv", table: "renewals" },
  { file: "renewal_addons.csv", table: "renewal_addons" },
  { file: "signed_documents.csv", table: "signed_documents", omit: ["signature_image"] },
  { file: "service_requests.csv", table: "service_requests" },
  { file: "lab_tests.csv", table: "lab_tests" },
  { file: "system_monitoring.csv", table: "system_monitoring" },
  { file: "invoice_events.csv", table: "invoice_events" },
  { file: "refunds.csv", table: "refunds" },
  { file: "deposit_requests.csv", table: "deposit_requests" },
  { file: "audit_events.csv", table: "audit_events" },
  { file: "legal_acceptances.csv", table: "legal_acceptances" },
  { file: "invoices.csv", table: "invoices" },
  { file: "invoice_lines.csv", table: "invoice_lines" },
  { file: "payments.csv", table: "payments", omit: ["bank_verification_url"] },
  { file: "work_types.csv", table: "work_types" },
  { file: "service_items.csv", table: "service_items" },
  { file: "work_orders.csv", table: "work_orders" },
  { file: "work_order_lines.csv", table: "work_order_lines" },
  { file: "work_order_events.csv", table: "work_order_events" },
  { file: "work_order_notes.csv", table: "work_order_notes" },
  { file: "work_records.csv", table: "work_records" },
  { file: "work_photos.csv", table: "work_attachments" },
  { file: "work_held_records.csv", table: "work_sync_conflicts" },
  { file: "work_assignments.csv", table: "job_assignments" },
  { file: "estimates.csv", table: "estimates" },
  { file: "estimate_lines.csv", table: "estimate_lines" },
  { file: "estimate_versions.csv", table: "estimate_versions" },
  { file: "estimate_events.csv", table: "estimate_events" },
  { file: "coverage_uses.csv", table: "coverage_uses" },
  { file: "estimate_invoices.csv", table: "estimate_invoices" },
  { file: "deposit_ledger.csv", table: "deposit_ledger" },
  { file: "deposit_shortfall_resolutions.csv", table: "deposit_shortfall_resolutions" },
  { file: "vehicles.csv", table: "vehicles" },
  { file: "disposal_facilities.csv", table: "disposal_facilities" },
  { file: "pumping_records.csv", table: "pumping_records" },
  { file: "disposal_loads.csv", table: "disposal_loads" },
  { file: "disposal_load_items.csv", table: "disposal_load_items" },
];

/** Every omitted tenant table has an explicit portability/security disposition. */
export const EXPORT_EXCLUSIONS: Record<string, string> = {
  inspection_templates: "Owned and referenced shared versioned definitions are included in template-versions.json, rather than an incomplete tenant-only CSV.",
  organizations: "Public company profile and operational settings are in company.json; provider accounts, internal subscription and deletion metadata are omitted.",
  memberships: "Staff identity, role, membership state and technician license are in staff.json; authentication credentials are excluded.",
  sessions: "Authentication session credentials are excluded.",
  background_tasks: "Internal queue/transport payloads may contain active access links and are not portable business records.",
  checkout_sessions: "Active payment checkout URLs and provider session capabilities are excluded; invoices and payment records are included.",
  stripe_events: "Raw signed provider webhook payloads are excluded; applied payment/invoice/refund records are included.",
  quickbooks_connections: "Encrypted provider access/refresh credentials and connection secrets are excluded; mapping/status metadata is in quickbooks_links.csv.",
  data_exports: "Export job history and references to previous archives are internal operations; this archive identifies its own creation.",
  portal_links: "Active customer portal tokens/hashes are excluded.",
  estimate_links: "Active estimate tokens/hashes are excluded.",
  invitations: "Account invitation tokens/hashes and acceptance capabilities are excluded.",
  password_reset_tokens: "Authentication recovery tokens/hashes are excluded.",
  demo_visits: "Visitor access/abuse-control hashes and expiry credentials are excluded; demo stage is recorded in the manifest.",
  demo_access_links: "Prospect-demo credentials/tokens are excluded.",
  support_sessions: "Platform support access credentials and internal session metadata are excluded.",
  platform_audit_events: "Platform administration/audit records are retained separately from customer-owned operational audit_events.csv.",
};

/** Remove application bearer links from free text/JSON while retaining business content. */
function withoutBearerLinks(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(\/(?:pay|renew|portal|estimate|invite|reset-password)\/)[A-Za-z0-9_.-]+/g, "$1[redacted-link-token]");
  if (Array.isArray(value)) return value.map(withoutBearerLinks);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, withoutBearerLinks(v)]));
  return value;
}

/** The stored documents of a full export: where each table keeps its file, and the folder it goes in. */
const DOCUMENTS: { table: string; key: string; folder: string; name: string; organizationKey?: string }[] = [
  { table: "attachments", key: "storage_key", folder: "inspection-photos", name: "id" },
  { table: "work_attachments", key: "storage_key", folder: "work-and-disposal-photos", name: "id" },
  { table: "organizations", key: "logo_storage_key", folder: "company-assets", name: "id", organizationKey: "id" },
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

/**
 * A demo company's CSVs start with this column, on the header and on every row, so a file
 * (or a few rows) copied out of the zip still says it is fictional. It is an extra column
 * in front, named so it cannot be mistaken for a database column; every real column keeps
 * its name and order after it (STG-07).
 */
export const DEMO_CSV_COLUMN = "aerowise_demo_notice";

/** One table's rows for the organization as CSV, with a header row even when empty. */
async function tableCsv(db: Database, organizationId: string, table: string, omit: string[], demo: boolean) {
  const columns = (
    await sql<{ name: string }>`
      select column_name as name from information_schema.columns
      where table_schema = current_schema() and table_name = ${table} order by ordinal_position`.execute(db)
  ).rows
    .map((c) => c.name)
    .filter((c) => !omit.includes(c));
  const selected = columns.map((c) => sql.ref(c));
  if (table === "payments") {
    selected.push(sql`(status = 'pending' and bank_verification_url is not null) as bank_verification_required`);
    columns.push("bank_verification_required");
  }
  const order = columns.includes("id") ? sql`order by id` : sql``;
  // Each row as JSON text, so nothing on the way (the camel-case plugin) renames its keys.
  const { rows } = await sql<{ j: string }>`
    select row_to_json(t)::text as j from (
      select ${sql.join(selected)} from ${sql.table(table)} where organization_id = ${organizationId} ${order}
    ) t`.execute(db);
  const lead = demo ? [DEMO_CSV_COLUMN] : [];
  const notice = demo ? [csvCell(DEMO_WATERMARK)] : [];
  const lines = [[...lead, ...columns].join(","), ...rows.map((r) => (JSON.parse(r.j) as Record<string, unknown>)).map((r) => [...notice, ...columns.map((c) => csvCell(withoutBearerLinks(r[c])))].join(","))];
  return { csv: `${lines.join("\r\n")}\r\n`, rows: rows.length };
}

export const DEMO_EXPORT_NOTICE = "DEMO: everything in this export is fictional, from an Aerowise demo company. Nothing in it was emailed, texted, filed or charged.";

/** Builds the zip of an organization's data and documents, stores it, and marks the export ready. */
export async function buildExport(db: Database, store: ObjectStore, organizationId: string, exportId: string, now: Date) {
  const exp = await db.selectFrom("dataExports").select("status").where("organizationId", "=", organizationId).where("id", "=", exportId).executeTakeFirst();
  if (!exp || exp.status !== "queued") return;
  // A demo company's export says throughout that it is fictional.
  const { demo } = await db.selectFrom("organizations").select("demo").where("id", "=", organizationId).executeTakeFirstOrThrow();
  const inventory = (await sql<{ name: string }>`select distinct c.table_name as name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema = current_schema() and c.column_name = 'organization_id' order by 1`.execute(db)).rows.map((r) => r.name);
  const known = new Set([...EXPORT_TABLES.map((t) => t.table), ...Object.keys(EXPORT_EXCLUSIONS)]);
  const unclassified = inventory.filter((table) => !known.has(table));
  if (unclassified.length) throw new Error(`Export inventory needs a disposition for: ${unclassified.join(", ")}`);
  const enc = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  const contents: { file: string; rows: number }[] = [];
  for (const t of EXPORT_TABLES) {
    const { csv, rows } = await tableCsv(db, organizationId, t.table, t.omit ?? [], demo);
    files[t.file] = enc.encode(csv);
    contents.push({ file: t.file, rows });
  }
  // Referenced shared template versions belong in the archive too, so readings remain interpretable.
  const templates = await db.selectFrom("inspectionTemplates as t").selectAll("t")
    .where((eb) => eb.or([
      eb("t.organizationId", "=", organizationId),
      eb.exists(eb.selectFrom("inspections as i").select("i.id").where("i.organizationId", "=", organizationId).whereRef("i.templateId", "=", "t.id")),
      eb.exists(eb.selectFrom("workRecords as w").select("w.id").where("w.organizationId", "=", organizationId).whereRef("w.templateId", "=", "t.id")),
    ])).orderBy("t.id").execute();
  files["template-versions.json"] = enc.encode(JSON.stringify({ ...(demo ? { notice: DEMO_EXPORT_NOTICE } : {}), templates: withoutBearerLinks(templates) }, null, 2));
  const company = await db.selectFrom("organizations").select(["id", "name", "demo", "phone", "emergencyPhone", "email", "addressLine1", "addressLine2", "city", "state", "postalCode", "timezone", "serviceCounties", "responsibleCredentialId", "invoiceTermsDays", "defaultTaxRateBps", "renewalWindowDays", "renewalAutoSend", "renewalPayment", "renewalTerms", "routeStartAddress", "routeStartLat", "routeStartLng", "routeReturnToStart", "routeStopMinutes", "routeDayMinutes", "routeSpeedMph", "disposalOverdueDays", "billFilingFees"])
    .where("id", "=", organizationId).executeTakeFirstOrThrow();
  files["company.json"] = enc.encode(JSON.stringify({ ...(demo ? { notice: DEMO_EXPORT_NOTICE } : {}), company: withoutBearerLinks(company) }, null, 2));
  const staff = await db.selectFrom("memberships as m").innerJoin("users as u", "u.id", "m.userId")
    .select(["u.id", "u.name", "u.email", "u.phone", "m.role", "m.active", "m.technicianLicense"])
    .where("m.organizationId", "=", organizationId).orderBy("u.id").execute();
  files["staff.json"] = enc.encode(JSON.stringify({ ...(demo ? { notice: DEMO_EXPORT_NOTICE } : {}), staff: withoutBearerLinks(staff) }, null, 2));
  const missing: string[] = [];
  const assets: { file: string; table: string; recordId: string; state: "included" | "missing"; rendition?: "portable-invoice-without-payment-link"; sourceSha256?: string; bytes?: number; sha256?: string }[] = [];
  let documents = 0;
  for (const d of DOCUMENTS) {
    const { rows } = await sql<{ name: string; key: string }>`
      select ${sql.ref(d.name)}::text as name, ${sql.ref(d.key)} as key from ${sql.table(d.table)}
      where ${sql.ref(d.organizationKey ?? "organization_id")} = ${organizationId} and ${sql.ref(d.key)} is not null order by 1`.execute(db);
    for (const row of rows) {
      if (!row.key.startsWith(`${organizationId}/`)) throw new Error(`Refusing an out-of-organization file reference in ${d.table}`);
      const body = await store.get(row.key);
      const ext = /\.[a-z0-9]+$/i.exec(row.key)?.[0] ?? ".pdf";
      const file = `${d.folder}/${row.name}${ext}`;
      if (!body) {
        missing.push(file);
        assets.push({ file, table: d.table, recordId: row.name, state: "missing" });
      }
      else {
        const isPdf = body.subarray(0, 5).toString("latin1") === "%PDF-";
        let portable = body;
        if (d.table === "invoices") {
          const invoice = await db.selectFrom("invoices").select("snapshot").where("organizationId", "=", organizationId).where("id", "=", row.name).executeTakeFirstOrThrow();
          portable = await renderInvoice(invoiceSnapshot.parse(invoice.snapshot), { payUrl: null });
        }
        files[file] = new Uint8Array(demo && isPdf ? await watermarkPdf(portable) : portable);
        assets.push({ file, table: d.table, recordId: row.name, state: "included", ...(d.table === "invoices" ? { rendition: "portable-invoice-without-payment-link" as const, sourceSha256: createHash("sha256").update(body).digest("hex") } : {}), bytes: files[file]!.length, sha256: createHash("sha256").update(files[file]!).digest("hex") });
        documents++;
      }
    }
  }
  const completed = await db.selectFrom("workOrders").select("id").where("organizationId", "=", organizationId).where("status", "=", "completed")
    .where((eb) => eb.exists(eb.selectFrom("workRecords as r").select("r.id").whereRef("r.workOrderId", "=", "workOrders.id").where("r.organizationId", "=", organizationId).where("r.status", "=", "completed"))).orderBy("id").execute();
  for (const row of completed) {
    const file = `work-summaries/${row.id}.pdf`;
    files[file] = new Uint8Array(await completionSummaryPdf(db, organizationId, row.id, now));
    documents++;
    assets.push({ file, table: "work_orders", recordId: row.id, state: "included", bytes: files[file]!.length, sha256: createHash("sha256").update(files[file]!).digest("hex") });
  }
  const loads = await readLoads(db, organizationId, {}, (photoId) => `work-and-disposal-photos/${photoId}`);
  if (loads.length) {
    const org = await db.selectFrom("organizations").select(["name", "timezone"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
    const dates = loads.map((l) => l.deliveredOn).sort();
    const log = await renderDisposalLog({ companyName: org.name, from: dates[0]!, to: dates[dates.length - 1]!, generatedOn: dateInZone(now, org.timezone), generatedAt: now.toISOString(),
      loads: loads.map((l) => ({ deliveredOn: l.deliveredOn, facilityName: l.facilityName, vehicleName: l.vehicleName, manifestReference: l.manifestReference, total: volumeText(l.enteredTotal, l.enteredUnit, l.totalMilligallons), itemsTotal: formatGallons(l.itemsMilligallons), volumesDiffer: l.volumesDiffer, photos: l.photos.length, revision: l.revision,
        items: l.items.map((p) => ({ serviceDate: p.serviceDate, workOrderLabel: p.workOrderLabel, customerName: p.customerName, siteAddress: p.siteAddress, wasteType: WASTE_TYPE_LABELS[p.wasteType], volume: volumeText(p.enteredVolume, p.enteredUnit, p.volumeMilligallons) })),
      })),
    });
    files["disposal-log.pdf"] = new Uint8Array(demo ? await watermarkPdf(log) : log);
    documents++;
  }
  files["README.txt"] = enc.encode(
    [
      ...(demo ? [DEMO_EXPORT_NOTICE, `Every CSV file starts with an ${DEMO_CSV_COLUMN} column reading "${DEMO_WATERMARK}" on every row; the columns after it are the same as in a real export.`, ""] : []),
      `Aerowise data export, made ${now.toISOString()}.`,
      "",
      "Each CSV file holds one kind of business record, one row per record. The manifest inventories included, derived and deliberately excluded tenant tables and omitted sensitive columns; application bearer links in record text/JSON are redacted.",
      "Records refer to each other by id (a site's customer_id is a row in customers.csv).",
      "Dates are YYYY-MM-DD and times are UTC. Amounts ending in _cents are in cents; quantities ending in _milli are in thousandths (1500 is 1.5).",
      "Documents, raw inspection/work/disposal photos, company logo and generated work summaries are in folders named by record id. Raw photos are original bytes; demo PDFs are watermarked.",
      "Invoice PDFs are portable copies rendered from the frozen invoice snapshot without the bearer payment link. Their source SHA-256 and rendition are identified in manifest.json; stored issued originals are unchanged. Signed reports, agreements and filing artifacts are retained unchanged except demo watermarking.",
      "manifest.json lists row counts, every included file with SHA-256 and size, and missing referenced assets. It excludes its own checksum. Referenced shared form versions and staff contact/role data are included as JSON.",
      "Excluded: authentication sessions, active public-link tokens/hashes, integration credentials, payment-provider secrets, background delivery payloads, platform administration records and standalone signature images. Signed artifacts and signature consent/binding metadata remain included.",
      "This is a sequential export while the company may still be changing; it is not a transactionally frozen database backup. For reconciliation, pause writes and export again.",
      ...(missing.length ? ["", "These documents are on record but their files could not be found:", ...missing] : []),
      "",
    ].join("\r\n"),
  );
  if (demo) files["DEMO-FICTIONAL-DATA.txt"] = enc.encode(`${DEMO_EXPORT_NOTICE}\r\n`);
  files["manifest.json"] = enc.encode(JSON.stringify({
    version: 1, generatedAt: now.toISOString(), organizationId, demo,
    ...(demo ? { notice: DEMO_EXPORT_NOTICE } : {}),
    tables: contents, assets, missing,
    inventory: inventory.map((table) => ({ table, ...(EXPORT_TABLES.find((t) => t.table === table) ? { state: "included", file: EXPORT_TABLES.find((t) => t.table === table)!.file, omittedColumns: EXPORT_TABLES.find((t) => t.table === table)!.omit ?? [] } : { state: ["organizations", "memberships", "inspection_templates"].includes(table) ? "derived" : "excluded", reason: EXPORT_EXCLUSIONS[table] }) })),
    exclusions: EXPORT_EXCLUSIONS, redactions: "Application bearer link tokens in record text/JSON are replaced; bank verification and hosted billing URLs are excluded. Invoice PDFs are portable renditions without payment links.",
    files: Object.entries(files).map(([file, body]) => ({ file, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") })),
  }, null, 2));
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
