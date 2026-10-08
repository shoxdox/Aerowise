import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { setupTestApp } from "./helpers.ts";
import { payload, setup, type Setup } from "./inspection-helpers.ts";

// The database keeps work and compliance apart on its own, whatever the application code
// does (service workflows plan §1.2). These run straight SQL, as an older binary or a bug
// would, and every case is refused or derived without relying on a nullable discriminator.

const ctx = setupTestApp({ features: ["work_orders"] });

const run = (q: ReturnType<typeof sql>) => q.execute(ctx.db);
/** The Postgres error code a statement fails with, or null when it succeeds. */
async function failsWith(q: ReturnType<typeof sql>) {
  try {
    await run(q);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

async function workOrder(s: Setup) {
  const type = ((await s.api.get("/work-types")).json().items as { id: string; key: string }[]).find((t) => t.key === "repair")!;
  return (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: type.id })).json() as { id: string };
}

const jobCols = () => sql`organization_id, site_id, scheduled_date, technician_user_id`;
const jobVals = (s: Setup) => sql`${s.org.id}, ${s.site.id}, '2026-03-05', ${s.tech.id}`;

describe("job and inspection kinds in the database", () => {
  it("derives a job's visit kind from its obligation, overwriting a NULL or forged value, as an old writer would insert it", async () => {
    const s = await setup(ctx);
    // Cancel setup's job so the obligation can take another live job.
    await s.api.post(`/jobs/${s.job.jobId}/cancel`, { reason: "test" });

    // An old writer: no discriminator column at all.
    const old = await sql<{ t: string }>`insert into jobs (${jobCols()}, obligation_id) values (${jobVals(s)}, ${s.visit.id}) returning obligation_service_type as t`.execute(ctx.db);
    expect(old.rows[0]!.t).toBe("aerobic_inspection");
    await run(sql`update jobs set status = 'cancelled', cancelled_at = now() where obligation_id = ${s.visit.id}`);

    const nulled = await sql<{ t: string }>`insert into jobs (${jobCols()}, obligation_id, obligation_service_type) values (${jobVals(s)}, ${s.visit.id}, null) returning obligation_service_type as t`.execute(ctx.db);
    expect(nulled.rows[0]!.t).toBe("aerobic_inspection");
    await run(sql`update jobs set status = 'cancelled', cancelled_at = now() where obligation_id = ${s.visit.id}`);

    const forged = await sql<{ id: string; t: string }>`insert into jobs (${jobCols()}, obligation_id, obligation_service_type) values (${jobVals(s)}, ${s.visit.id}, 'pumping') returning id, obligation_service_type as t`.execute(ctx.db);
    expect(forged.rows[0]!.t).toBe("aerobic_inspection");

    // Forging it afterwards is overwritten again; it can never disagree with the obligation.
    await run(sql`update jobs set obligation_service_type = 'pumping' where id = ${forged.rows[0]!.id}`);
    expect((await sql<{ t: string }>`select obligation_service_type as t from jobs where id = ${forged.rows[0]!.id}`.execute(ctx.db)).rows[0]!.t).toBe("aerobic_inspection");
    // And an obligation that does not exist (or is another company's) fails as a foreign key.
    expect(await failsWith(sql`insert into jobs (${jobCols()}, obligation_id) values (${jobVals(s)}, gen_random_uuid())`)).toBe("23503");
  });

  it("refuses a work job that references an obligation, and work-shaped inspection jobs", async () => {
    const s = await setup(ctx);
    const wo = await workOrder(s);
    await s.api.post(`/jobs/${s.job.jobId}/cancel`, { reason: "test" });
    // A work job pointing at the aerobic visit (derived kind is aerobic, so the job kind check fails).
    expect(await failsWith(sql`insert into jobs (${jobCols()}, type, work_order_id, visit_number, obligation_id) values (${jobVals(s)}, 'work', ${wo.id}, 1, ${s.visit.id})`)).toBe("23514");
    // An inspection job carrying a work order, a work job without one, and an unknown type.
    expect(await failsWith(sql`insert into jobs (${jobCols()}, type, work_order_id) values (${jobVals(s)}, 'inspection', ${wo.id})`)).toBe("23514");
    expect(await failsWith(sql`insert into jobs (${jobCols()}, type, visit_number) values (${jobVals(s)}, 'work', 1)`)).toBe("23514");
    expect(await failsWith(sql`insert into jobs (${jobCols()}, type) values (${jobVals(s)}, 'pumping')`)).toBe("23514");
    // A work job with the pairing broken by hand: obligation kind without an obligation.
    expect(await failsWith(sql`update jobs set obligation_service_type = 'aerobic_inspection', obligation_id = null where id = ${s.job.jobId}`)).toBe(null);
    expect((await sql<{ t: string | null }>`select obligation_service_type as t from jobs where id = ${s.job.jobId}`.execute(ctx.db)).rows[0]!.t).toBe(null);
    // A proper work job is accepted, and a second open one on the same order is not.
    expect(await failsWith(sql`insert into jobs (${jobCols()}, type, work_order_id, visit_number) values (${jobVals(s)}, 'work', ${wo.id}, 1)`)).toBe(null);
    expect(await failsWith(sql`insert into jobs (${jobCols()}, type, work_order_id, visit_number) values (${jobVals(s)}, 'work', ${wo.id}, 2)`)).toBe("23505");
  });

  it("keeps every inspection on an inspection job: NULL kind refused, a work job refused", async () => {
    const s = await setup(ctx);
    const wo = await workOrder(s);
    const job = await sql<{ id: string }>`insert into jobs (${jobCols()}, type, work_order_id, visit_number) values (${jobVals(s)}, 'work', ${wo.id}, 1) returning id`.execute(ctx.db);
    const workJob = job.rows[0]!.id;
    const template = s.template.id;
    const insert = (jobId: string, jobType: ReturnType<typeof sql> | null) =>
      sql`insert into inspections (organization_id, offline_client_id, job_id, site_id, template_id, technician_user_id, arrived_at${jobType ? sql`, job_type` : sql``})
          values (${s.org.id}, gen_random_uuid(), ${jobId}, ${s.site.id}, ${template}, ${s.tech.id}, now()${jobType ? sql`, ${jobType}` : sql``})`;
    expect(await failsWith(insert(s.job.jobId, sql`null`))).toBe("23502");
    expect(await failsWith(insert(s.job.jobId, sql`'work'`))).toBe("23514");
    // Old writer, no column: defaults to inspection and points at an inspection job.
    expect(await failsWith(insert(workJob, null))).toBe("23503");
    expect(await failsWith(insert(s.job.jobId, null))).toBe(null);
    // A job with an inspection cannot be turned into a work job.
    const other = await workOrder(s);
    expect(await failsWith(sql`update jobs set type = 'work', work_order_id = ${other.id}, visit_number = 1, obligation_id = null where id = ${s.job.jobId}`)).toBe("23503");
  });

  it("keeps a contract's cancellation to its own inspection visits", async () => {
    const s = await setup(ctx);
    const wo = await workOrder(s);
    await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-05" });
    const cancelled = await s.api.post(`/contracts/${s.contract.id}/cancel`, { reason: "Sold the house" });
    expect(cancelled.statusCode, cancelled.body).toBeLessThan(300);
    const jobs = await ctx.db.selectFrom("jobs").select(["type", "status"]).where("organizationId", "=", s.org.id).orderBy("type").execute();
    expect(jobs).toEqual([
      { type: "inspection", status: "cancelled" },
      { type: "work", status: "scheduled" },
    ]);
  });

  it("does not let the phone's inspection sync touch a work job", async () => {
    const s = await setup(ctx);
    const wo = await workOrder(s);
    const visit = (await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-01" })).json().visits[0];
    const res = await s.techApi.put("/inspections/sync", payload(s, { jobId: visit.jobId }));
    expect(res.statusCode).toBe(404);
    expect(await ctx.db.selectFrom("inspections").select("id").where("organizationId", "=", s.org.id).execute()).toEqual([]);
  });
});
