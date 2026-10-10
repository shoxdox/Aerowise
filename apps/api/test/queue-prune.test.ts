import { enqueue, pruneTasks } from "@aerowise/tasks";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createOrg, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

describe("pruning finished tasks", () => {
  it("removes tasks done a month ago and failed three months ago, and nothing waiting or recent", async () => {
    const org = await createOrg(ctx.db, "Org A");
    const at = new Date("2026-03-01T18:00:00Z");
    const day = 86_400_000;
    const make = async (key: string, done: Date | null, failed: Date | null) => {
      await enqueue(ctx.db, { kind: "test.kind", organizationId: org.id, payload: {}, dedupeKey: key, runAt: at });
      await sql`update background_tasks set completed_at = ${done}, failed_at = ${failed} where dedupe_key = ${key}`.execute(ctx.db);
    };
    await make("waiting", null, null);
    await make("done-recent", new Date(at.getTime() - 29 * day), null);
    await make("done-old", new Date(at.getTime() - 31 * day), null);
    await make("failed-recent", null, new Date(at.getTime() - 89 * day));
    await make("failed-old", null, new Date(at.getTime() - 91 * day));
    expect(await pruneTasks(ctx.db, at)).toBe(2);
    const left = await ctx.db.selectFrom("backgroundTasks").select("dedupeKey").orderBy("dedupeKey").execute();
    expect(left.map((t) => t.dedupeKey)).toEqual(["done-recent", "failed-recent", "waiting"]);
    // Freed keys can be queued again: every task is safe to run twice.
    await enqueue(ctx.db, { kind: "test.kind", organizationId: org.id, payload: {}, dedupeKey: "done-old", runAt: at });
    expect(await ctx.db.selectFrom("backgroundTasks").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow()).toEqual({ n: 4 });
  });
});
