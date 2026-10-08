import { FEATURES } from "@aerowise/domain";
import { TestPaymentProvider } from "@aerowise/payments";
import { describe, expect, it } from "vitest";
import { client, createTenant, createUser, login, setupTestApp } from "./helpers.ts";
import { JPEG } from "./inspection-helpers.ts";
import { BODIES, EXTRA_PROBES, fingerprint, LIST_QUERY, NO_FOREIGN_IDS, pumpOut, registeredRoutes, richTenant, SCOPE, urlFor, type Own } from "./sw12-helpers.ts";

// SW-12 plan §12 row 17: every route the service-workflow slices registered, called by another
// company with this company's ids. The list comes from the app's own route table, so a route
// added later is swept too, and a new parameter with no fixture here fails the test rather than
// being skipped. Every write sends a schema-valid body (a write with no body here fails the test),
// so a refusal comes from the tenant check, not from validation: it must be the very same answer
// (status, error and message) an id nobody has gets, never a schema 400 and never a success. Lists must answer 200
// with items and carry none of the other company's ids, and nothing of the other company may
// change. Scope is current through SW-9.

// Every flag the build knows, so each slice's routes are registered and swept as it merges.
const ctx = setupTestApp({ features: [...FEATURES], payments: new TestPaymentProvider() });

describe("SW-12 row 17: tenant sweep over the service-workflow routes", () => {
  it("refuses every swept route called with another company's ids, and changes nothing of theirs", async () => {
    const b = await richTenant(ctx);
    expect(Object.entries(b.ids).filter(([, v]) => !v).map(([k]) => k), "company B fixtures").toEqual([]);
    const a = await createTenant(ctx, "Org A");
    const aTech = await createUser(ctx.db, a.org.id, "technician");
    const aTechCookie = await login(ctx.app, aTech.email);
    const before = await fingerprint(ctx, b.org.id);

    const repair = (await a.api.get("/work-types")).json().items.find((t: { key: string }) => t.key === "repair");
    const truck = (await a.api.post("/vehicles", { name: "A truck" })).json();
    const facility = (await a.api.post("/disposal-facilities", { name: "A facility", kind: "wastewater_treatment_plant", city: "Austin" })).json();
    // Company A's own pump-out, in no load, recorded on its technician's phone.
    const ownPumpOut = await pumpOut(a.api, client(ctx.app, aTechCookie), { techId: aTech.id, siteId: a.site.id, truckId: truck.id });
    const own: Own = { workTypeId: repair.id, techId: aTech.id, siteId: a.site.id, truckId: truck.id, facilityId: facility.id, pumpOut: ownPumpOut, b: b.ids };

    const routes = (await registeredRoutes(ctx.app)).filter(([, p]) => SCOPE.some((r) => r.test(p)));
    expect(routes.length).toBeGreaterThan(50);
    const unmapped: string[] = [];
    const wrong: string[] = [];
    const lists: string[] = [];
    const bIds = Object.values(b.ids) as string[];
    let swept = 0;

    for (const [method, path] of routes) {
      const key = `${method} ${path}`;
      const tech = (path.startsWith("/work/") && !path.startsWith("/work/conflicts")) || path.startsWith("/disposal/loads/sync") || /^\/disposal\/loads\/:clientId\/photos/.test(path);
      const headers: Record<string, string> = { cookie: tech ? aTechCookie : a.cookie };
      if (method === "GET" && !path.includes(":")) {
        // A list: company A's must answer 200 with its items and show none of company B's records.
        const res = await ctx.app.inject({ method: "GET", url: path + (LIST_QUERY[path] ?? ""), headers });
        // JSON lists, and the disposal log as CSV or PDF.
        const json = (res.headers["content-type"] ?? "").includes("json");
        const body = res.statusCode !== 200 ? null : json ? res.json() : res.body.length > 0 ? res.body : null;
        if (!body || (json && typeof body !== "object")) lists.push(`${key} -> ${res.statusCode} ${res.body.slice(0, 100)}`);
        else if (bIds.some((id) => res.body.includes(id))) lists.push(`${key} shows company B's records`);
        continue;
      }
      if (method !== "GET" && NO_FOREIGN_IDS[key]) continue;
      const bodyFor = BODIES[key];
      const photo = method === "PUT" && path.includes("/photos/");
      if (method !== "GET" && !bodyFor && !photo) {
        unmapped.push(`${key} (no body)`);
        continue;
      }
      if (key === "GET /form-templates/:key") continue; // keyed per company, checked below
      const url = urlFor(path, { ...b.ids, "form-templates": "work-repair" });
      if (!url) {
        unmapped.push(`${key} (no company-B id)`);
        continue;
      }
      // The main body, then any extra probes for the route; each one is refused on its own.
      const probes = [bodyFor, ...(EXTRA_PROBES[key] ?? [])];
      for (const [n, probe] of probes.entries()) {
        const label = n === 0 ? key : `${key} (probe ${n + 1})`;
        const call = (u: string) =>
          photo
            ? ctx.app.inject({ method: "PUT", url: u, payload: JPEG, headers: { ...headers, "content-type": "image/jpeg", "x-photo-key": path.startsWith("/disposal") ? "manifest" : "before" } })
            : ctx.app.inject({ method: method as "GET", url: u, headers, ...(probe ? { payload: probe(own) } : {}) });
        const res = await call(url);
        swept++;
        const error = res.statusCode >= 400 ? (res.json() as { error?: string }).error : undefined;
        if (error === "invalid_request") {
          wrong.push(`${label}: the sweep's body failed validation, so the tenant check was never reached: ${res.body.slice(0, 160)}`);
          continue;
        }
        // The answer must be exactly what an id nobody has gets (status, error and message), so it
        // shows nothing about company B's record, not even that it exists. Writes whose B id is in
        // the body have no id in the URL to swap, and must answer 404.
        let ok = res.statusCode >= 400 && res.statusCode < 500;
        if (ok && path.includes(":")) {
          const blind = await call(urlFor(path, { ...b.ids, "form-templates": "work-repair" }, crypto.randomUUID())!);
          const shape = (r: typeof res) => `${r.statusCode} ${(r.json() as { error?: string }).error} ${(r.json() as { message?: string }).message}`;
          ok = shape(blind) === shape(res);
        } else if (ok) ok = res.statusCode === 404;
        if (!ok) wrong.push(`${label} -> ${res.statusCode} ${res.body.slice(0, 160)}`);
      }
    }

    expect(unmapped, "swept routes with no fixture or body: add one").toEqual([]);
    expect(wrong, "routes that did not refuse another company's ids").toEqual([]);
    expect(lists, "lists that failed or showed another company's records").toEqual([]);
    expect(swept).toBeGreaterThanOrEqual(50);

    // SW-7: B's own completion summary is a PDF, so the identical-to-unknown answer A got for it
    // above came from the tenant check, not from the work being unfinished.
    const summary = (cookie: string, woId: string) => ctx.app.inject({ method: "GET", url: `/work-orders/${woId}/completion-summary.pdf`, headers: { cookie } });
    const mine = await summary(b.cookie, b.installation);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers["content-type"]).toContain("application/pdf");
    const theirs = await summary(a.cookie, b.installation);
    const unknown = await summary(a.cookie, crypto.randomUUID());
    expect(`${theirs.statusCode} ${theirs.body}`).toBe(`${unknown.statusCode} ${unknown.body}`);
    expect((await summary(b.cookie, b.ids["work-orders"]!)).statusCode, "B's completed repair has a summary too").toBe(200);

    // SW-9: B's visit that already has its work order answers A as an unknown visit would (a
    // missing guard would hand back B's order), and B's own call returns that same order.
    const bookCall = (cookie: string, id: string) => ctx.app.inject({ method: "POST", url: `/obligations/${id}/work-order`, headers: { cookie }, payload: {} });
    const shape = (r: Awaited<ReturnType<typeof bookCall>>) => `${r.statusCode} ${r.body}`;
    expect(shape(await bookCall(a.cookie, b.ids["obligations:booked"]!))).toBe(shape(await bookCall(a.cookie, crypto.randomUUID())));
    const replay = await bookCall(b.cookie, b.ids["obligations:booked"]!);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().id).toBe(b.cycles.workOrder);
    // Scheduling B's pumping visit as an inspection: A gets the unknown-visit answer, never B's
    // "this is a pumping visit", which would show the visit exists and its kind.
    const asJob = (id: string) => ctx.app.inject({ method: "POST", url: "/jobs", headers: { cookie: a.cookie }, payload: { obligationId: id, technicianId: aTech.id, scheduledDate: "2026-03-02" } });
    const foreignJob = await asJob(b.ids.obligations!);
    expect(foreignJob.json().error).not.toBe("not_an_inspection");
    expect(shape(foreignJob)).toBe(shape(await asJob(crypto.randomUUID())));
    // A's due list by kind carries none of B's cycle visits (the list sweep above checked it too).
    const due = await ctx.app.inject({ method: "GET", url: "/obligations/due?serviceType=pumping&through=2027-12-31", headers: { cookie: a.cookie } });
    expect(due.statusCode).toBe(200);
    expect(due.body).not.toContain(b.ids.obligations!);

    // Forms are keyed per company: A sees its own repair form, never B's saved version.
    expect(b.formSaved).toBe(201);
    const aForm = await ctx.app.inject({ method: "GET", url: "/form-templates/work-repair", headers: { cookie: a.cookie } });
    expect(aForm.statusCode).toBe(200);
    expect(aForm.body).not.toContain("Org B private repair form");
    // A saving its own version of the same key changes only A's form.
    const aSaved = await ctx.app.inject({ method: "POST", url: "/form-templates/work-repair/versions", headers: { cookie: a.cookie }, payload: { name: "Org A repair form", definition: aForm.json().definition } });
    expect(aSaved.statusCode, aSaved.body).toBe(201);
    expect((await b.api.get("/form-templates/work-repair")).json().name).toBe("Org B private repair form");

    // B's form rows are untouched too (inspection_templates is in the fingerprint).
    expect(await fingerprint(ctx, b.org.id)).toEqual(before);
  });
});
