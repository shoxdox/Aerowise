import type { Feature } from "@aerowise/domain";
import { TestPaymentProvider } from "@aerowise/payments";
import { describe, expect, it } from "vitest";
import { createTenant, createUser, login, setupTestApp } from "./helpers.ts";
import { JPEG } from "./inspection-helpers.ts";
import { fingerprint, richTenant, routeTable, SCOPE, urlFor } from "./sw12-helpers.ts";

// SW-12 plan §12 row 17: every route the service-workflow slices registered, called by another
// company with this company's ids. The list comes from the app's own route table, so a route
// added later is swept too, and a new parameter with no fixture here fails the test rather than
// being skipped. Reads must answer 404; writes must not succeed, nor answer differently from an id nobody has,
// and nothing of the other company may change. List reads must not carry the other company's ids.

const ON: Feature[] = ["work_orders", "service_items", "field_work", "estimates", "deposits", "plan_builder"];
const ctx = setupTestApp({ features: ON, payments: new TestPaymentProvider() });

describe("SW-12 row 17: tenant sweep over the service-workflow routes", () => {
  it("refuses every swept route called with another company's ids, and changes nothing of theirs", async () => {
    const b = await richTenant(ctx);
    expect(Object.entries(b.ids).filter(([, v]) => !v).map(([k]) => k), "company B fixtures").toEqual([]);
    const a = await createTenant(ctx, "Org A");
    const aTech = await createUser(ctx.db, a.org.id, "technician");
    const aTechCookie = await login(ctx.app, aTech.email);
    const before = await fingerprint(ctx, b.org.id);

    const routes = routeTable(ctx.app.printRoutes({ commonPrefix: false })).filter(([, p]) => SCOPE.some((r) => r.test(p)));
    expect(routes.length).toBeGreaterThan(50);
    const unmapped: string[] = [];
    const wrong: string[] = [];
    const listLeaks: string[] = [];
    const bIds = Object.values(b.ids) as string[];
    let swept = 0;

    for (const [method, path] of routes) {
      if (!path.includes(":")) {
        if (method !== "GET") continue;
        // A list: company A's must not show any of company B's records.
        const res = await ctx.app.inject({ method: "GET", url: path, headers: { cookie: a.cookie } });
        if (bIds.some((id) => res.body.includes(id))) listLeaks.push(`${method} ${path}`);
        continue;
      }
      if (path.startsWith("/form-templates/:key")) continue; // keyed per company, checked below
      const url = urlFor(path, b.ids);
      if (!url) {
        unmapped.push(`${method} ${path}`);
        continue;
      }
      const tech = url.startsWith("/work/") && !url.startsWith("/work/conflicts");
      const headers: Record<string, string> = { cookie: tech ? aTechCookie : a.cookie };
      const call = (u: string) =>
        method === "PUT" && /\/photos\//.test(u)
          ? ctx.app.inject({ method, url: u, payload: JPEG, headers: { ...headers, "content-type": "image/jpeg", "x-photo-key": "before" } })
          : ctx.app.inject({ method: method as "GET", url: u, headers, ...(method === "GET" ? {} : { payload: {} }) });
      const res = await call(url);
      swept++;
      let ok = method === "GET" ? res.statusCode === 404 : res.statusCode >= 400 && res.statusCode < 500;
      // A 409 is fine only when it is the same answer an id nobody has gets: it must not show
      // that company B's record exists.
      if (ok && res.statusCode === 409) {
        const blind = await call(urlFor(path, b.ids, crypto.randomUUID())!);
        ok = blind.statusCode === 409 && blind.json().error === res.json().error;
      }
      if (!ok) wrong.push(`${method} ${path} -> ${res.statusCode} ${res.body.slice(0, 120)}`);
    }

    expect(unmapped, "swept routes with no company-B fixture: add one").toEqual([]);
    expect(wrong, "routes that did not refuse another company's ids").toEqual([]);
    expect(listLeaks, "lists that showed another company's records").toEqual([]);
    expect(swept).toBeGreaterThanOrEqual(50);

    // Forms are keyed per company: A sees its own repair form, never B's saved version.
    expect(b.formSaved).toBe(201);
    const aForm = await ctx.app.inject({ method: "GET", url: "/form-templates/work-repair", headers: { cookie: a.cookie } });
    expect(aForm.statusCode).toBe(200);
    expect(aForm.body).not.toContain("Org B private repair form");

    expect(await fingerprint(ctx, b.org.id)).toEqual(before);
  });
});
