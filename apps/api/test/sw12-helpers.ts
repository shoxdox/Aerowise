import { snapshotSha256 } from "@aerowise/domain";
import { sql } from "kysely";
import { expect } from "vitest";
import { createUser, type TestContext } from "./helpers.ts";
import { completeValues, JPEG, payload, setup, uploadRequiredPhotos } from "./inspection-helpers.ts";

// Shared by the SW-12 route sweeps (plan §12 rows 17 and 18): the service-workflow routes from the
// app's own route table, and a company with one of everything those routes take an id for.

/** The service-workflow surface (plan §12 row 17), plus the older routes those slices extended. */
export const SCOPE = [
  /^\/work(\/|-orders|-types|-records|-files|$)/,
  /^\/form-templates/,
  /^\/estimates/,
  /^\/service-items/,
  /^\/plans/,
  /^\/intake-forms/,
  /^\/contracts\/:id/,
  /^\/sites\/:id\/contract-terms/,
  /^\/invoices\/:id\/(deposit|refund-job)/,
  /^\/(issues|service-requests)\/:id\/(work-order|estimate)/,
  /^\/jobs\/:id\/work-record/,
];

/** Each route Fastify knows, as [method, full path], from its printed route tree. */
export function routeTable(tree: string): [string, string][] {
  const out: [string, string][] = [];
  const stack: string[] = [];
  for (const line of tree.split("\n")) {
    const i = line.indexOf("/");
    if (i < 0) continue;
    const m = line.slice(i).match(/^(\S+)(?: \(([^)]*)\))?/)!;
    stack.length = Math.round(i / 4) - 1;
    stack.push(m[1]!);
    for (const method of m[2]?.split(", ") ?? []) if (method !== "HEAD") out.push([method, stack.join("")]);
  }
  return out;
}

/** Company B with one of everything the swept routes take an id for. */
export async function richTenant(c: TestContext) {
  const s = await setup(c, "Org B");
  // An inspection issue.
  await s.techApi.put("/inspections/sync", payload(s));
  await uploadRequiredPhotos(s, payload(s).clientId);
  const inspected = await s.techApi.put(
    "/inspections/sync",
    payload(s, { status: "completed", completedAt: "2026-03-01T15:40:00Z", values: completeValues(), issues: [{ clientId: crypto.randomUUID(), type: "pump_out", severity: "high", description: "Sludge near the top" }] }),
  );
  expect(inspected.statusCode, inspected.body).toBe(200);
  const issueId = inspected.json().issues[0].id as string;
  const request = (await s.api.post("/service-requests", { siteId: s.site.id, kind: "repair", description: "Pump hums", receivedAt: "2026-02-28T15:00:00Z" })).json();
  const workType = (await s.api.post("/work-types", { key: "jetting", name: "Line jetting", category: "maintenance" })).json();
  const item = (await s.api.post("/service-items", { name: "Riser", unitPriceCents: 1000 })).json();
  const form = await s.api.post("/form-templates/work-repair/versions", { name: "Org B private repair form", definition: (await s.api.get("/form-templates/work-repair")).json().definition });

  // An accepted estimate with a deposit, which makes a work order and a deposit invoice.
  const est = await s.api.post("/estimates", { siteId: s.site.id, lines: [{ description: "Replace aerator", quantity: 1, unitPriceCents: 60000 }], depositCents: 15000, expiresOn: "2026-03-31" });
  expect(est.statusCode, est.body).toBe(201);
  const acc = await s.api.post(`/estimates/${est.json().id}/record-acceptance`, { evidence: "Signed paper copy" });
  expect(acc.statusCode, acc.body).toBe(200);

  // A repair done on the phone (record, photos, signature), and one held after a reassignment.
  const repair = (await s.api.get("/work-types")).json().items.find((t: { key: string }) => t.key === "repair");
  const other = await createUser(c.db, s.org.id, "technician");
  const visit = async (title: string) => {
    const wo = (await s.api.post("/work-orders", { siteId: s.site.id, workTypeId: repair.id, title })).json();
    const sch = await s.api.post(`/work-orders/${wo.id}/schedule`, { technicianId: s.tech.id, scheduledDate: "2026-03-01" });
    expect(sch.statusCode, sch.body).toBe(201);
    return { wo, jobId: sch.json().visits[0].jobId as string, clientId: crypto.randomUUID() };
  };
  const tmpl = (await s.techApi.get("/form-templates/work-repair")).json();
  const summary = { workDone: "Reset alarm", parts: [], notes: "" };
  const sendAll = async (v: { jobId: string; clientId: string }) => {
    const sync = (status: string, revision: number) =>
      s.techApi.put("/work/sync", { clientId: v.clientId, jobId: v.jobId, templateId: tmpl.id, status, revision, arrivedAt: "2026-03-01T15:00:00Z", completedAt: status === "completed" ? "2026-03-01T16:00:00Z" : null, values: { problem: "Alarm", work_performed: "Reset alarm", follow_up_needed: false }, summary });
    await sync("draft", 1);
    for (const key of ["before", "after"]) await s.techApi.putImage(`/work/${v.clientId}/photos/${crypto.randomUUID()}`, JPEG, { "x-photo-key": key });
    await s.techApi.put(`/work/${v.clientId}/signatures/${crypto.randomUUID()}`, { requirementKey: "customer_signoff", signerName: "Pat", capture: { kind: "typed" }, summary, summarySha256: await snapshotSha256(summary), consentText: "I confirm this work was done.", signedAt: "2026-03-01T15:55:00Z" });
    return sync("completed", 2);
  };
  const done = await visit("Done on the phone");
  expect((await sendAll(done)).statusCode).toBe(200);
  const held = await visit("Held after reassignment");
  expect((await s.api.patch(`/jobs/${held.jobId}`, { technicianId: other.id })).statusCode).toBe(200);
  await sendAll(held);

  const one = async (q: ReturnType<typeof sql<{ id: string }>>) => (await q.execute(c.db)).rows[0]?.id;
  const org = s.org.id;
  const ids: Record<string, string | undefined> = {
    "work-orders": done.wo.id,
    "work-types": workType.id,
    "work-records": await one(sql`select id from work_records where organization_id = ${org} and job_id = ${done.jobId}`),
    "work-files": await one(sql`select id from work_attachments where organization_id = ${org} limit 1`),
    "work/conflicts": await one(sql`select id from work_sync_conflicts where organization_id = ${org} limit 1`),
    work: done.clientId,
    estimates: est.json().id,
    invoices: acc.json().deposit.invoice.id,
    issues: issueId,
    "service-requests": request.id,
    "service-items": item.id,
    plans: s.contract.planId ?? (await one(sql`select id from plans where organization_id = ${org} limit 1`)),
    contracts: s.contract.id,
    sites: s.site.id,
    jobs: done.jobId,
  };
  return { ...s, ids, formSaved: form.statusCode };
}

/** A hash of every row company B owns, table by table. */
export async function fingerprint(c: TestContext, org: string) {
  const tables = (
    await sql<{ t: string }>`select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'organization_id' and table_name not in ('sessions', 'audit_events', 'login_attempts') order by 1`.execute(c.db)
  ).rows.map((r) => r.t);
  const out: Record<string, string> = {};
  for (const t of tables) {
    out[t] = (await sql<{ h: string }>`select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as h from ${sql.table(t)} x where organization_id = ${org}`.execute(c.db)).rows[0]!.h;
  }
  return out;
}

/** The URL for a swept route: its first id is the company's record, found by the segments before
 * it; any later id (a photo or signature under it) is one nobody sent. Null: no fixture for it. */
export function urlFor(path: string, ids: Record<string, string | undefined>, target?: string): string | null {
  const segs = path.split("/");
  const first = segs.findIndex((x) => x.startsWith(":"));
  if (first < 0) return path;
  const lit = segs.slice(1, first);
  const id = target ?? ids[lit.slice(-2).join("/")] ?? ids[lit.at(-1)!];
  if (!id) return null;
  // Required query strings, filled with the company's values or a well-formed nonsense signature.
  const query = path === "/sites/:id/contract-terms" ? `?planId=${ids.plans}&startOn=2026-03-01` : path === "/work-files/:id" ? `?exp=${Date.now() + 60_000}&sig=x` : "";
  return segs.map((x, i) => (i === first ? id : x.startsWith(":") ? crypto.randomUUID() : x)).join("/") + query;
}
