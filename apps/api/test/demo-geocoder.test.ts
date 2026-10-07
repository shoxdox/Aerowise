import { locatePendingSites, TestGeocoder, type AddressQuery, type Geocoder } from "@aerowise/routing";
import { demoCheck, DemoGatedGeocoder } from "@aerowise/tasks";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.ts";
import { client, createUser, login, setupTestApp } from "./helpers.ts";

// A deployment with the real (Census) geocoder configured, holding a demo company next to a real
// one. A demo company's addresses are made up, so they must only ever reach the test geocoder.

class LiveGeocoder implements Geocoder {
  readonly kind = "census" as const;
  asked: string[] = [];
  async geocode(a: AddressQuery) {
    this.asked.push(a.addressLine1);
    return { lat: 30.3, lng: -97.7 };
  }
}

const ctx = setupTestApp();
const liveGeocoder = new LiveGeocoder();
let gate: DemoGatedGeocoder;
let app: App;

beforeAll(async () => {
  gate = new DemoGatedGeocoder(liveGeocoder, new TestGeocoder(), demoCheck(ctx.db));
  app = await buildApp({ db: ctx.db, production: true, fileSigningSecret: "demo-geocoder", loginRateLimit: 1000, now: () => ctx.now, store: ctx.store, geocoder: gate });
});
afterAll(async () => {
  await app.close();
});

async function company(name: string, demo: boolean) {
  const org = await ctx.db
    .insertInto("organizations")
    .values({ name, demo, email: demo ? "office@example.com" : "office@realseptic.com", phone: demo ? "(512) 555-0100" : "(512) 867-5309" } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  const owner = await createUser(ctx.db, org.id, "owner");
  const api = client(app, await login(app, owner.email));
  const customer = (await api.post("/customers", { displayName: `${name} customer` })).json();
  await api.post(`/customers/${customer.id}/sites`, { addressLine1: `1 ${name} Rd`, city: "Austin" });
  return { org, api };
}

describe("finding addresses for a demo company", () => {
  it("never sends its made-up addresses to the real geocoder", async () => {
    liveGeocoder.asked = [];
    const demo = await company("Demo Co", true);
    const real = await company("Real Septic", false);
    await locatePendingSites(ctx.db, gate, demo.org.id);
    await locatePendingSites(ctx.db, gate, real.org.id);
    expect((await demo.api.patch("/routing/settings", { start: { addressLine1: "9 Demo Yard", city: "Austin" } })).statusCode).toBe(200);
    expect((await real.api.patch("/routing/settings", { start: { addressLine1: "9 Real Yard", city: "Austin" } })).statusCode).toBe(200);
    expect(liveGeocoder.asked).toEqual(["1 Real Septic Rd", "9 Real Yard"]);
    // The demo company's sites were still placed, by the test geocoder.
    const demoSite = await ctx.db.selectFrom("sites").select(["lat", "lng"]).where("organizationId", "=", demo.org.id).executeTakeFirstOrThrow();
    expect(demoSite.lat).not.toBeNull();
  });

  it("fails closed: no company, or one not on record, gets the test geocoder", async () => {
    liveGeocoder.asked = [];
    await gate.geocode({ addressLine1: "1 Nobody Rd", city: "Austin", state: "TX" });
    await gate.geocode({ addressLine1: "1 Unknown Rd", city: "Austin", state: "TX" }, randomUUID());
    expect(liveGeocoder.asked).toEqual([]);
    expect(gate.kind).toBe("census");
  });
});
