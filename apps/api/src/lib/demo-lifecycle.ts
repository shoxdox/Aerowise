import type { Database } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import { eraseOrganization } from "./org-erase.ts";

/**
 * Empties one ended demo company (a visitor's, W10.2, or a prospect's, W10.6) the way a deleted
 * company is emptied, its people with them. Only a demo company with an end is touched. No
 * platform admin deleted it, so the row is not marked as a deletion; having no members left is
 * what says it was emptied. Returns whether there was anything to empty.
 */
export async function emptyEndedDemo(db: Database, store: ObjectStore, organizationId: string): Promise<boolean> {
  const emptied = await db.transaction().execute(async (trx) => {
    const org = await trx
      .selectFrom("organizations as o")
      .select("o.id")
      .where("o.id", "=", organizationId)
      .where("o.demo", "=", true)
      .where("o.demoExpiresAt", "is not", null)
      .where((eb) => eb.exists(eb.selectFrom("memberships as m").select("m.userId").whereRef("m.organizationId", "=", "o.id")))
      .forUpdate()
      .executeTakeFirst();
    if (!org) return false;
    await eraseOrganization(trx, org.id);
    await trx.updateTable("organizations").set({ subscriptionState: "read_only", subscriptionEndsOn: null }).where("id", "=", org.id).execute();
    return true;
  });
  if (emptied && store.deleteOrganization) await store.deleteOrganization(organizationId).catch(() => null);
  return emptied;
}

/** Every demo company past its end, emptied. Their sign-ins and queued work already stopped at the end. */
export async function emptyEndedDemos(db: Database, store: ObjectStore, now: Date): Promise<string[]> {
  const ended = await db
    .selectFrom("organizations as o")
    .select("o.id")
    .where("o.demo", "=", true)
    .where("o.demoExpiresAt", "<=", now)
    .where((eb) => eb.exists(eb.selectFrom("memberships as m").select("m.userId").whereRef("m.organizationId", "=", "o.id")))
    .execute();
  const emptied: string[] = [];
  for (const { id } of ended) if (await emptyEndedDemo(db, store, id)) emptied.push(id);
  return emptied;
}
