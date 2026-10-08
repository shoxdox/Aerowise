import type { Database, DB } from "@aerowise/db";
import { sql, type Transaction } from "kysely";

type Executor = Database | Transaction<DB>;

/** The tables an import writes, and so the only ones undo deletes from. */
const IMPORTED = ["customers", "contacts", "sites", "wastewater_systems", "contracts", "service_obligations"] as const;
type Imported = (typeof IMPORTED)[number];

/** Rows an import may delete along with what it created, whoever added them: they are details of the record, not work done. */
const DETAILS = new Set<string>(["contacts", "wastewater_systems", "contract_service_cycles"]);

/** How a blocker is named to the person, by table. Tables added later fall back to their own name. */
const LABELS: Record<string, [string, string]> = {
  jobs: ["scheduled visit", "scheduled visits"],
  inspections: ["inspection", "inspections"],
  issues: ["issue", "issues"],
  reports: ["report", "reports"],
  compliance_events: ["compliance record", "compliance records"],
  filings: ["filing", "filings"],
  invoices: ["invoice", "invoices"],
  invoice_lines: ["invoice line", "invoice lines"],
  renewals: ["renewal", "renewals"],
  signed_documents: ["signed document", "signed documents"],
  portal_links: ["portal link", "portal links"],
  service_requests: ["service request", "service requests"],
  sms_messages: ["text message", "text messages"],
  site_authority_assignments: ["authority assignment", "authority assignments"],
  site_authority_identifiers: ["authority identifier", "authority identifiers"],
  contract_documents: ["contract document", "contract documents"],
  customer_deliveries: ["report sent to a customer", "reports sent to customers"],
  lab_tests: ["lab test", "lab tests"],
  system_monitoring: ["monitoring record", "monitoring records"],
  sites: ["site added to an imported customer", "sites added to imported customers"],
  contracts: ["contract added to an imported site", "contracts added to imported sites"],
  service_obligations: ["visit of a contract added later", "visits of contracts added later"],
};

interface Reference {
  table: string;
  column: string;
  target: Imported;
}

let references: Promise<Reference[]> | undefined;

/**
 * Every foreign key that points at a table an import writes, read from the database
 * itself so a table added later is checked without anyone remembering to list it.
 * Composite keys are reduced to the column that holds the referenced row's id.
 */
function referencesTo(db: Executor): Promise<Reference[]> {
  references ??= sql<Reference>`
    select c.conrelid::regclass::text as "table", a.attname as "column", c.confrelid::regclass::text as target
    from pg_constraint c
    cross join lateral unnest(c.conkey, c.confkey) as k(attnum, fattnum)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = k.fattnum
    where c.contype = 'f'
      and fa.attname = 'id'
      and c.confrelid::regclass::text = any(${[...IMPORTED]}::text[])
    order by 1, 2`
    .execute(db)
    .then((r) => r.rows)
    .catch((err) => {
      references = undefined;
      throw err;
    });
  return references;
}

export type ImportRecords = Record<Imported, string[]>;

/** What an import created and still exists. */
export async function importRecords(db: Executor, organizationId: string, importId: string): Promise<ImportRecords> {
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const [customers, sites, contracts] = await Promise.all([
    db.selectFrom("customers").select("id").where("organizationId", "=", organizationId).where("importId", "=", importId).execute().then(ids),
    db.selectFrom("sites").select("id").where("organizationId", "=", organizationId).where("importId", "=", importId).execute().then(ids),
    db
      .selectFrom("contracts")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("id", "in", (eb) => eb.selectFrom("importRows").select("contractId").where("importId", "=", importId).where("contractId", "is not", null).$narrowType<{ contractId: string }>())
      .execute()
      .then(ids),
  ]);
  const none = sql<boolean>`false`;
  const [contacts, systems, visits] = await Promise.all([
    db
      .selectFrom("contacts")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where((eb) => eb.or([customers.length ? eb("customerId", "in", customers) : none, sites.length ? eb("siteId", "in", sites) : none]))
      .execute()
      .then(ids),
    sites.length ? db.selectFrom("wastewaterSystems").select("id").where("organizationId", "=", organizationId).where("siteId", "in", sites).execute().then(ids) : [],
    contracts.length ? db.selectFrom("serviceObligations").select("id").where("organizationId", "=", organizationId).where("contractId", "in", contracts).execute().then(ids) : [],
  ]);
  return { customers, contacts, sites, wastewater_systems: systems, contracts, service_obligations: visits };
}

export interface Blocker {
  table: string;
  label: string;
  count: number;
}

/**
 * The work done on what an import created: any row anywhere that points at one of its
 * records, other than its own records and their contacts and unit details.
 */
export async function undoBlockers(db: Executor, organizationId: string, records: ImportRecords): Promise<Blocker[]> {
  // One query per table, so a row pointing at a site and its contract counts once.
  const byTable = new Map<string, Reference[]>();
  for (const ref of await referencesTo(db)) {
    if (records[ref.target].length === 0 || DETAILS.has(ref.table)) continue;
    byTable.set(ref.table, [...(byTable.get(ref.table) ?? []), ref]);
  }
  const counts = new Map<string, number>();
  for (const [table, refs] of byTable) {
    const pointsAt = sql.join(
      refs.map((ref) => sql`${sql.ref(ref.column)} = any(${records[ref.target]}::uuid[])`),
      sql` or `,
    );
    // A record of the import pointing at another (a site at its customer) is not work.
    const own = (IMPORTED as readonly string[]).includes(table) ? sql`and not (id = any(${records[table as Imported]}::uuid[]))` : sql``;
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from ${sql.table(table)}
      where organization_id = ${organizationId} and (${pointsAt}) ${own}`.execute(db);
    if (rows[0]!.n > 0) counts.set(table, rows[0]!.n);
  }
  return [...counts].map(([table, count]) => {
    const [one, many] = LABELS[table] ?? [table.replace(/_/g, " "), table.replace(/_/g, " ")];
    return { table, count, label: `${count} ${count === 1 ? one : many}` };
  });
}

/** Deletes what an import created, children first, in the caller's transaction. */
export async function deleteImportRecords(trx: Transaction<DB>, organizationId: string, records: ImportRecords) {
  const del = async (table: "serviceObligations" | "contracts" | "wastewaterSystems" | "contacts" | "sites" | "customers", ids: string[]) => {
    if (ids.length) await trx.deleteFrom(table).where("organizationId", "=", organizationId).where("id", "in", ids).execute();
  };
  await del("serviceObligations", records.service_obligations);
  // A contract's frozen cycles (SW-9) go with it; a cycle a later visit still uses blocks the delete.
  if (records.contracts.length) await trx.deleteFrom("contractServiceCycles").where("organizationId", "=", organizationId).where("contractId", "in", records.contracts).execute();
  await del("contracts", records.contracts);
  await del("wastewaterSystems", records.wastewater_systems);
  await del("contacts", records.contacts);
  await del("sites", records.sites);
  await del("customers", records.customers);
}
