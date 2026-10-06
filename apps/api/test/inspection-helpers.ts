import { DEFAULT_TEMPLATE } from "@aerowise/domain";
import { expect } from "vitest";
import { client, createTenant, createUser, login, type TestContext } from "./helpers.ts";

export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

/** A tenant with a technician who has one scheduled visit today. Today is 2026-03-01. */
export async function setup(c: TestContext, name = "Org A") {
  const t = await createTenant(c, name);
  const plan = (await t.api.post("/plans", { name: "Annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })).json();
  const contract = (await t.api.post(`/sites/${t.site.id}/contracts`, { planId: plan.id, startOn: "2025-12-01" })).json();
  const tech = await createUser(c.db, t.org.id, "technician");
  const techApi = client(c.app, await login(c.app, tech.email));
  const visit = contract.obligations[0];
  const job = (await t.api.post("/jobs", { obligationId: visit.id, technicianId: tech.id, scheduledDate: "2026-03-01" })).json();
  const template = (await techApi.get("/inspection-template")).json();
  return { ...t, contract, tech, techApi, visit, job, template };
}

/** Every required answer, passing, with a working chlorinator. */
export const completeValues = () => {
  const values: Record<string, string | number | boolean> = {};
  for (const f of DEFAULT_TEMPLATE.definition.fields) if (f.type === "pass_fail") values[f.key] = "pass";
  return { ...values, chlorinator: "working", chlorine_level: 1.5, odor: "none", pumping_needed: false };
};

/** `completeValues` plus the report fields some authorities require (form v2): sludge, pH, spray area, alterations. */
export const countyValues = () => ({ ...completeValues(), pump_tank_sludge: 6, pump_tank_ph: 7.2, spray_area: "acceptable", unauthorized_alterations: "none_found" });

export type Setup = Awaited<ReturnType<typeof setup>>;

export function payload(s: Setup, overrides: Record<string, unknown> = {}) {
  return {
    clientId: "8b0e7c1e-4a43-4c1f-9d4e-6a2f5b1c0d01",
    jobId: s.job.jobId,
    templateId: s.template.id,
    status: "draft",
    arrivedAt: "2026-03-01T15:00:00Z",
    arrivalGps: { lat: 30.27, lng: -97.74, accuracyM: 8 },
    values: { aerator: "pass" },
    ...overrides,
  };
}

export const photoUrl = (clientId: string, n: number) => `/inspections/${clientId}/photos/00000000-0000-4000-8000-00000000000${n}`;

export async function uploadRequiredPhotos(s: Setup, clientId: string) {
  for (const [n, key] of [[1, "overview"], [2, "chlorinator"]] as const) {
    const res = await s.techApi.putImage(photoUrl(clientId, n), JPEG, { "x-photo-key": key, "x-captured-at": "2026-03-01T15:10:00Z" });
    expect(res.statusCode).toBe(201);
  }
}


/**
 * The owner, as the organization's licensed maintenance provider, signs the inspection's
 * reports (30 TAC 285.7(b)(3)); the technician is registered. Customer copies of real
 * Texas sites only go out signed.
 */
export async function signAsProvider(s: Setup, inspectionId: string) {
  const mp = await s.api.post("/credentials", { userId: s.owner.id, holderName: "Owner Person", kind: "tceq_maintenance_provider", number: "MP0001234", verifiedOn: "2026-02-20", verificationSource: "TCEQ license search" });
  expect(mp.statusCode, mp.body).toBe(201);
  await s.api.post("/credentials", { userId: s.tech.id, holderName: "Tech Person", kind: "tceq_maintenance_technician", number: "MT0005678", expiresOn: "2027-01-31" });
  expect((await s.api.put("/settings/responsible-provider", { credentialId: mp.json().id })).statusCode).toBe(200);
  const signed = await s.api.post(`/inspections/${inspectionId}/signature`, { typedName: "Owner Person" });
  expect(signed.statusCode, signed.body).toBe(200);
  return signed.json();
}
