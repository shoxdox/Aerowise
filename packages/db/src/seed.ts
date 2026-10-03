import type { Database } from "./client.ts";
import { hashPassword } from "./password.ts";

// Demo data for local development: one fictional provider, three users and ~50
// customers with sites and systems. Every name, address and permit number is made up.

export const DEMO_ORG_NAME = "Hill Country Aerobic Services (demo)";
export const DEMO_PASSWORD = "aerowise-dev";
export const DEMO_USERS = [
  { name: "Olivia Owner", email: "owner@example.com", role: "owner" },
  { name: "Oscar Office", email: "office@example.com", role: "office" },
  { name: "Tess Tech", email: "tech@example.com", role: "technician" },
] as const;

const FIRST = ["James", "Maria", "Robert", "Linda", "Carlos", "Patricia", "David", "Rosa", "Michael", "Karen", "Jose", "Susan", "Daniel", "Lupe", "Thomas", "Nancy"];
const LAST = ["Hartley", "Gonzales", "Whitfield", "Ramirez", "Calloway", "Nguyen", "Brennan", "Salinas", "Dorsey", "Medina", "Pruitt", "Castillo", "Langford", "Villarreal"];
const STREETS = ["Cedar Ridge Rd", "Live Oak Ln", "Bluebonnet Trl", "Mesquite Dr", "Old Mill Rd", "Pecan Hollow", "County Road 214", "Ranch Road 1863", "Deer Creek Dr", "Limestone Way"];
const PLACES = [
  { city: "Dripping Springs", county: "Example County", zip: "78620", lat: 30.19, lng: -98.09 },
  { city: "Wimberley", county: "Example County", zip: "78676", lat: 30.0, lng: -98.1 },
  { city: "Blanco", county: "Sample County", zip: "78606", lat: 30.1, lng: -98.42 },
  { city: "Spicewood", county: "Sample County", zip: "78669", lat: 30.47, lng: -98.16 },
];
const MAKERS = [
  { manufacturer: "Acme Aerobic", models: ["AA-500", "AA-750"] },
  { manufacturer: "ClearFlow Systems", models: ["CF-600", "CF-800"] },
  { manufacturer: "TreatRight", models: ["TR-1", "TR-2X"] },
];
const DISPOSAL = ["spray", "drip", "spray"];
const CHLORINE = ["tablet", "liquid", "tablet", "none"];

/** Small deterministic PRNG so every developer gets the same demo data. */
function rng(seed: number) {
  let s = seed;
  const next = () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
  return {
    next,
    int: (max: number) => Math.floor(next() * max),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
  };
}

export async function seed(db: Database, log: (msg: string) => void = () => {}) {
  const existing = await db.selectFrom("organizations").select("id").where("name", "=", DEMO_ORG_NAME).executeTakeFirst();
  if (existing) {
    log(`demo organization already exists (${existing.id}); nothing to do`);
    return;
  }

  const r = rng(42);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await db.transaction().execute(async (trx) => {
    const org = await trx
      .insertInto("organizations")
      .values({
        name: DEMO_ORG_NAME,
        phone: "(512) 555-0100",
        email: "office@example.com",
        addressLine1: "100 Example Pkwy",
        addressLine2: null,
        city: "Dripping Springs",
        state: "TX",
        postalCode: "78620",
        logoUrl: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    for (const u of DEMO_USERS) {
      const user = await trx
        .insertInto("users")
        .values({ name: u.name, email: u.email, phone: null, passwordHash })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("memberships")
        .values({
          organizationId: org.id,
          userId: user.id,
          role: u.role,
          technicianLicense: u.role === "technician" ? "MP-DEMO-0001" : null,
        })
        .execute();
    }

    for (let i = 0; i < 50; i++) {
      const first = r.pick(FIRST);
      const last = r.pick(LAST);
      const place = r.pick(PLACES);
      const street = `${100 + r.int(9800)} ${r.pick(STREETS)}`;
      const customer = await trx
        .insertInto("customers")
        .values({
          organizationId: org.id,
          displayName: `${first} ${last}`,
          billingLine1: street,
          billingLine2: null,
          billingCity: place.city,
          billingState: "TX",
          billingPostalCode: place.zip,
          source: "seed",
          notes: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("contacts")
        .values({
          organizationId: org.id,
          customerId: customer.id,
          siteId: null,
          name: `${first} ${last}`,
          email: `${first}.${last}${i}@example.com`.toLowerCase(),
          phone: `(512) 555-${String(1000 + i * 7).slice(-4)}`,
          type: "primary",
          consentEmail: true,
          consentSms: r.next() < 0.6,
        })
        .execute();

      // Every 10th customer owns a second property.
      const siteCount = i % 10 === 9 ? 2 : 1;
      for (let s = 0; s < siteCount; s++) {
        const sitePlace = s === 0 ? place : r.pick(PLACES);
        const flags: string[] = [];
        if (r.next() < 0.25) flags.push("dog");
        if (r.next() < 0.15) flags.push("locked_gate");
        if (r.next() < 0.1) flags.push("call_ahead");
        const site = await trx
          .insertInto("sites")
          .values({
            organizationId: org.id,
            customerId: customer.id,
            addressLine1: s === 0 ? street : `${100 + r.int(9800)} ${r.pick(STREETS)}`,
            addressLine2: null,
            city: sitePlace.city,
            postalCode: sitePlace.zip,
            county: sitePlace.county,
            lat: Number((sitePlace.lat + (r.next() - 0.5) * 0.1).toFixed(6)),
            lng: Number((sitePlace.lng + (r.next() - 0.5) * 0.1).toFixed(6)),
            permitNumber: `DEMO-${String(10000 + i * 3 + s).padStart(6, "0")}`,
            accessNotes: flags.includes("locked_gate") ? "Gate on the east side of the property." : null,
            gateCode: flags.includes("locked_gate") ? String(1000 + r.int(9000)) : null,
            safetyFlags: flags,
            schedulingNotes: flags.includes("call_ahead") ? "Call 30 minutes before arrival." : null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();

        const maker = r.pick(MAKERS);
        await trx
          .insertInto("wastewaterSystems")
          .values({
            organizationId: org.id,
            siteId: site.id,
            manufacturer: maker.manufacturer,
            model: r.pick(maker.models),
            serial: `SN${100000 + r.int(900000)}`,
            installedAt: `${2008 + r.int(16)}-0${1 + r.int(9)}-1${r.int(9)}`,
            systemType: "aerobic",
            treatmentType: "aerobic treatment unit",
            disposalType: r.pick(DISPOSAL),
            chlorinationMethod: r.pick(CHLORINE),
            notes: null,
          })
          .execute();
      }
    }
    log(`seeded ${DEMO_ORG_NAME} (${org.id})`);
  });

  log(`log in as ${DEMO_USERS.map((u) => u.email).join(", ")} with password "${DEMO_PASSWORD}"`);
}
