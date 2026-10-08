import { describe, expect, it } from "vitest";
import { createTenant, setupTestApp } from "./helpers.ts";

// SW-6 with the pumping flag off (§9.1): its create routes refuse with 409 feature_off, and what
// exists stays readable.
const ctx = setupTestApp({ features: ["work_orders", "field_work"] });

describe("pumping switched off", () => {
  it("refuses new trucks, facilities and disposal records, and still lists what exists", async () => {
    const t = await createTenant(ctx, "Org A");
    const truck = await t.api.post("/vehicles", { name: "Truck 1" });
    expect([truck.statusCode, truck.json().error]).toEqual([409, "feature_off"]);
    const facility = await t.api.post("/disposal-facilities", { name: "Plant", kind: "other" });
    expect([facility.statusCode, facility.json().error]).toEqual([409, "feature_off"]);
    const load = await t.api.put("/disposal/loads/sync", {
      clientId: crypto.randomUUID(),
      facilityId: crypto.randomUUID(),
      deliveredOn: "2026-03-01",
      total: 1,
      unit: "gallons",
      pumpingGroupIds: [crypto.randomUUID()],
    });
    expect([load.statusCode, load.json().error]).toEqual([409, "feature_off"]);
    expect((await t.api.get("/vehicles")).json().items).toEqual([]);
    expect((await t.api.get("/disposal/loads")).statusCode).toBe(200);
  });
});
