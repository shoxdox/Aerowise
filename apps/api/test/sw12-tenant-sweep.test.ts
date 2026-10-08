import type { Feature } from "@aerowise/domain";
import { TestPaymentProvider } from "@aerowise/payments";
import { describe, expect, it } from "vitest";
import { createTenant, createUser, login, setupTestApp } from "./helpers.ts";
import { JPEG } from "./inspection-helpers.ts";
import { fingerprint, richTenant, routeTable, SCOPE, urlFor } from "./sw12-helpers.ts";

// SW-12 plan §12 row 17: every route the service-workflow slices registered, called by another
// company with this company's ids. The list comes from the app's own route table, so a route
// added later is swept too, and a new parameter with no fixture here fails the test rather than
// being skipped. Every write sends a schema-valid body (a write with no body here fails the test),
// so a refusal comes from the tenant check, not from validation: it must be 404, or the very same
// refusal an id nobody has gets, never a schema 400 and never a success. Lists must answer 200
// with items and carry none of the other company's ids, and nothing of the other company may
// change. The swept surface is the core six flags today: SW-6, SW-7 and SW-9 routes and flags are
// added to SCOPE, ON and the bodies here as they merge.

const ON: Feature[] = ["work_orders", "service_items", "field_work", "estimates", "deposits", "plan_builder"];
const ctx = setupTestApp({ features: ON, payments: new TestPaymentProvider() });

/** Valid bodies for each swept write. `a` holds company A's own ids, so only company B's id in the
 * URL (or named in the body) can be what is refused. */
type Own = { workTypeId: string; techId: string; siteId: string; b: Record<string, string | undefined> };
const req = () => ({ requestId: crypto.randomUUID(), amountCents: 100, reason: "Sweep" });
const summary = { workDone: "Reset alarm", parts: [], notes: "" };
const BODIES: Record<string, (a: Own) => object> = {
  "POST /invoices/:id/deposit/refund": req,
  "POST /invoices/:id/deposit/retain": req,
  "POST /invoices/:id/deposit/shortfall": () => ({ ...req(), kind: "write_off" }),
  "POST /invoices/:id/refund-job": req,
  "POST /issues/:id/work-order": (a) => ({ workTypeId: a.workTypeId, title: "Sweep" }),
  "POST /issues/:id/estimate": () => ({ lines: [{ description: "Sweep", quantity: 1, unitPriceCents: 100 }] }),
  "POST /service-requests/:id/work-order": (a) => ({ workTypeId: a.workTypeId, title: "Sweep" }),
  "POST /service-requests/:id/estimate": () => ({ lines: [{ description: "Sweep", quantity: 1, unitPriceCents: 100 }] }),
  "POST /contracts/:id/renew": () => ({ priceCents: 100 }),
  "POST /contracts/:id/cancel": () => ({ reason: "Sweep" }),
  "POST /contracts/:id/invoice": () => ({}),
  "POST /contracts/:id/document": () => ({ filename: "sweep.pdf", contentBase64: Buffer.from("%PDF-1.4 sweep").toString("base64") }),
  "POST /contracts/:id/discontinuation-notice": () => ({ sentOn: "2026-03-01", note: "Sweep notice" }),
  "PUT /contracts/:id/filing-basis": () => ({ basis: "renewal", basisOn: "2026-03-01" }),
  "PUT /contracts/:id/provider": () => ({ credentialId: null }),
  "PATCH /service-items/:id": () => ({ name: "Sweep" }),
  "PATCH /plans/:id": () => ({ name: "Sweep" }),
  "POST /plans/:id/versions": () => ({ termsText: "Fictional sweep terms text.", options: [], coverage: [] }),
  "PATCH /work-types/:id": () => ({ name: "Sweep" }),
  "PATCH /work-orders/:id": () => ({ title: "Sweep" }),
  "POST /work-orders/:id/schedule": (a) => ({ technicianId: a.techId, scheduledDate: "2026-03-02" }),
  "POST /work-orders/:id/cancel": () => ({ reason: "Sweep" }),
  "POST /work-orders/:id/complete": () => ({ reason: "Sweep" }),
  "POST /work-orders/:id/coverage/apply": () => ({}),
  "POST /work-orders/:id/coverage/decline": () => ({ reason: "Sweep" }),
  "POST /work-orders/:id/coverage/restore": () => ({ reason: "Sweep" }),
  "POST /work-orders/:id/invoice": () => ({}),
  "POST /work-orders/:id/notes": () => ({ body: "Sweep" }),
  "POST /work/conflicts/:id/attach": () => ({ note: "Sweep" }),
  "POST /work/conflicts/:id/dismiss": () => ({ reason: "Sweep" }),
  "PUT /work/:clientId/signatures/:signatureClientId": () => ({
    requirementKey: "customer_signoff",
    signerName: "Pat",
    capture: { kind: "typed" },
    summary,
    summarySha256: "0".repeat(64),
    consentText: "I confirm this work was done.",
    signedAt: "2026-03-01T15:55:00Z",
  }),
  "PATCH /estimates/:id": () => ({ title: "Sweep" }),
  "POST /estimates/:id/send": () => ({ email: false }),
  "POST /estimates/:id/link": () => ({}),
  "POST /estimates/:id/revise": () => ({}),
  "POST /estimates/:id/record-acceptance": () => ({ evidence: "Sweep" }),
  "POST /estimates/:id/void": () => ({ reason: "Sweep" }),
  "POST /estimates/:id/cancel": () => ({ reason: "Sweep" }),
  // Writes with no id in the URL that name company B's records in the body.
  "POST /work-orders": (a) => ({ siteId: a.b.sites, workTypeId: a.workTypeId }),
  "POST /estimates": (a) => ({ siteId: a.b.sites, lines: [{ description: "Sweep", quantity: 1, unitPriceCents: 100 }] }),
  "PUT /work/sync": (a) => ({ clientId: crypto.randomUUID(), jobId: a.b.jobs, templateId: crypto.randomUUID(), status: "draft", revision: 1, arrivedAt: "2026-03-01T15:00:00Z", completedAt: null, values: {}, summary }),
};
/** Writes whose body names no record at all: nothing of another company to reach. */
const NO_FOREIGN_IDS: Record<string, string> = {
  "POST /service-items": "creates the caller's own item from plain fields",
  "POST /plans": "creates the caller's own plan from plain fields",
  "POST /work-types": "creates the caller's own work type from plain fields",
  "POST /intake-forms": "creates the caller's own form from plain fields",
  "POST /form-templates/:key/versions": "forms are keyed per company: the key names the caller's own form (checked below)",
};
/** Query strings some lists require. */
const LIST_QUERY: Record<string, string> = { "/work/route": "?date=2026-03-01" };

describe("SW-12 row 17: tenant sweep over the service-workflow routes", () => {
  it("refuses every swept route called with another company's ids, and changes nothing of theirs", async () => {
    const b = await richTenant(ctx);
    expect(Object.entries(b.ids).filter(([, v]) => !v).map(([k]) => k), "company B fixtures").toEqual([]);
    const a = await createTenant(ctx, "Org A");
    const aTech = await createUser(ctx.db, a.org.id, "technician");
    const aTechCookie = await login(ctx.app, aTech.email);
    const before = await fingerprint(ctx, b.org.id);

    const repair = (await a.api.get("/work-types")).json().items.find((t: { key: string }) => t.key === "repair");
    const own: Own = { workTypeId: repair.id, techId: aTech.id, siteId: a.site.id, b: b.ids };

    const routes = routeTable(ctx.app.printRoutes({ commonPrefix: false })).filter(([, p]) => SCOPE.some((r) => r.test(p)));
    expect(routes.length).toBeGreaterThan(50);
    const unmapped: string[] = [];
    const wrong: string[] = [];
    const lists: string[] = [];
    const bIds = Object.values(b.ids) as string[];
    let swept = 0;

    for (const [method, path] of routes) {
      const key = `${method} ${path}`;
      const tech = path.startsWith("/work/") && !path.startsWith("/work/conflicts");
      const headers: Record<string, string> = { cookie: tech ? aTechCookie : a.cookie };
      if (method === "GET" && !path.includes(":")) {
        // A list: company A's must answer 200 with its items and show none of company B's records.
        const res = await ctx.app.inject({ method: "GET", url: path + (LIST_QUERY[path] ?? ""), headers });
        const body = res.statusCode === 200 ? res.json() : null;
        if (!body || typeof body !== "object") lists.push(`${key} -> ${res.statusCode} ${res.body.slice(0, 100)}`);
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
      const call = (u: string) =>
        photo
          ? ctx.app.inject({ method: "PUT", url: u, payload: JPEG, headers: { ...headers, "content-type": "image/jpeg", "x-photo-key": "before" } })
          : ctx.app.inject({ method: method as "GET", url: u, headers, ...(bodyFor ? { payload: bodyFor(own) } : {}) });
      const res = await call(url);
      swept++;
      const error = res.statusCode >= 400 ? (res.json() as { error?: string }).error : undefined;
      if (error === "invalid_request") {
        wrong.push(`${key}: the sweep's body failed validation, so the tenant check was never reached: ${res.body.slice(0, 160)}`);
        continue;
      }
      if (res.statusCode === 404) continue;
      // Anything but 404 must be a refusal, and the very one an id nobody has gets (no sign that
      // company B's record exists). Writes whose B id is in the body have no id in the URL to swap.
      let ok = res.statusCode >= 400 && res.statusCode < 500 && path.includes(":");
      if (ok) {
        const blind = await call(urlFor(path, { ...b.ids, "form-templates": "work-repair" }, crypto.randomUUID())!);
        ok = blind.statusCode === res.statusCode && (blind.json() as { error?: string }).error === error;
      }
      if (!ok) wrong.push(`${key} -> ${res.statusCode} ${res.body.slice(0, 160)}`);
    }

    expect(unmapped, "swept routes with no fixture or body: add one").toEqual([]);
    expect(wrong, "routes that did not refuse another company's ids").toEqual([]);
    expect(lists, "lists that failed or showed another company's records").toEqual([]);
    expect(swept).toBeGreaterThanOrEqual(50);

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
