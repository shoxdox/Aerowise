import { rulesetCoverage } from "@aerowise/compliance";
import { verifyPassword, type Database } from "@aerowise/db";
import type { ObjectStore } from "@aerowise/storage";
import {
  adminOrganization,
  adminOrganizationInput,
  canChangePlan,
  dateInZone,
  daysLeft,
  initialPlan,
  invitationSent,
  organizationErasure,
  organizationErasureInput,
  ownerInvitationInput,
  platformAdminMe,
  rulesetCoverage as rulesetCoverageSchema,
  SUBSCRIPTION_STATE_LABELS,
  subscriptionDefaults,
  platformFeeInput,
  subscriptionPlanInput,
  type SubscriptionConfig,
  type SubscriptionPlan,
} from "@aerowise/domain";
import { sql } from "kysely";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ADMIN_SESSION_COOKIE, createAdminSession, findAdminSession, revokeAdminSession } from "../auth/admin-sessions.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { createInvitation, emailInvitation, inviteUrlFor, listInvitations, type InvitationMail } from "../lib/invitations.ts";
import { eraseOrganization } from "../lib/org-erase.ts";
import { platformAudit } from "../lib/platform-audit.ts";

// Same shape as a real hash so an unknown email costs the same time as a wrong password.
const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * The platform-admin console API. Every route except sign-in and sign-out is
 * `config.platformAdmin`, and every action writes a platform audit event.
 */
export const adminRoutes: FastifyPluginAsyncZod<{
  db: Database;
  production: boolean;
  loginRateLimit: number;
  now: () => Date;
  invitations: InvitationMail;
  subscription: SubscriptionConfig;
  store: ObjectStore;
}> = async (app, { db, production, loginRateLimit, now, invitations, subscription, store }) => {
  const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: production };

  const planColumns = [
    "o.subscriptionState",
    "o.subscriptionStartsOn",
    "o.subscriptionEndsOn",
    "o.pricePerContractCentsOverride",
    "o.monthlyMinimumCentsOverride",
  ] as const;

  function planOf(row: {
    timezone: string;
    subscriptionState: SubscriptionPlan["state"];
    subscriptionStartsOn: string;
    subscriptionEndsOn: string | null;
    pricePerContractCentsOverride: number | null;
    monthlyMinimumCentsOverride: number | null;
  }) {
    const plan: SubscriptionPlan = {
      state: row.subscriptionState,
      startsOn: row.subscriptionStartsOn,
      endsOn: row.subscriptionEndsOn,
      pricePerContractCentsOverride: row.pricePerContractCentsOverride,
      monthlyMinimumCentsOverride: row.monthlyMinimumCentsOverride,
    };
    return { plan, daysLeft: daysLeft(plan, dateInZone(now(), row.timezone)) };
  }

  /** Organizations with usage and plan, for the list or for one organization after a change. */
  async function loadOrganizations(id?: string) {
    const at = now();
    let query = db
      .selectFrom("organizations as o")
      .select([
        "o.id",
        "o.name",
        "o.timezone",
        "o.createdAt",
        "o.platformFeeBps",
        "o.dataDeletedAt",
        ...planColumns,
        // In force today in the organization's own time zone; cancelled contracts never count.
        sql<number>`(select count(*)::int from contracts c
          where c.organization_id = o.id and c.status = 'active'
            and (${at}::timestamptz at time zone o.timezone)::date between c.start_on and c.end_on)`.as("activeContracts"),
        sql<number>`(select count(*)::int from memberships m join users u on u.id = m.user_id
          where m.organization_id = o.id and m.active and u.active)`.as("users"),
        sql<Date | null>`greatest(
          (select max(a.occurred_at) from audit_events a where a.organization_id = o.id),
          (select max(s.created_at) from sessions s where s.organization_id = o.id))`.as("lastActivityAt"),
      ])
      .orderBy("o.name");
    if (id) query = query.where("o.id", "=", id);
    const rows = await query.execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      timezone: r.timezone,
      createdAt: r.createdAt.toISOString(),
      activeContracts: r.activeContracts,
      users: r.users,
      lastActivityAt: r.lastActivityAt ? new Date(r.lastActivityAt).toISOString() : null,
      platformFeeBps: r.platformFeeBps,
      dataDeletedAt: r.dataDeletedAt ? r.dataDeletedAt.toISOString() : null,
      ...planOf(r),
    }));
  }

  async function loadAdmin(adminId: string) {
    return db.selectFrom("platformAdmins").select(["id", "name", "email"]).where("id", "=", adminId).executeTakeFirstOrThrow();
  }

  app.post(
    "/admin/auth/login",
    {
      config: {
        public: true,
        rateLimit: {
          max: loginRateLimit,
          timeWindow: "1 minute",
          // After the body is parsed: the key includes the email, which onRequest cannot see.
          hook: "preHandler",
          keyGenerator: (req) => `admin:${req.ip}:${String((req.body as { email?: unknown } | undefined)?.email ?? "").toLowerCase()}`,
        },
      },
      schema: {
        tags: ["admin"],
        summary: "Platform admin sign-in",
        body: z.object({ email: z.string().trim().max(320), password: z.string().max(200) }),
        response: { 200: platformAdminMe },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const admin = await db
        .selectFrom("platformAdmins")
        .select(["id", "passwordHash", "active"])
        .where((eb) => eb(eb.fn("lower", ["email"]), "=", email.toLowerCase()))
        .executeTakeFirst();
      const valid = await verifyPassword(password, admin?.passwordHash ?? DUMMY_HASH);
      if (!admin || !admin.active || !valid) throw new HttpError(401, "invalid_credentials", "Email or password is incorrect");

      const session = await createAdminSession(db, admin.id);
      await platformAudit(db, req, { adminId: admin.id, action: "admin.signed_in", entityType: "platform_admin", entityId: admin.id });
      reply.setCookie(ADMIN_SESSION_COOKIE, session.token, { ...cookieOptions, expires: session.expiresAt });
      return loadAdmin(admin.id);
    },
  );

  app.post(
    "/admin/auth/logout",
    { config: { public: true }, schema: { tags: ["admin"], summary: "Platform admin sign-out", response: { 204: z.null() } } },
    async (req, reply) => {
      const token = req.cookies[ADMIN_SESSION_COOKIE];
      const session = token ? await findAdminSession(db, token) : null;
      if (session) {
        await revokeAdminSession(db, session.sessionId);
        await platformAudit(db, req, { adminId: session.adminId, action: "admin.signed_out", entityType: "platform_admin", entityId: session.adminId });
      }
      reply.clearCookie(ADMIN_SESSION_COOKIE, cookieOptions);
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/admin/auth/me",
    { config: { platformAdmin: true }, schema: { tags: ["admin"], summary: "Signed-in platform admin", response: { 200: platformAdminMe } } },
    async (req) => loadAdmin(req.requireAdmin().adminId),
  );


  app.get(
    "/admin/rulesets",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Every reporting authority: how far its rules are checked, what is open, and how many sites use it",
        response: { 200: rulesetCoverageSchema },
      },
    },
    async () => rulesetCoverage(db, now().toISOString().slice(0, 10)),
  );

  app.get(
    "/admin/organizations",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Every organization with its usage and plan",
        response: { 200: z.object({ items: z.array(adminOrganization), defaults: subscriptionDefaults }) },
      },
    },
    async () => ({ items: await loadOrganizations(), defaults: subscription }),
  );

  app.post(
    "/admin/organizations",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Create an organization",
        body: adminOrganizationInput,
        response: { 201: adminOrganization },
      },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      const { plan: kind, ...input } = req.body;
      const plan = initialPlan(kind, dateInZone(now(), input.timezone), subscription);
      const org = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("organizations")
          .values({
            name: input.name,
            timezone: input.timezone,
            email: input.email ?? null,
            phone: input.phone ?? null,
            addressLine1: null,
            addressLine2: null,
            city: null,
            state: null,
            postalCode: null,
            logoUrl: null,
            subscriptionState: plan.state,
            subscriptionStartsOn: plan.startsOn,
            subscriptionEndsOn: plan.endsOn,
          })
          .returning(["id"])
          .executeTakeFirstOrThrow();
        await platformAudit(trx, req, {
          adminId,
          action: "organization.created",
          entityType: "organization",
          entityId: created.id,
          organizationId: created.id,
          changes: { ...input, plan },
        });
        return created;
      });
      const [created] = await loadOrganizations(org.id);
      return reply.status(201).send(created!);
    },
  );

  app.put(
    "/admin/organizations/:id/plan",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Set an organization's plan state, dates and founder price",
        params: z.object({ id: z.uuid() }),
        body: subscriptionPlanInput,
        response: { 200: adminOrganization },
      },
    },
    async (req) => {
      const { adminId } = req.requireAdmin();
      const next = req.body;
      await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom("organizations as o")
          .select(["o.id", "o.timezone", "o.dataDeletedAt", ...planColumns])
          .where("o.id", "=", req.params.id)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw notFound("Organization");
        if (current.dataDeletedAt) throw new HttpError(409, "organization_deleted", "This organization's data has been deleted");
        const before = planOf(current).plan;
        if (!canChangePlan(before.state, next.state)) {
          throw unprocessable(`A plan cannot go from ${SUBSCRIPTION_STATE_LABELS[before.state]} to ${SUBSCRIPTION_STATE_LABELS[next.state]}`);
        }
        await trx
          .updateTable("organizations")
          .set({
            subscriptionState: next.state,
            subscriptionStartsOn: next.startsOn,
            subscriptionEndsOn: next.endsOn,
            pricePerContractCentsOverride: next.pricePerContractCentsOverride,
            monthlyMinimumCentsOverride: next.monthlyMinimumCentsOverride,
          })
          .where("id", "=", current.id)
          .execute();
        await platformAudit(trx, req, {
          adminId,
          action: "organization.plan_changed",
          entityType: "organization",
          entityId: current.id,
          organizationId: current.id,
          changes: { before, after: next },
        });
      });
      const [updated] = await loadOrganizations(req.params.id);
      return updated!;
    },
  );

  app.put(
    "/admin/organizations/:id/platform-fee",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Set Aerowise's fee on an organization's homeowner payments",
        description: "A Stripe Connect application fee in basis points (100 = 1%), taken from each card or bank payment opened from now on. 0 means no fee.",
        params: z.object({ id: z.uuid() }),
        body: platformFeeInput,
        response: { 200: adminOrganization },
      },
    },
    async (req) => {
      const { adminId } = req.requireAdmin();
      await db.transaction().execute(async (trx) => {
        const current = await trx.selectFrom("organizations").select(["id", "platformFeeBps"]).where("id", "=", req.params.id).forUpdate().executeTakeFirst();
        if (!current) throw notFound("Organization");
        if (current.platformFeeBps === req.body.platformFeeBps) return;
        await trx.updateTable("organizations").set({ platformFeeBps: req.body.platformFeeBps }).where("id", "=", current.id).execute();
        await platformAudit(trx, req, {
          adminId,
          action: "organization.platform_fee_changed",
          entityType: "organization",
          entityId: current.id,
          organizationId: current.id,
          changes: { before: current.platformFeeBps, after: req.body.platformFeeBps },
        });
      });
      const [updated] = await loadOrganizations(req.params.id);
      return updated!;
    },
  );

  app.post(
    "/admin/organizations/:id/invitations",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Invite an organization's owner",
        description: "Emails a single-use owner invitation and returns the link once.",
        params: z.object({ id: z.uuid() }),
        body: ownerInvitationInput,
        response: { 201: invitationSent },
      },
    },
    async (req, reply) => {
      const { adminId } = req.requireAdmin();
      const organizationId = req.params.id;
      const org = await db.selectFrom("organizations").select(["id", "dataDeletedAt"]).where("id", "=", organizationId).executeTakeFirst();
      if (!org) throw notFound("Organization");
      if (org.dataDeletedAt) throw new HttpError(409, "organization_deleted", "This organization's data has been deleted");
      const at = now();
      const created = await db.transaction().execute(async (trx) => {
        const inv = await createInvitation(trx, { organizationId, email: req.body.email, name: req.body.name ?? null, role: "owner", by: { adminId }, now: at });
        await platformAudit(trx, req, {
          adminId,
          action: "invitation.sent",
          entityType: "invitation",
          entityId: inv.id,
          organizationId,
          changes: { email: req.body.email, role: "owner" },
        });
        return inv;
      });
      const emailed = await emailInvitation(db, invitations, req.log, { organizationId, invitationId: created.id, token: created.token, inviterName: "The Aerowise team" });
      const [invitation] = await listInvitations(db, organizationId, at, [created.id]);
      return reply.status(201).send({ invitation: invitation!, url: inviteUrlFor(invitations.appUrl, created.token), emailed });
    },
  );

  app.post(
    "/admin/organizations/:id/erase",
    {
      config: { platformAdmin: true },
      schema: {
        tags: ["admin"],
        summary: "Delete all of an organization's data, on its request",
        description:
          "Deletes every record and stored file of the organization and signs its people out. The organization row stays, emptied, so the platform audit log keeps naming it. Cannot be undone.",
        params: z.object({ id: z.uuid() }),
        body: organizationErasureInput,
        response: { 200: organizationErasure },
      },
    },
    async (req) => {
      const { adminId } = req.requireAdmin();
      const organizationId = req.params.id;
      const result = await db.transaction().execute(async (trx) => {
        const org = await trx.selectFrom("organizations").select(["id", "name", "dataDeletedAt"]).where("id", "=", organizationId).forUpdate().executeTakeFirst();
        if (!org) throw notFound("Organization");
        if (org.dataDeletedAt) throw new HttpError(409, "organization_deleted", "This organization's data has already been deleted");
        if (req.body.confirmName !== org.name.trim()) throw unprocessable("Type the organization's name exactly to confirm");
        const erased = await eraseOrganization(trx, organizationId);
        // Read-only stops billing and keeps anyone from adding data again.
        await trx
          .updateTable("organizations")
          .set({ dataDeletedAt: now(), dataDeletedBy: adminId, subscriptionState: "read_only", subscriptionEndsOn: null })
          .where("id", "=", organizationId)
          .execute();
        await platformAudit(trx, req, {
          adminId,
          action: "organization.data_deleted",
          entityType: "organization",
          entityId: organizationId,
          organizationId,
          changes: { name: org.name, ...erased },
        });
        return erased;
      });

      // Files go after the records are gone for good: a failure here leaves files nobody
      // can reach, which the audit log records so they can be removed by hand.
      let files: number | null = null;
      try {
        files = store.deleteOrganization ? await store.deleteOrganization(organizationId) : null;
        await platformAudit(db, req, { adminId, action: "organization.files_deleted", entityType: "organization", entityId: organizationId, organizationId, changes: { files } });
      } catch (err) {
        req.log.error({ err, organizationId }, "deleting an organization's files failed");
        await platformAudit(db, req, {
          adminId,
          action: "organization.files_delete_failed",
          entityType: "organization",
          entityId: organizationId,
          organizationId,
          changes: { error: err instanceof Error ? err.message : String(err) },
        });
      }
      const [organization] = await loadOrganizations(organizationId);
      return { organization: organization!, ...result, files };
    },
  );
};
