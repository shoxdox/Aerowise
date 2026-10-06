import { addDays, addMonths, buildTermSchedule, CURRENT_LEGAL_VERSIONS, LEGAL_DOCUMENTS } from "@aerowise/domain";
import type { Database } from "./client.ts";
import { hashPassword } from "./password.ts";
import { createPlatformAdmin } from "./platform-admin.ts";

// Demo data for local development: one fictional provider, three users, ~50
// customers with sites and systems, two plans and a contract on most sites. Every
// name, address and permit number is made up.

export const DEMO_ORG_NAME = "Hill Country Aerobic Services (demo)";
export const DEMO_PASSWORD = "aerowise-dev";
export const DEMO_USERS = [
  { name: "Olivia Owner", email: "owner@example.com", role: "owner" },
  { name: "Oscar Office", email: "office@example.com", role: "office" },
  { name: "Tess Tech", email: "tech@example.com", role: "technician" },
] as const;
/** Development-only platform admin for /admin. Production admins come from the CLI. */
export const DEMO_PLATFORM_ADMIN = { name: "Pat Platform", email: "admin@example.com" } as const;

const FIRST = ["James", "Maria", "Robert", "Linda", "Carlos", "Patricia", "David", "Rosa", "Michael", "Karen", "Jose", "Susan", "Daniel", "Lupe", "Thomas", "Nancy"];
const LAST = ["Hartley", "Gonzales", "Whitfield", "Ramirez", "Calloway", "Nguyen", "Brennan", "Salinas", "Dorsey", "Medina", "Pruitt", "Castillo", "Langford", "Villarreal"];
const STREETS = ["Cedar Ridge Rd", "Live Oak Ln", "Bluebonnet Trl", "Mesquite Dr", "Old Mill Rd", "Pecan Hollow", "County Road 214", "Ranch Road 1863", "Deer Creek Dr", "Limestone Way"];
// Every site is in the fictional Example County, whose made-up rules let the demo reach a
// filing; its towns are only for the map. No site claims a real county's permit.
const PLACES = [
  { city: "Dripping Springs", county: "Example County", zip: "78620", lat: 30.19, lng: -98.09 },
  { city: "Wimberley", county: "Example County", zip: "78676", lat: 30.0, lng: -98.1 },
  { city: "Blanco", county: "Example County", zip: "78606", lat: 30.1, lng: -98.42 },
  { city: "Spicewood", county: "Example County", zip: "78669", lat: 30.47, lng: -98.16 },
];
const MAKERS = [
  { manufacturer: "Acme Aerobic", models: ["AA-500", "AA-750"] },
  { manufacturer: "ClearFlow Systems", models: ["CF-600", "CF-800"] },
  { manufacturer: "TreatRight", models: ["TR-1", "TR-2X"] },
];
const DISPOSAL = ["spray", "drip", "spray"];
// Every demo unit disinfects, so a report never says "no chlorinator" beside a working one.
const CHLORINE = ["tablet", "liquid", "tablet", "tablet"];

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

function todayInChicago(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export async function seed(db: Database, log: (msg: string) => void = () => {}) {
  await seedPlatformAdmin(db, log);
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
        // Fictional: its email, texts, filings, payments and books only ever reach the stand-ins.
        demo: true,
        phone: "(512) 555-0100",
        email: "office@example.com",
        addressLine1: "100 Example Pkwy",
        addressLine2: null,
        city: "Dripping Springs",
        state: "TX",
        postalCode: "78620",
        logoUrl: null,
        // Technicians leave from the office in the morning.
        routeStartAddress: "100 Example Pkwy, Dripping Springs, TX 78620",
        routeStartLat: 30.19,
        routeStartLng: -98.09,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    let techId = "";
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
          technicianLicense: u.role === "technician" ? "MT-DEMO-0001" : null,
        })
        .execute();
      if (u.role === "technician") techId = user.id;
      // The fictional owner has accepted the current terms, so demo and e2e sign-ins go
      // straight in. Real owners accept on their first sign-in (W8.3).
      if (u.role === "owner") {
        for (const document of LEGAL_DOCUMENTS) {
          await trx.insertInto("legalAcceptances").values({ organizationId: org.id, userId: user.id, document, version: CURRENT_LEGAL_VERSIONS[document], acceptedAt: new Date(), requestId: null }).execute();
        }
      }
    }

    const siteIds: string[] = [];
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
          // 555-0100 to 555-0199 is set aside for fiction; a demo company may hold no other number.
          phone: `(512) 555-01${String(i + 1).padStart(2, "0")}`,
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
            locationSource: "manual",
            permitNumber: `DEMO-${String(10000 + i * 3 + s).padStart(6, "0")}`,
            accessNotes: flags.includes("locked_gate") ? "Gate on the east side of the property." : null,
            gateCode: flags.includes("locked_gate") ? String(1000 + r.int(9000)) : null,
            safetyFlags: flags,
            schedulingNotes: flags.includes("call_ahead") ? "Call 30 minutes before arrival." : null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        siteIds.push(site.id);

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
    // Plans and contracts. Start dates are chosen relative to today so the demo always
    // has a week of inspections coming due, a few overdue, and a few lapsed sites.
    const plan = await trx
      .insertInto("plans")
      .values({ organizationId: org.id, name: "Residential annual", termMonths: 12, visitsPerTerm: 3, priceCents: 27500 })
      .returning(["id", "name", "termMonths", "visitsPerTerm", "priceCents"])
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("plans")
      .values({ organizationId: org.id, name: "Two-year residential", termMonths: 24, visitsPerTerm: 6, priceCents: 49500 })
      .execute();

    const today = todayInChicago();
    let contracts = 0;
    const toSchedule: { obligationId: string; siteId: string }[] = [];
    for (const [i, siteId] of siteIds.entries()) {
      let startOn: string;
      if (i < 20) {
        // First visit due within the next 7 days.
        startOn = addMonths(addDays(today, (i % 7) + 1), -4);
      } else if (i < 25) {
        // First visit overdue by 1–5 days.
        startOn = addMonths(addDays(today, -(i - 20)), -4);
      } else if (i === 25) {
        // Ends in three weeks: the demo story renews it (apps/api/src/demo-story.ts).
        startOn = addDays(addMonths(today, -12), 21);
        r.int(330);
      } else if (i < 52) {
        startOn = addDays(today, -r.int(330));
      } else {
        continue; // A few sites whose contract has lapsed.
      }
      const schedule = buildTermSchedule(startOn, plan.termMonths, plan.visitsPerTerm);
      // Visits whose due date has passed were done on time, except the deliberately overdue ones.
      const keepOverdue = i >= 20 && i < 25;
      const contract = await trx
        .insertInto("contracts")
        .values({
          organizationId: org.id,
          siteId,
          planId: plan.id,
          planName: plan.name,
          startOn,
          endOn: schedule.endOn,
          termMonths: plan.termMonths,
          visitsPerTerm: plan.visitsPerTerm,
          priceCents: plan.priceCents,
          billingFrequency: "annual",
          serviceType: "aerobic_inspection",
          autoRenew: r.next() < 0.5,
          previousContractId: null,
          cancelledAt: null,
          cancelReason: null,
          notes: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const visits = await trx
        .insertInto("serviceObligations")
        .values(
          schedule.visits.map((v) => ({
            organizationId: org.id,
            contractId: contract.id,
            siteId,
            serviceType: "aerobic_inspection" as const,
            sequence: v.sequence,
            windowStart: v.windowStart,
            windowEnd: v.windowEnd,
            dueOn: v.dueOn,
            ...(v.dueOn < today && !keepOverdue
              ? { status: "completed" as const, completedAt: new Date(`${addDays(v.dueOn, -10)}T16:00:00Z`) }
              : { completedAt: null }),
          })),
        )
        .returning(["id", "sequence"])
        .execute();
      contracts++;
      // Put the first nine visits due this week on the technician's route today and tomorrow.
      if (i < 9) toSchedule.push({ obligationId: visits.find((v) => v.sequence === 1)!.id, siteId });
    }

    for (const [i, job] of toSchedule.entries()) {
      const tomorrow = i >= 5;
      await trx
        .insertInto("jobs")
        .values({
          organizationId: org.id,
          siteId: job.siteId,
          obligationId: job.obligationId,
          scheduledDate: tomorrow ? addDays(today, 1) : today,
          technicianUserId: techId,
          routePosition: tomorrow ? i - 4 : i + 1,
          notes: null,
          cancelledAt: null,
          cancelReason: null,
        })
        .execute();
    }

    log(`seeded ${DEMO_ORG_NAME} (${org.id}) with ${siteIds.length} sites, ${contracts} contracts and ${toSchedule.length} scheduled jobs`);
  });

  log(`log in as ${DEMO_USERS.map((u) => u.email).join(", ")} with password "${DEMO_PASSWORD}"`);
}

/** Never in production: there, platform admins are created only with the CLI command. */
async function seedPlatformAdmin(db: Database, log: (msg: string) => void) {
  if (process.env.NODE_ENV === "production") {
    log("production: no platform admin seeded; use cli.ts create-platform-admin");
    return;
  }
  const existing = await db.selectFrom("platformAdmins").select("id").where("email", "=", DEMO_PLATFORM_ADMIN.email).executeTakeFirst();
  if (existing) return;
  await createPlatformAdmin(db, { ...DEMO_PLATFORM_ADMIN, password: DEMO_PASSWORD });
  log(`platform admin for /admin: ${DEMO_PLATFORM_ADMIN.email} with password "${DEMO_PASSWORD}"`);
}
