import { FEATURES, PERMISSIONS, roleHasPermission, type Permission, type Role } from "@aerowise/domain";
import { TestPaymentProvider } from "@aerowise/payments";
import { describe, expect, it } from "vitest";
import { createUser, login, setupTestApp } from "./helpers.ts";
import { JPEG } from "./inspection-helpers.ts";
import { BODIES, LIST_QUERY, registeredRoutes, richTenant, SCOPE, urlFor, type Own } from "./sw12-helpers.ts";

// SW-12 plan §12 row 18: one role matrix over every service-workflow route, taken from the app's
// own route table, called by each role of the same company with that company's own ids. Every
// route's allowed roles must be exactly the roles of one permission, or of the documented
// either-of pair a route checks in its handler (no route opens to a role another way). Every write
// sends a schema-valid body, so a role check inside the handler is reached too (a validation 400
// fails the test). Read-only people change nothing; a technician writes only their own phone work
// and never sees prices or other technicians' records; office cannot change company-wide work types
// or forms.

// Every flag the build knows, so each slice's routes are in the matrix as it merges.
const ctx = setupTestApp({ features: [...FEATURES], payments: new TestPaymentProvider() });
const ROLES: Role[] = ["read_only", "technician", "office", "owner"];
/** The technician's own phone work: the only swept writes a technician may make. */
const TECH_WRITES = [
  "PUT /work/sync",
  "PUT /work/:clientId/photos/:photoClientId",
  "PUT /work/:clientId/signatures/:signatureClientId",
  "PUT /disposal/loads/sync",
  "PUT /disposal/loads/:clientId/photos/:photoClientId",
];
/** Routes that admit either of two permissions, checked in the handler (documented in their OpenAPI text). */
const EITHER: Record<string, [string, string]> = {
  "PUT /disposal/loads/sync": ["work:write", "work:complete"],
  "PUT /disposal/loads/:clientId/photos/:photoClientId": ["work:write", "work:complete"],
};
/** Valid bodies for the writes that name no other record (the tenant sweep skips those). */
const CREATE_BODIES: Record<string, (form: { definition: unknown }) => object> = {
  "POST /service-items": () => ({ name: `Item ${crypto.randomUUID()}`, unitPriceCents: 100 }),
  "POST /plans": () => ({ name: `Plan ${crypto.randomUUID()}`, termMonths: 12, visitsPerTerm: 2, priceCents: 100 }),
  "POST /work-types": () => ({ key: `k${crypto.randomUUID().slice(0, 8)}`, name: "Matrix", category: "other" }),
  "POST /intake-forms": () => ({ key: `m${crypto.randomUUID().slice(0, 8)}`, name: "Matrix", definition: { photos: [], fields: [{ key: "changes", label: "Anything changed?", section: "Before you sign", type: "boolean", required: true }] } }),
  "POST /form-templates/:key/versions": (form) => ({ name: "Matrix", definition: form.definition }),
  "POST /vehicles": () => ({ name: `Truck ${crypto.randomUUID().slice(0, 8)}` }),
  "POST /disposal-facilities": () => ({ name: `Facility ${crypto.randomUUID().slice(0, 8)}`, kind: "wastewater_treatment_plant", city: "Austin" }),
  "PATCH /pumping/settings": () => ({ disposalOverdueDays: 7 }),
};

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

    const repair = (await b.api.get("/work-types")).json().items.find((x: { key: string }) => x.key === "repair");
    const own: Own = { workTypeId: repair.id, techId: b.tech.id, siteId: b.site.id, truckId: b.ids.vehicles!, facilityId: b.ids["disposal-facilities"]!, pumpOut: b.ids["pumping-records:unloaded"]!, b: b.ids };
    const form = (await b.api.get("/form-templates/work-repair")).json();

    const routes = (await registeredRoutes(ctx.app)).filter(([, p]) => SCOPE.some((r) => r.test(p)));
    const unmapped: string[] = [];
    const invalid: string[] = [];
    const inconsistent: string[] = [];
    const matrix: string[] = [];
    const allowed = new Map<string, Set<Role>>();
    for (const [method, path] of routes) {
      const key = `${method} ${path}`;
      const base = urlFor(path, ids);
      const bodyFor = BODIES[key] ? () => BODIES[key]!(own) : CREATE_BODIES[key] ? () => CREATE_BODIES[key]!(form) : null;
      const photo = method === "PUT" && path.includes("/photos/");
      if (method !== "GET" && !bodyFor && !photo) {
        unmapped.push(`${key} (no body)`);
        continue;
      }
      if (!base) {
        unmapped.push(`${method} ${path}`);
        continue;
      }
      const url = base + (method === "GET" && !path.includes(":") ? (LIST_QUERY[path] ?? "") : "");
      const roles = new Set<Role>();
      for (const role of ROLES) {
        const headers = { cookie: cookies[role] };
        const res =
          photo
            ? await ctx.app.inject({ method, url, payload: JPEG, headers: { ...headers, "content-type": "image/jpeg", "x-photo-key": path.startsWith("/disposal") ? "manifest" : "before" } })
            : await ctx.app.inject({ method: method as "GET", url, headers, ...(bodyFor ? { payload: bodyFor() } : {}) });
        if (res.statusCode === 400 && res.body.includes('"error":"invalid_request"')) invalid.push(`${key} as ${role}: ${res.body.slice(0, 160)}`);
        // The role check answers 403 "forbidden"; a handler's own 403 (say, "not_assigned" for an
        // owner sending a technician's photo) means the role got through.
        if (!(res.statusCode === 403 && res.body.includes('"error":"forbidden"'))) roles.add(role);
      }
      allowed.set(key, roles);
      matrix.push(`${key}: ${[...roles].join(", ") || "nobody"}`);
      // The roles let through are exactly the roles holding some one permission.
      const either = EITHER[key] as [Permission, Permission] | undefined;
      const fits = either
        ? ROLES.every((r) => (roleHasPermission(r, either[0]) || roleHasPermission(r, either[1])) === roles.has(r))
        : PERMISSIONS.some((p) => ROLES.every((r) => roleHasPermission(r, p) === roles.has(r)));
      if (!fits) inconsistent.push(`${key}: ${[...roles].join(", ")}`);
    }
    expect(unmapped, "swept routes with no fixture or body: add one").toEqual([]);
    expect(invalid, "the matrix's body failed validation, so a role check in the handler was never reached").toEqual([]);
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
