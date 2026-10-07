import { createHash, randomBytes } from "node:crypto";
import { seedDemoCompany, type Database } from "@aerowise/db";
import { dateInZone, initialPlan, type Feature, type SubscriptionConfig } from "@aerowise/domain";
import type { ObjectStore } from "@aerowise/storage";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { createSession, SESSION_COOKIE } from "../auth/sessions.ts";
import { playDemoStory } from "../demo-story.ts";
import { emptyEndedDemo, emptyEndedDemos } from "../lib/demo-lifecycle.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { platformAudit } from "../lib/platform-audit.ts";

// Personalized prospect demos (W10.6). From /admin, a demo company made for one prospect: the
// seeded fictional data and the five-minute story, under the prospect's name and with their
// counties as its service area, ending on a set day. The admin copies a sign-in link and sends
// it themselves; Aerowise sends nothing. Every step lands in the platform audit log. Turning it
// into a trial makes a new, real company with nothing from the demo in it, and ends the demo:
// a demo company can never become a real one (W10.1).

export const PROSPECT_DEMO_DAYS = 14;
export const PROSPECT_DEMO_MAX_DAYS = 30;

const PEOPLE = [
  { name: "Olivia Owner", role: "owner" },
  { name: "Oscar Office", role: "office" },
  { name: "Tess Tech", role: "technician" },
] as const;

const hashLink = (token: string) => createHash("sha256").update(`demo-link:${token}`).digest("hex");
const counties = z.array(z.string().trim().min(1).max(80)).min(1).max(20);

const prospectDemo = z.object({
  id: z.uuid(),
  prospect: z.string(),
  name: z.string(),
  serviceCounties: z.array(z.string()),
  createdAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  /** live: the prospect can sign in; ended: past its end or ended by hand, and emptied. */
  state: z.enum(["live", "ended"]),
  activeLinks: z.number().int(),
});
const linkIssued = z.object({ url: z.string(), expiresAt: z.iso.datetime() });

export const adminDemoRoutes: FastifyPluginAsyncZod<{
  db: Database;
  store: ObjectStore;
  now: () => Date;
  production: boolean;
  appUrl: string;
  subscription: SubscriptionConfig;
  /** The deployment's switched-on features, which the demo story follows. */
  features: ReadonlySet<Feature>;
}> = async (app, { db, store, now, production, appUrl, subscription, features }) => {
  const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: production };

  async function load(id?: string) {
    let q = db
      .selectFrom("organizations as o")
      .select((eb) => [
        "o.id",
        "o.demoProspect",
        "o.name",
        "o.serviceCounties",
        "o.createdAt",
        "o.demoExpiresAt",
        eb.exists(eb.selectFrom("memberships as m").select("m.userId").whereRef("m.organizationId", "=", "o.id")).as("hasMembers"),
        eb
          .selectFrom("demoAccessLinks as l")
          .select((x) => x.fn.countAll<string>().as("n"))
          .whereRef("l.organizationId", "=", "o.id")
          .where("l.revokedAt", "is", null)
          .where("l.expiresAt", ">", now())
          .as("activeLinks"),
      ])
      .where("o.demo", "=", true)
      .where("o.demoProspect", "is not", null)
      .orderBy("o.createdAt", "desc");
    if (id) q = q.where("o.id", "=", id);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: r.id,
      prospect: r.demoProspect!,
      name: r.name,
      serviceCounties: r.serviceCounties,
      createdAt: r.createdAt.toISOString(),
      endsAt: r.demoExpiresAt!.toISOString(),
      state: r.hasMembers && r.demoExpiresAt! > now() ? ("live" as const) : ("ended" as const),
      activeLinks: Number(r.activeLinks ?? 0),
    }));
  }

  async function issueLink(organizationId: string, adminId: string, endsAt: Date) {
    const token = randomBytes(32).toString("base64url");
    const link = await db
      .insertInto("demoAccessLinks")
      .values({ organizationId, tokenHash: hashLink(token), expiresAt: endsAt, createdBy: adminId, revokedAt: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    // In the fragment, so the token stays out of server and proxy logs.
    return { id: link.id, url: `${appUrl.replace(/\/$/, "")}/demo/enter#${token}`, expiresAt: endsAt.toISOString() };
  }

  async function live(id: string) {
    const [demo] = await load(id);
    if (!demo) throw notFound("Prospect demo");
    if (demo.state !== "live") throw new HttpError(409, "demo_ended", "This prospect demo has ended");
    return demo;
  }

  app.get(
    "/admin/prospect-demos",
    {
      config: { platformAdmin: true },
      schema: { tags: ["admin"], summary: "Prospect demos, live and ended", response: { 200: z.object({ items: z.array(prospectDemo) }) } },
    },
    async () => {
      await emptyEndedDemos(db, store, now());
      return { items: await load() };
    },
  );

  app.post(
    "/admin/prospect-demos",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Make a demo company for one prospect, and a sign-in link to send them yourself",
        description: "Fictional data only, under the prospect's name and counties. Nothing is emailed or texted.",
        body: z.object({
          prospect: z.string().trim().min(1).max(120),
          serviceCounties: counties,
          days: z.number().int().min(1).max(PROSPECT_DEMO_MAX_DAYS).default(PROSPECT_DEMO_DAYS),
        }),
        response: { 201: z.object({ demo: prospectDemo, link: linkIssued }) },
      },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      const { prospect, serviceCounties, days } = req.body;
      const endsAt = new Date(now().getTime() + days * 86_400_000);
      const tag = randomBytes(5).toString("hex");
      const organizationId = await seedDemoCompany(db, {
        name: `${prospect} (demo)`,
        users: PEOPLE.map((p) => ({ ...p, email: `${p.role}.${tag}@demo.example.com` })),
        password: null,
        expiresAt: endsAt,
        prospect: { name: prospect, serviceCounties },
      });
      await playDemoStory({ db, store, organizationId, now, features });
      const link = await issueLink(organizationId, adminId, endsAt);
      await platformAudit(db, req, {
        adminId,
        action: "prospect_demo.created",
        entityType: "organization",
        entityId: organizationId,
        organizationId,
        changes: { prospect, serviceCounties, endsAt: endsAt.toISOString(), linkId: link.id },
      });
      const [demo] = await load(organizationId);
      return reply.status(201).send({ demo: demo!, link: { url: link.url, expiresAt: link.expiresAt } });
    },
  );

  app.post(
    "/admin/prospect-demos/:id/links",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "A new sign-in link for a prospect demo (earlier links are revoked)",
        params: z.object({ id: z.uuid() }),
        response: { 201: linkIssued },
      },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      const demo = await live(req.params.id);
      await db.updateTable("demoAccessLinks").set({ revokedAt: now() }).where("organizationId", "=", demo.id).where("revokedAt", "is", null).execute();
      const link = await issueLink(demo.id, adminId, new Date(demo.endsAt));
      await platformAudit(db, req, { adminId, action: "prospect_demo.link_issued", entityType: "organization", entityId: demo.id, organizationId: demo.id, changes: { linkId: link.id } });
      return reply.status(201).send({ url: link.url, expiresAt: link.expiresAt });
    },
  );

  app.post(
    "/admin/prospect-demos/:id/end",
    {
      config: { platformAdmin: true },
      schema: { tags: ["admin"], summary: "End a prospect demo now and empty it", params: z.object({ id: z.uuid() }), response: { 200: prospectDemo } },
    },
    async (req) => {
      const { adminId } = req.requireAdmin();
      const demo = await live(req.params.id);
      await endDemo(demo.id);
      await platformAudit(db, req, { adminId, action: "prospect_demo.ended", entityType: "organization", entityId: demo.id, organizationId: demo.id, changes: { reason: "ended_by_admin" } });
      const [ended] = await load(demo.id);
      return ended!;
    },
  );

  app.post(
    "/admin/prospect-demos/:id/convert",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Start the prospect's real trial company, and end their demo",
        description:
          "Makes a new, real company on a trial with the prospect's name and counties and nothing from the demo in it, then ends and empties the demo. Invite the owner from the organization as usual; nothing is sent here.",
        params: z.object({ id: z.uuid() }),
        body: z.object({ timezone: z.string().trim().default("America/Chicago") }),
        response: { 201: z.object({ organizationId: z.uuid() }) },
      },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      const demo = await live(req.params.id);
      const plan = initialPlan("trial", dateInZone(now(), req.body.timezone), subscription);
      const created = await db.transaction().execute(async (trx) => {
        const org = await trx
          .insertInto("organizations")
          .values({
            name: demo.prospect,
            timezone: req.body.timezone,
            email: null,
            phone: null,
            addressLine1: null,
            addressLine2: null,
            city: null,
            state: null,
            postalCode: null,
            logoUrl: null,
            serviceCounties: demo.serviceCounties,
            subscriptionState: plan.state,
            subscriptionStartsOn: plan.startsOn,
            subscriptionEndsOn: plan.endsOn,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await platformAudit(trx, req, { adminId, action: "organization.created", entityType: "organization", entityId: org.id, organizationId: org.id, changes: { name: demo.prospect, plan, fromProspectDemo: demo.id } });
        return org;
      });
      await endDemo(demo.id);
      await platformAudit(db, req, { adminId, action: "prospect_demo.converted", entityType: "organization", entityId: demo.id, organizationId: demo.id, changes: { trialOrganizationId: created.id } });
      return reply.status(201).send({ organizationId: created.id });
    },
  );

  async function endDemo(id: string) {
    await db.updateTable("organizations").set({ demoExpiresAt: now() }).where("id", "=", id).where("demo", "=", true).execute();
    await db.updateTable("demoAccessLinks").set({ revokedAt: now() }).where("organizationId", "=", id).where("revokedAt", "is", null).execute();
    await emptyEndedDemo(db, store, id);
  }

  app.post(
    "/demo/enter",
    {
      config: { public: true, rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["demo"],
        summary: "Open a prospect demo from its sign-in link, as its owner",
        body: z.object({ token: z.string().min(20).max(200) }),
        response: { 200: z.object({ organizationId: z.uuid() }) },
      },
    },
    async (req, reply) => {
      const at = now();
      const link = await db
        .selectFrom("demoAccessLinks as l")
        .innerJoin("organizations as o", "o.id", "l.organizationId")
        .select(["l.organizationId", "l.expiresAt", "o.demoExpiresAt"])
        .where("l.tokenHash", "=", hashLink(req.body.token))
        .where("l.revokedAt", "is", null)
        .where("l.expiresAt", ">", at)
        .where("o.demo", "=", true)
        .where("o.demoProspect", "is not", null)
        .where("o.demoExpiresAt", ">", at)
        .executeTakeFirst();
      if (!link) throw new HttpError(404, "demo_link_invalid", "This demo link has ended or is not valid. Ask for a new one.");
      const owner = await db
        .selectFrom("memberships")
        .select("userId")
        .where("organizationId", "=", link.organizationId)
        .where("role", "=", "owner")
        .where("active", "=", true)
        .executeTakeFirst();
      if (!owner) throw new HttpError(404, "demo_link_invalid", "This demo link has ended or is not valid. Ask for a new one.");
      const endsAt = link.expiresAt < link.demoExpiresAt! ? link.expiresAt : link.demoExpiresAt!;
      const session = await createSession(db, link.organizationId, owner.userId, endsAt);
      reply.setCookie(SESSION_COOKIE, session.token, { ...cookieOptions, expires: endsAt });
      req.log.info({ organizationId: link.organizationId }, "prospect demo opened");
      return { organizationId: link.organizationId };
    },
  );
};
