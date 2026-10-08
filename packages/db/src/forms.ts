import { BUILT_IN_FORMS } from "@aerowise/domain";
import type { Kysely } from "kysely";
import type { DB } from "./schema.ts";

/**
 * Adds any built-in form version that is not in the database yet (the aerobic inspection form
 * and the starter work forms). Versions are immutable, so an existing row is left as it is.
 * Safe to run any number of times, concurrently too.
 */
export async function ensureBuiltInForms(db: Kysely<DB>): Promise<number> {
  const present = await db
    .selectFrom("inspectionTemplates")
    .select(["key", "version"])
    .where("organizationId", "is", null)
    .where("key", "in", BUILT_IN_FORMS.map((f) => f.key))
    .execute();
  const have = new Set(present.map((r) => `${r.key}@${r.version}`));
  const missing = BUILT_IN_FORMS.filter((f) => !have.has(`${f.key}@${f.version}`));
  if (missing.length === 0) return 0;
  const added = await db
    .insertInto("inspectionTemplates")
    .values(
      missing.map((f) => ({
        organizationId: null,
        key: f.key,
        version: f.version,
        name: f.name,
        purpose: f.purpose,
        definition: JSON.stringify(f.definition),
        createdBy: null,
      })),
    )
    .onConflict((oc) => oc.columns(["key", "version"]).where("organizationId", "is", null).doNothing())
    .returning("id")
    .execute();
  return added.length;
}
