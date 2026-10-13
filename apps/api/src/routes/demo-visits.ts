import type { Feature } from "@aerowise/domain";
import { createHmac, randomBytes } from "node:crypto";
import { seedDemoCompany, type Database } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { sql } from "kysely";
import { createPortalLink } from "@aerowise/tasks";
import { createSession, SESSION_COOKIE } from "../auth/sessions.ts";
import { playDemoStory } from "../demo-story.ts";
import { organizationToday } from "../lib/today.ts";
import { HttpError } from "../lib/errors.ts";
import { emptyEndedDemos } from "../lib/demo-lifecycle.ts";

// The public demo (W10.2). On the demo deployment, "Try the demo" gives each visitor a demo
// company of their own: the seeded data with the five-minute story played, signed in as its
// owner, with no password anyone could share. It ends after a day, and the nightly reset
// empties everything anyway. Its people can only ever be signed in by these routes.
//
// Abuse limits: a few starts per visitor (their IP address, kept only as a keyed hash) per
// hour, and a cap on how many visitor demos exist at once. Everything a demo company does
// already stays on the stand-ins (W10.1), so the limits protect the server, not the world.

export const DEMO_VISIT_HOURS = 24;
export const DEMO_STARTS_PER_HOUR = 3;
export const DEMO_MAX_LIVE = 50;

const ROLES = ["owner", "office", "technician"] as const;
const PEOPLE = [
  { name: "Olivia Owner", role: "owner" },
  { name: "Oscar Office", role: "office" },
  { name: "Tess Tech", role: "technician" },
] as const;

export const demoVisitRoutes: FastifyPluginAsyncZod<{
  db: Database;
  store: ObjectStore;
  now: () => Date;
  /** Only the demo deployment offers visitor demos. */
  enabled: boolean;
  production: boolean;
  /** Keys the visitor's IP hash, so the stored value cannot be reversed by trying addresses. */
  hashKey: string;
  limits?: { perHour?: number; maxLive?: number };
  /** The deployment's switched-on features, which the demo story follows. */
  features: ReadonlySet<Feature>;
}> = async (app, { db, store, now, enabled, production, hashKey, limits = {}, features }) => {
  const perHour = limits.perHour ?? DEMO_STARTS_PER_HOUR;
  const maxLive = limits.maxLive ?? DEMO_MAX_LIVE;
  const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: production };

  app.post(
    "/demo/start",
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["demo"],
        summary: "Start a demo company of your own, signed in as its owner (demo deployment only)",
        response: { 200: z.object({ organizationId: z.uuid(), expiresAt: z.iso.datetime() }) },
      },
    },
    async (req, reply) => {
      if (!enabled) throw new HttpError(404, "not_found", "Not found");
      const requesterHash = createHmac("sha256", hashKey).update(`demo-visit:${req.ip}`).digest("hex");
      const hourAgo = new Date(now().getTime() - 3600_000);
      // Only the last hour counts, so older hashes are not kept.
      await db.deleteFrom("demoVisits").where("createdAt", "<=", hourAgo).execute();
      const recent = await db.selectFrom("demoVisits").select((eb) => eb.fn.countAll<string>().as("n")).where("requesterHash", "=", requesterHash).where("createdAt", ">", hourAgo).executeTakeFirstOrThrow();
      if (Number(recent.n) >= perHour) throw new HttpError(429, "demo_limit", "You have started several demos in the last hour. Use the one you have, or try again later.");

      await emptyEndedDemos(db, store, now());
      const live = await db
        .selectFrom("organizations")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("demoExpiresAt", ">", now())
        .where("demoProspect", "is", null)
        .executeTakeFirstOrThrow();
      if (Number(live.n) >= maxLive) throw new HttpError(503, "demo_busy", "The demo is busy right now. Please try again in a few minutes.");

      await db.insertInto("demoVisits").values({ requesterHash, createdAt: now() }).execute();
      const tag = randomBytes(5).toString("hex");
      const expiresAt = new Date(now().getTime() + DEMO_VISIT_HOURS * 3600_000);
      const organizationId = await seedDemoCompany(db, {
        name: "Hill Country Aerobic Services (your demo)",
        users: PEOPLE.map((p) => ({ ...p, email: `${p.role}.${tag}@demo.example.com` })),
        password: null,
        expiresAt,
      });
      await playDemoStory({ db, store, organizationId, now, features });

      const owner = await memberOf(organizationId, "owner");
      const session = await createSession(db, organizationId, owner, expiresAt);
      reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: expiresAt });
      req.log.info({ organizationId }, "visitor demo started");
      return { organizationId, expiresAt: expiresAt.toISOString() };
    },
  );

  app.post(
    "/demo/switch",
    {
      config: { permission: "self:read", allowedWhenReadOnly: true },
      schema: {
        tags: ["demo"],
        summary: "In your own demo company, look around as its owner, office manager or technician",
        body: z.object({ role: z.enum(ROLES) }),
        response: { 200: z.object({ role: z.enum(ROLES) }) },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      // Expiring private visitor/prospect demos only; never the permanent shared company or a real company.
      const org = await db.selectFrom("organizations").select(["demoExpiresAt", "demoProspect"]).where("id", "=", organizationId).where("demo", "=", true).executeTakeFirst();
      if (!org?.demoExpiresAt || org.demoExpiresAt <= now()) throw new HttpError(403, "not_a_visitor_demo", "Switching people is only for your own demo company");
      const userId = await memberOf(organizationId, req.body.role);
      const session = await createSession(db, organizationId, userId, org.demoExpiresAt);
      reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: org.demoExpiresAt });
      return { role: req.body.role };
    },
  );

  async function visitor(organizationId: string) {
    const org = await db.selectFrom("organizations").select(["demo", "demoExpiresAt", "demoProspect"]).where("id", "=", organizationId).executeTakeFirst();
    if (!org?.demo || !org.demoExpiresAt || org.demoExpiresAt <= now()) throw new HttpError(403, "not_a_visitor_demo", "This walkthrough belongs to your active private visitor demo. Start a new demo if yours has expired.");
    return org;
  }

  app.get("/demo/journey", { config: { permission: "self:read", allowedWhenReadOnly: true }, schema: { tags: ["demo"], summary: "Actual records for the private visitor walkthrough" } }, async (req) => {
    const { organizationId, role } = req.requireAuth();
    const org = await visitor(organizationId);
    // Prefer yesterday's unpaid case: completed result, office evidence and a real test invoice together.
    const caseRecord = await db.selectFrom("filings as f").innerJoin("sites as s", (j) => j.onRef("s.id", "=", "f.siteId").onRef("s.organizationId", "=", "f.organizationId")).innerJoin("customers as c", (j) => j.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId")).innerJoin("inspections as i", (j) => j.onRef("i.id", "=", "f.inspectionId").onRef("i.organizationId", "=", "f.organizationId")).select(["f.id as filingId", "f.siteId", "c.id as customerId", "c.displayName as customerName", "s.addressLine1", "s.city", "i.id as inspectionId", "i.completedAt", "f.status", "f.submissionMethod"]).where("f.organizationId", "=", organizationId).where("f.kind", "=", "inspection_report").orderBy(sql`exists(select 1 from invoices inv where inv.organization_id = f.organization_id and inv.customer_id = c.id and inv.status = 'open' and inv.payment_status = 'unpaid')`, "desc").orderBy("i.completedAt", "desc").orderBy("c.id", "desc").executeTakeFirst();
    if (!caseRecord) throw new HttpError(409, "demo_records_changed", "The example report is no longer available. Explore your records or start a new private demo.");
    const [obligation, invoice, work, renewal] = await Promise.all([
      db.selectFrom("serviceObligations").select(["id", "dueOn"]).where("organizationId", "=", organizationId).where("siteId", "=", caseRecord.siteId).where("status", "=", "open").orderBy("dueOn").executeTakeFirst(),
      db.selectFrom("invoices").select(["id", "paymentStatus"]).where("organizationId", "=", organizationId).where("customerId", "=", caseRecord.customerId).where("status", "=", "open").orderBy("createdAt", "desc").executeTakeFirst(),
      db.selectFrom("workOrders").select(["id", "title", "status"]).where("organizationId", "=", organizationId).where("siteId", "=", caseRecord.siteId).orderBy("createdAt", "desc").executeTakeFirst(),
      db.selectFrom("renewals").select(["id", "customerId", "status"]).where("organizationId", "=", organizationId).orderBy("createdAt", "desc").executeTakeFirst(),
    ]);
    const today = await organizationToday(db, organizationId, now());
    const technicianId = await memberOf(organizationId, "technician");
    const job = await db.selectFrom("jobs").select(["id", "scheduledDate"]).where("organizationId", "=", organizationId).where("siteId", "=", caseRecord.siteId).where("technicianUserId", "=", technicianId).where("scheduledDate", "=", today).where("status", "in", ["scheduled", "in_progress"]).orderBy("createdAt").executeTakeFirst();
    return { expiresAt: org.demoExpiresAt!.toISOString(), role, case: { ...caseRecord, completedAt: caseRecord.completedAt?.toISOString() ?? null }, obligation: obligation ?? null, job: job ?? null, invoice: invoice ?? null, work: work ?? null, renewal: renewal ?? null };
  });

  app.post("/demo/homeowner", { config: { permission: "self:read", allowedWhenReadOnly: true }, schema: { tags: ["demo"], summary: "Open the fictional homeowner's populated portal", body: z.object({ customerId: z.uuid() }) } }, async (req) => {
    const { organizationId, userId } = req.requireAuth();
    const org = await visitor(organizationId);
    const customer = await db.selectFrom("customers").select("id").where("organizationId", "=", organizationId).where("id", "=", req.body.customerId).executeTakeFirst();
    if (!customer) throw new HttpError(404, "not_found", "Demo customer not found");
    const link = await db.transaction().execute(async (trx) => {
      const made = await createPortalLink(trx, { organizationId, customerId: customer.id, source: "office", sentTo: null, createdBy: userId, now: now() });
      await trx.updateTable("portalLinks").set({ expiresAt: org.demoExpiresAt! }).where("organizationId", "=", organizationId).where("id", "=", made.id).execute();
      return made;
    });
    return { href: `/portal/${link.token}`, expiresAt: org.demoExpiresAt!.toISOString() };
  });

  async function memberOf(organizationId: string, role: (typeof ROLES)[number]) {
    const m = await db.selectFrom("memberships").select("userId").where("organizationId", "=", organizationId).where("role", "=", role).where("active", "=", true).orderBy("createdAt").orderBy("userId").executeTakeFirstOrThrow();
    return m.userId;
  }
};
