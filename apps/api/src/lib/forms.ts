import { ensureBuiltInForms, type DB } from "@aerowise/db";
import type { FormTemplate, TemplateDefinition, TemplatePurpose } from "@aerowise/domain";
import type { Kysely } from "kysely";

// Forms of every purpose share inspection_templates (SW-F). A company's own newest version of a
// key wins over the built-in one; versions never change once saved.

export const FORM_COLUMNS = ["id", "key", "version", "name", "purpose", "organizationId", "definition"] as const;

type FormRow = { id: string; key: string; version: number; name: string; purpose: TemplatePurpose; organizationId: string | null; definition: unknown };

export const toForm = (row: FormRow): FormTemplate => ({
  id: row.id,
  key: row.key,
  version: row.version,
  name: row.name,
  purpose: row.purpose,
  builtIn: row.organizationId === null,
  definition: row.definition as TemplateDefinition,
});

/**
 * The form each key resolves to for this company: its own newest version, else the newest
 * built-in one. Optionally only one purpose, or one key.
 */
export async function currentForms(db: Kysely<DB>, organizationId: string, filter: { purpose?: TemplatePurpose; key?: string } = {}): Promise<FormTemplate[]> {
  // Tests empty the table between cases; elsewhere the API added these when it started.
  await ensureBuiltInForms(db);
  let q = db
    .selectFrom("inspectionTemplates")
    .select(FORM_COLUMNS)
    .where((eb) => eb.or([eb("organizationId", "is", null), eb("organizationId", "=", organizationId)]));
  if (filter.purpose) q = q.where("purpose", "=", filter.purpose);
  if (filter.key) q = q.where("key", "=", filter.key);
  const rows = await q.execute();
  const best = new Map<string, FormRow>();
  for (const r of rows) {
    const cur = best.get(r.key);
    // Own beats built-in; within the same owner, the newest version.
    const rank = (x: FormRow) => [x.organizationId === null ? 0 : 1, x.version] as const;
    if (!cur) best.set(r.key, r);
    else {
      const [a, b] = [rank(r), rank(cur)];
      if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) best.set(r.key, r);
    }
  }
  return [...best.values()].map(toForm).sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/** Whether the key names a work form this company can use (built-in or its own). */
export async function isWorkForm(db: Kysely<DB>, organizationId: string, key: string): Promise<boolean> {
  return (await currentForms(db, organizationId, { key, purpose: "work" })).length > 0;
}
