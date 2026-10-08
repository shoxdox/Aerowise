import { PERMISSIONS, roleHasPermission, type Feature, type Role } from "@aerowise/domain";
import { TestPaymentProvider } from "@aerowise/payments";
import { describe, expect, it } from "vitest";
import { createUser, login, setupTestApp } from "./helpers.ts";
import { JPEG } from "./inspection-helpers.ts";
import { richTenant, routeTable, SCOPE, urlFor } from "./sw12-helpers.ts";

// SW-12 plan §12 row 18: one role matrix over every service-workflow route, taken from the app's
// own route table, called by each role of the same company with that company's own ids. Every
// route's allowed roles must be exactly the roles of one permission (no route opens to a role
// another way); read-only people change nothing; a technician writes only their own phone work
// and never sees prices or other technicians' records; office cannot change company-wide work types
// or forms.

const ON: Feature[] = ["work_orders", "service_items", "field_work", "estimates", "deposits", "plan_builder"];
const ctx = setupTestApp({ features: ON, payments: new TestPaymentProvider() });
const ROLES: Role[] = ["read_only", "technician", "office", "owner"];
/** The technician's own phone work: the only swept writes a technician may make. */
const TECH_WRITES = ["PUT /work/sync", "PUT /work/:clientId/photos/:photoClientId", "PUT /work/:clientId/signatures/:signatureClientId"];

describe("SW-12 row 18: role matrix over the service-workflow routes", () => {
  it("gives each route exactly one permission's roles, and keeps each role to its own work", async () => {
    const b = await richTenant(ctx);
    const ids = { ...b.ids, "form-templates": "work-repair" };
    const cookies: Record<Role, string> = {
      owner: b.cookie,
      technician: await login(ctx.app, b.tech.email),
      office: await login(ctx.app, (await createUser(ctx.db, b.org.id, "office")).email),
      read_only: await login(ctx.app, (await createUser(ctx.db, b.org.id, "read_only")).email),
    };

    const routes = routeTable(ctx.app.printRoutes({ commonPrefix: false })).filter(([, p]) => SCOPE.some((r) => r.test(p)));
    const unmapped: string[] = [];
    const inconsistent: string[] = [];
    const matrix: string[] = [];
    const allowed = new Map<string, Set<Role>>();
    for (const [method, path] of routes) {
      const url = urlFor(path, ids);
      if (!url) {
        unmapped.push(`${method} ${path}`);
        continue;
      }
      const roles = new Set<Role>();
      for (const role of ROLES) {
        const headers = { cookie: cookies[role] };
        const res =
          method === "PUT" && /\/photos\//.test(url)
            ? await ctx.app.inject({ method, url, payload: JPEG, headers: { ...headers, "content-type": "image/jpeg", "x-photo-key": "before" } })
            : await ctx.app.inject({ method: method as "GET", url, headers, ...(method === "GET" ? {} : { payload: {} }) });
        // The role check answers 403 "forbidden"; a handler's own 403 (say, "not_assigned" for an
        // owner sending a technician's photo) means the role got through.
        if (!(res.statusCode === 403 && res.body.includes('"error":"forbidden"'))) roles.add(role);
      }
      const key = `${method} ${path}`;
      allowed.set(key, roles);
      matrix.push(`${key}: ${[...roles].join(", ") || "nobody"}`);
      // The roles let through are exactly the roles holding some one permission.
      const fits = PERMISSIONS.some((p) => ROLES.every((r) => roleHasPermission(r, p) === roles.has(r)));
      if (!fits) inconsistent.push(`${key}: ${[...roles].join(", ")}`);
    }
    expect(unmapped, "swept routes with no fixture: add one").toEqual([]);
    expect(routes.length).toBeGreaterThan(50);
    expect(inconsistent, "routes whose allowed roles match no single permission").toEqual([]);

    const writes = [...allowed].filter(([k]) => !k.startsWith("GET "));
    // Read-only people change nothing.
    expect(writes.filter(([, r]) => r.has("read_only")).map(([k]) => k)).toEqual([]);
    // A technician writes only their own phone work.
    expect(writes.filter(([, r]) => r.has("technician")).map(([k]) => k).sort()).toEqual([...TECH_WRITES].sort());
    // Office cannot change the company's work types or work forms; the owner can.
    for (const k of ["POST /work-types", "PATCH /work-types/:id", "POST /form-templates/:key/versions"]) {
      expect([...allowed.get(k)!], k).toEqual(["owner"]);
    }
    // Office runs the work itself.
    for (const k of ["POST /work-orders", "POST /work-orders/:id/schedule", "POST /estimates"]) expect(allowed.get(k)!.has("office"), k).toBe(true);
    // A technician never sees prices.
    for (const k of ["GET /estimates", "GET /estimates/:id"]) expect(allowed.get(k)!.has("technician"), k).toBe(false);

    // A technician sees only their own field records and visits.
    const other = await createUser(ctx.db, b.org.id, "technician");
    const otherCookie = await login(ctx.app, other.email);
    const get = (url: string, cookie: string) => ctx.app.inject({ method: "GET", url, headers: { cookie } });
    expect((await get(`/work-records/${b.ids["work-records"]}`, cookies.technician)).statusCode).toBe(200);
    expect((await get(`/work-records/${b.ids["work-records"]}`, otherCookie)).statusCode).toBe(404);
    expect((await get(`/jobs/${b.ids.jobs}/work-record`, otherCookie)).statusCode).toBe(404);
    const route = await get("/work/route?date=2026-03-01", otherCookie);
    expect(route.statusCode).toBe(200);
    expect(route.body).not.toContain(b.ids.jobs!);

    console.info(`SW-12 role matrix (${matrix.length} routes):\n${matrix.join("\n")}`);
  });
});
