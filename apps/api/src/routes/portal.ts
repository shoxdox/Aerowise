import { customerCopy } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import {
  amountDue,
  contractState,
  dateInZone,
  id,
  invoiceNumberLabel,
  portalAccess,
  portalLink,
  portalLinkInput,
  portalLinkRequest,
  portalView,
  serviceRequest,
  serviceRequestInput,
  serviceRequestResolveInput,
  workOrderLabel,
  type PortalSite,
  type PortalView,
  type ServiceRequest,
} from "@aerowise/domain";
import { systemAudit } from "@aerowise/renewals";
import type { ObjectStore } from "@aerowise/storage";
import { billingEmail, createPortalLink, enqueue, hashPortalToken, PORTAL_LINK_EMAIL, payUrlFor, portalUrlFor, renewUrlFor, type PortalLinkEmail } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyRequest } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { readForDownload } from "../lib/demo.ts";
import { completedWorkOrders, completionSummaryPdf } from "../lib/completion.ts";

const params = z.object({ id });
const token = z.object({ token: z.string().min(20).max(64).regex(/^[A-Za-z0-9_-]+$/) });
const reportParams = token.extend({ reportId: id });
const publicLimit = { max: 30, timeWindow: "1 minute" };
// Asking for a link by email: a few a minute per client and address, and at most one
// email per customer every few minutes (below), so the form cannot be used to flood an
// inbox. Keyed by address too, so one busy network (or a proxy the API cannot see past)
// does not lock every customer out.
const requestLimit = {
  max: 5,
  timeWindow: "1 minute",
  // After the body is parsed, so the key can include the address.
  hook: "preHandler" as const,
  keyGenerator: (req: FastifyRequest) => `${req.ip}:${String((req.body as { email?: unknown } | undefined)?.email ?? "").trim().toLowerCase()}`,
};
const actionLimit = { max: 10, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => `${req.ip}:${(req.params as { token?: string }).token ?? ""}` };
const REQUEST_EMAIL_EVERY_MS = 10 * 60_000;
const notFoundLink = () => new HttpError(404, "not_found", "This link is not valid or has expired. Ask for a new one below.");

const iso = (d: Date | null) => d?.toISOString() ?? null;
const cityLine = (city: string, state: string | null, postal: string | null) => [city, [state, postal].filter(Boolean).join(" ")].filter(Boolean).join(", ");

export const portalRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; store: ObjectStore; appUrl: string }> = async (app, { db, now, store, appUrl }) => {
  /** The link a token opens, if it is still good. Every portal read goes through this. */
  async function linkFor(t: string) {
    const link = await db
      .selectFrom("portalLinks")
      .select(["id", "organizationId", "customerId", "expiresAt", "revokedAt"])
      .where("tokenHash", "=", hashPortalToken(t))
      .executeTakeFirst();
    if (!link || link.revokedAt || link.expiresAt <= now()) throw notFoundLink();
    return link;
  }

  // ---- The homeowner's side (no sign-in; the link is the key) ----

  app.post(
    "/portal/request",
    {
      config: { public: true, rateLimit: requestLimit },
      schema: {
        tags: ["portal"],
        summary: "Email a portal link to a customer",
        description: "Always answers 202, whether or not the address is on file, so the form cannot be used to find out who is a customer.",
        body: portalLinkRequest,
        response: { 202: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      const email = req.body.email.trim().toLowerCase();
      const at = now();
      const matches = await db
        .selectFrom("contacts as ct")
        .innerJoin("customers as cu", (j) => j.onRef("cu.id", "=", "ct.customerId").onRef("cu.organizationId", "=", "ct.organizationId"))
        .select(["ct.organizationId", "ct.customerId"])
        .distinct()
        .where(sql`lower(ct.email)`, "=", email)
        .where("cu.status", "<>", "inactive")
        .limit(10)
        .execute();
      const bucket = Math.floor(at.getTime() / REQUEST_EMAIL_EVERY_MS);
      for (const m of matches) {
        const payload: PortalLinkEmail = { customerId: m.customerId, to: email, source: "email", createdBy: null };
        await enqueue(db, { kind: PORTAL_LINK_EMAIL, organizationId: m.organizationId, payload: { ...payload }, dedupeKey: `portal-request-${m.customerId}-${email}-${bucket}`, runAt: at });
      }
      return reply.status(202).send({ ok: true });
    },
  );

  app.get(
    "/portal/:token",
    {
      config: { public: true, rateLimit: publicLimit },
      schema: { tags: ["portal"], summary: "Everything a customer sees from their portal link", params: token, response: { 200: portalView } },
    },
    async (req): Promise<PortalView> => {
      const link = await linkFor(req.params.token);
      const { organizationId, customerId } = link;
      const at = now();
      await db.updateTable("portalLinks").set({ lastUsedAt: at }).where("id", "=", link.id).execute();

      const [org, customer, siteRows] = await Promise.all([
        db.selectFrom("organizations").select(["name", "phone", "email", "timezone"]).where("id", "=", organizationId).executeTakeFirstOrThrow(),
        db.selectFrom("customers").select(["displayName"]).where("organizationId", "=", organizationId).where("id", "=", customerId).executeTakeFirstOrThrow(),
        db
          .selectFrom("sites")
          .select(["id", "addressLine1", "addressLine2", "city", "state", "postalCode"])
          .where("organizationId", "=", organizationId)
          .where("customerId", "=", customerId)
          .where("active", "=", true)
          .orderBy("createdAt")
          .execute(),
      ]);
      const today = dateInZone(at, org.timezone);
      const siteIds = siteRows.map((s) => s.id);
      const none = siteIds.length === 0;

      const [systems, contracts, renewals, obligations, reports, requests, invoices] = await Promise.all([
        none
          ? []
          : db
              .selectFrom("wastewaterSystems")
              .select(["siteId", "manufacturer", "model", "serial", "installedAt", "systemType", "treatmentType", "disposalType", "chlorinationMethod"])
              .where("organizationId", "=", organizationId)
              .where("siteId", "in", siteIds)
              .where("active", "=", true)
              .orderBy("createdAt")
              .execute(),
        none
          ? []
          : db
              .selectFrom("contracts as k")
              .select(["k.id", "k.siteId", "k.planName", "k.startOn", "k.endOn", "k.status", "k.visitsPerTerm"])
              .select((eb) =>
                eb
                  .selectFrom("serviceObligations as o")
                  .select(sql<number>`count(*)::int`.as("n"))
                  .whereRef("o.contractId", "=", "k.id")
                  .where("o.serviceType", "=", "aerobic_inspection")
                  .where("o.status", "=", "completed")
                  .as("visitsDone"),
              )
              .where("k.organizationId", "=", organizationId)
              .where("k.siteId", "in", siteIds)
              .orderBy("k.startOn", "desc")
              .execute(),
        none
          ? []
          : db
              .selectFrom("renewals")
              .select(["siteId", "contractId", "status", "startOn", "publicToken", "createdAt"])
              .where("organizationId", "=", organizationId)
              .where("siteId", "in", siteIds)
              .orderBy("createdAt", "desc")
              .execute(),
        none
          ? []
          : db
              .selectFrom("serviceObligations as o")
              .leftJoin("jobs as j", (j) => j.onRef("j.obligationId", "=", "o.id").onRef("j.organizationId", "=", "o.organizationId").on("j.type", "=", "inspection").on("j.status", "in", ["scheduled", "in_progress"]))
              .select(["o.siteId", "o.dueOn", "o.windowStart", "o.windowEnd", "j.scheduledDate"])
              .where("o.organizationId", "=", organizationId)
              .where("o.siteId", "in", siteIds)
              .where("o.serviceType", "=", "aerobic_inspection")
              .where("o.status", "=", "open")
              .orderBy("o.dueOn")
              .execute(),
        none
          ? []
          : // Only the customer's copy of each inspection's report, latest version.
            db
              .selectFrom("reports as r")
              .innerJoin("inspections as i", (j) => j.onRef("i.id", "=", "r.inspectionId").onRef("i.organizationId", "=", "r.organizationId"))
              .select(["r.id", "r.siteId", "i.completedAt", "i.arrivedAt"])
              .distinctOn("r.inspectionId")
              .where("r.organizationId", "=", organizationId)
              .where("r.siteId", "in", siteIds)
              .where("r.audience", "=", "customer")
              .orderBy("r.inspectionId")
              .orderBy("r.version", "desc")
              .execute(),
        db
          .selectFrom("serviceRequests")
          .select(["id", "siteId", "kind", "description", "status", "resolution", "createdAt", "closedAt"])
          .where("organizationId", "=", organizationId)
          .where("customerId", "=", customerId)
          .orderBy("createdAt", "desc")
          .limit(50)
          .execute(),
        db
          .selectFrom("invoices")
          .select(["number", "issuedOn", "dueOn", "totalCents", "paidCents", "pendingCents", "creditedCents", "paymentStatus", "publicToken"])
          .where("organizationId", "=", organizationId)
          .where("customerId", "=", customerId)
          .where("status", "=", "open")
          // Anything still owed, and the last year of the rest.
          .where((eb) => eb.or([eb(sql`total_cents - credited_cents - paid_cents - pending_cents`, ">", 0), eb("issuedOn", ">=", sql<string>`${today}::date - 365`)]))
          .orderBy("issuedOn", "desc")
          .limit(50)
          .execute(),
      ]);
      // SW-9: a contract with pumping or maintenance visits shows each kind of visit's own
      // progress; an inspection-only contract keeps its one inspection count.
      const contractIds = contracts.map((k) => k.id);
      const cycleProgress = contractIds.length
        ? await db
            .selectFrom("contractServiceCycles as y")
            // A cycle with no visit this term (allowed every 36 months on a 12-month plan) still shows, as 0 of 0.
            .leftJoin("serviceObligations as o", (j) => j.onRef("o.cycleId", "=", "y.id").onRef("o.organizationId", "=", "y.organizationId"))
            .select(["y.contractId", "y.cycleKey", "y.serviceType", sql<string | null>`y.snapshot->>'label'`.as("label")])
            .select(sql<number>`count(o.id) filter (where o.status <> 'cancelled')::int`.as("total"))
            .select(sql<number>`count(o.id) filter (where o.status = 'completed')::int`.as("done"))
            .where("y.organizationId", "=", organizationId)
            .where("y.contractId", "in", contractIds)
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom("contractServiceCycles as x")
                  .select("x.id")
                  .whereRef("x.contractId", "=", "y.contractId")
                  .where("x.serviceType", "<>", "aerobic_inspection"),
              ),
            )
            .groupBy(["y.contractId", "y.cycleKey", "y.serviceType", "y.snapshot"])
            .orderBy(sql`y.service_type <> 'aerobic_inspection'`)
            .orderBy("y.cycleKey")
            .execute()
        : [];
      // SW-9: a site's next pumping or maintenance visit, shown when it has no inspection due,
      // and which sites have inspections at all (a pumping-only site has no "last inspection").
      const [cycleVisits, inspectedSites] = none
        ? [[], []]
        : await Promise.all([
            db
              .selectFrom("serviceObligations as o")
              .innerJoin("contractServiceCycles as y", (j) => j.onRef("y.id", "=", "o.cycleId").onRef("y.organizationId", "=", "o.organizationId"))
              // A visit booked as work and put on the schedule shows its date.
              .leftJoin("workOrders as w", (j) => j.onRef("w.obligationId", "=", "o.id").onRef("w.organizationId", "=", "o.organizationId").on("w.status", "<>", "cancelled"))
              .leftJoin("jobs as j", (j) => j.onRef("j.workOrderId", "=", "w.id").onRef("j.organizationId", "=", "w.organizationId").on("j.status", "in", ["scheduled", "in_progress"]))
              .select(["o.siteId", "o.dueOn", "o.windowStart", "o.windowEnd", "y.cycleKey", "j.scheduledDate", sql<string | null>`y.snapshot->>'label'`.as("label")])
              .where("o.organizationId", "=", organizationId)
              .where("o.siteId", "in", siteIds)
              .where("o.serviceType", "<>", "aerobic_inspection")
              .where("o.status", "=", "open")
              .orderBy("o.dueOn")
              .orderBy("j.scheduledDate")
              .execute(),
            db
              .selectFrom("serviceObligations")
              .select("siteId")
              .distinct()
              .where("organizationId", "=", organizationId)
              .where("siteId", "in", siteIds)
              .where("serviceType", "=", "aerobic_inspection")
              .execute(),
          ]);
      const hasInspections = new Set(inspectedSites.map((x) => x.siteId));
      const progressOf = (contractId: string) =>
        cycleProgress
          .filter((p) => p.contractId === contractId)
          .map((p) => ({ label: p.serviceType === "aerobic_inspection" ? "Aerobic inspections" : (p.label ?? p.cycleKey), done: p.done, total: p.total }));
      // SW-7: finished work with its completion summary.
      const work = await completedWorkOrders(db, organizationId, siteIds);
      // A report waiting for the maintenance provider's signature is not shown yet (30 TAC 285.7(b)(3)).
      const ready = new Set((await Promise.all(reports.map(async (x) => ((await customerCopy(db, organizationId, x.id))?.ready ? x.id : null)))).filter(Boolean));

      const sites: PortalSite[] = siteRows.map((s) => {
        const sys = systems.find((x) => x.siteId === s.id);
        const mine = contracts.filter((k) => k.siteId === s.id);
        // The contract in force, else the next one, else the last one.
        const k =
          mine.find((c) => contractState(c, today) === "active") ??
          mine.filter((c) => contractState(c, today) === "upcoming").at(-1) ??
          mine.find((c) => c.status === "active") ??
          mine[0];
        const r = renewals.find((x) => x.siteId === s.id && (!k || x.contractId === k.id));
        const next = obligations.find((o) => o.siteId === s.id);
        const nextCycle = next ? undefined : cycleVisits.find((o) => o.siteId === s.id);
        return {
          id: s.id,
          address: [s.addressLine1, s.addressLine2, cityLine(s.city, s.state, s.postalCode)].filter(Boolean).join(", "),
          system: sys
            ? {
                manufacturer: sys.manufacturer,
                model: sys.model,
                serial: sys.serial,
                installedAt: sys.installedAt,
                systemType: sys.systemType,
                treatmentType: sys.treatmentType,
                disposalType: sys.disposalType,
                chlorinationMethod: sys.chlorinationMethod,
              }
            : null,
          contract: k ? { planName: k.planName, startOn: k.startOn, endOn: k.endOn, state: contractState(k, today), visitsPerTerm: k.visitsPerTerm, visitsDone: Number(k.visitsDone ?? 0), visitProgress: progressOf(k.id) } : null,
          renewal: r ? { status: r.status, startOn: r.startOn, url: r.status === "expired" ? null : renewUrlFor(appUrl, r.publicToken) } : null,
          nextVisit: next
            ? { dueOn: next.dueOn, windowStart: next.windowStart, windowEnd: next.windowEnd, scheduledDate: next.scheduledDate, label: null }
            : nextCycle
              ? { dueOn: nextCycle.dueOn, windowStart: nextCycle.windowStart, windowEnd: nextCycle.windowEnd, scheduledDate: nextCycle.scheduledDate ?? null, label: nextCycle.label ?? nextCycle.cycleKey }
              : null,
          inspections: hasInspections.has(s.id) || reports.some((x) => x.siteId === s.id),
          reports: reports
            .filter((x) => x.siteId === s.id && ready.has(x.id))
            .map((x) => ({ id: x.id, inspectedOn: dateInZone(x.completedAt ?? x.arrivedAt, org.timezone), url: `/portal/${req.params.token}/reports/${x.id}` }))
            .sort((a, b) => b.inspectedOn.localeCompare(a.inspectedOn)),
          completedWork: work
            .filter((w) => w.siteId === s.id)
            .map((w) => ({ id: w.id, label: workOrderLabel(w.number), title: w.title, completedOn: dateInZone(w.completedAt!, org.timezone), url: `/portal/${req.params.token}/work-orders/${w.id}/summary` })),
          serviceRequests: requests
            .filter((x) => x.siteId === s.id)
            .map((x) => ({ id: x.id, kind: x.kind, description: x.description, status: x.status, resolution: x.resolution, createdAt: x.createdAt.toISOString(), closedAt: iso(x.closedAt) })),
        };
      });

      const items = invoices
        .filter((i) => i.publicToken && i.number !== null && i.issuedOn && i.dueOn)
        .map((i) => {
          const due = amountDue(i);
          return {
            number: invoiceNumberLabel(i.number),
            issuedOn: i.issuedOn!,
            dueOn: i.dueOn!,
            totalCents: i.totalCents,
            amountDueCents: due,
            paymentStatus: i.paymentStatus,
            overdue: due > 0 && i.dueOn! < today,
            payUrl: payUrlFor(appUrl, i.publicToken!),
          };
        });

      return {
        provider: { name: org.name, phone: org.phone, email: org.email },
        customerName: customer.displayName,
        expiresAt: link.expiresAt.toISOString(),
        sites,
        invoices: items,
        amountDueCents: items.reduce((n, i) => n + i.amountDueCents, 0),
      };
    },
  );

  app.get(
    "/portal/:token/reports/:reportId",
    {
      config: { public: true, rateLimit: publicLimit },
      schema: { tags: ["portal"], summary: "Open one of the customer's inspection reports", params: reportParams },
    },
    async (req, reply) => {
      const link = await linkFor(req.params.token);
      // The report must be the customer's copy, for one of this customer's sites.
      const row = await db
        .selectFrom("reports as r")
        .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "r.siteId").onRef("s.organizationId", "=", "r.organizationId"))
        .select(["r.storageKey", "r.inspectionId"])
        .where("r.organizationId", "=", link.organizationId)
        .where("s.customerId", "=", link.customerId)
        .where("r.audience", "=", "customer")
        .where("r.id", "=", req.params.reportId)
        .executeTakeFirst();
      // The signed copy when there is one; one still waiting for the signature is not out yet.
      const copy = row && (await customerCopy(db, link.organizationId, req.params.reportId));
      const data = copy?.ready ? await readForDownload(db, store, copy.storageKey) : null;
      if (!row || !copy || !data) throw notFound("Report");
      return reply
        .type("application/pdf")
        .header("content-disposition", `inline; filename="inspection-report-${row.inspectionId.slice(0, 8)}${copy.signed ? "-signed" : ""}.pdf"`)
        .header("x-content-type-options", "nosniff")
        .send(data);
    },
  );

  app.get(
    "/portal/:token/work-orders/:workOrderId/summary",
    {
      config: { public: true, rateLimit: publicLimit },
      schema: { tags: ["portal"], summary: "Open the completion summary of the customer's finished work (SW-7)", params: token.extend({ workOrderId: id }) },
    },
    async (req, reply) => {
      const link = await linkFor(req.params.token);
      // Only this customer's work order; any other id is simply not found.
      const pdf = await completionSummaryPdf(db, link.organizationId, req.params.workOrderId, now(), { customerId: link.customerId }).catch((err: unknown) => {
        if ((err as { statusCode?: number }).statusCode === 409) throw notFound("Work completion summary");
        throw err;
      });
      return reply
        .type("application/pdf")
        .header("content-disposition", `inline; filename="work-completion-${req.params.workOrderId.slice(0, 8)}.pdf"`)
        .header("x-content-type-options", "nosniff")
        .send(pdf);
    },
  );

  app.post(
    "/portal/:token/service-requests",
    {
      config: { public: true, rateLimit: actionLimit },
      schema: { tags: ["portal"], summary: "Ask the office for service", params: token, body: serviceRequestInput, response: { 201: z.object({ id }) } },
    },
    async (req, reply) => {
      const link = await linkFor(req.params.token);
      const site = await db
        .selectFrom("sites")
        .select(["id"])
        .where("organizationId", "=", link.organizationId)
        .where("customerId", "=", link.customerId)
        .where("id", "=", req.body.siteId)
        .executeTakeFirst();
      if (!site) throw notFound("Property");
      const at = now();
      const created = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto("serviceRequests")
          .values({
            organizationId: link.organizationId,
            customerId: link.customerId,
            siteId: site.id,
            kind: req.body.kind,
            description: req.body.description,
            contactPhone: req.body.contactPhone || null,
            portalLinkId: link.id,
            receivedAt: at,
            updatedAt: at,
          })
          .returning(["id"])
          .executeTakeFirstOrThrow();
        await systemAudit(trx, { organizationId: link.organizationId, action: "service_request.created", entityType: "service_request", entityId: row.id, changes: { kind: req.body.kind }, requestId: req.id });
        return row;
      });
      return reply.status(201).send(created);
    },
  );

  // ---- The office's side ----

  async function customerIn(organizationId: string, customerId: string) {
    const c = await db.selectFrom("customers").select(["id"]).where("organizationId", "=", organizationId).where("id", "=", customerId).executeTakeFirst();
    if (!c) throw notFound("Customer");
    return c;
  }

  app.get(
    "/customers/:id/portal",
    { config: { permission: "crm:read" }, schema: { tags: ["portal"], summary: "Who can open this customer's portal", params, response: { 200: portalAccess } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await customerIn(organizationId, req.params.id);
      const at = now();
      const [links, email] = await Promise.all([
        db
          .selectFrom("portalLinks as l")
          .leftJoin("users as u", "u.id", "l.createdBy")
          .select(["l.id", "l.source", "l.sentTo", "l.createdAt", "l.expiresAt", "l.lastUsedAt", "l.revokedAt", "u.name as createdByName"])
          .where("l.organizationId", "=", organizationId)
          .where("l.customerId", "=", req.params.id)
          .orderBy("l.createdAt", "desc")
          .limit(20)
          .execute(),
        billingEmail(db, organizationId, req.params.id),
      ]);
      const active = links.filter((l) => !l.revokedAt && l.expiresAt > at);
      const used = links.map((l) => l.lastUsedAt).filter((d): d is Date => !!d);
      return {
        activeLinks: active.length,
        lastUsedAt: used.length ? new Date(Math.max(...used.map((d) => d.getTime()))).toISOString() : null,
        links: links.map((l) => ({ ...l, createdAt: l.createdAt.toISOString(), expiresAt: l.expiresAt.toISOString(), lastUsedAt: iso(l.lastUsedAt), revokedAt: iso(l.revokedAt) })),
        email,
      };
    },
  );

  app.post(
    "/customers/:id/portal-link",
    {
      config: { permission: "crm:write" },
      schema: {
        tags: ["portal"],
        summary: "Make a portal link for a customer",
        description: "With `send`, the link is emailed to the customer's billing (else primary) contact and not shown. Without it, the link is returned once to copy; it cannot be shown again.",
        params,
        body: portalLinkInput,
        response: { 201: portalLink },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      await customerIn(organizationId, req.params.id);
      const at = now();
      if (req.body.send) {
        const to = await billingEmail(db, organizationId, req.params.id);
        if (!to) throw new HttpError(422, "no_email", "This customer has no email address on file. Add one to a contact, or copy the link instead.");
        await db.transaction().execute(async (trx) => {
          const payload: PortalLinkEmail = { customerId: req.params.id, to, source: "office", createdBy: userId };
          await enqueue(trx, { kind: PORTAL_LINK_EMAIL, organizationId, payload: { ...payload }, dedupeKey: `portal-office-${crypto.randomUUID()}`, runAt: at });
          await audit(trx, req, { action: "portal_link.emailed", entityType: "customer", entityId: req.params.id, changes: { to } });
        });
        return reply.status(201).send({ url: null, expiresAt: null, sentTo: to });
      }
      const link = await db.transaction().execute(async (trx) => {
        const l = await createPortalLink(trx, { organizationId, customerId: req.params.id, source: "office", sentTo: null, createdBy: userId, now: at });
        await audit(trx, req, { action: "portal_link.created", entityType: "customer", entityId: req.params.id, changes: { portalLinkId: l.id } });
        return l;
      });
      return reply.status(201).send({ url: portalUrlFor(appUrl, link.token), expiresAt: link.expiresAt.toISOString(), sentTo: null });
    },
  );

  app.post(
    "/customers/:id/portal-links/revoke",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["portal"], summary: "Turn off every portal link this customer has", params, body: z.object({}).optional(), response: { 200: z.object({ revoked: z.number().int() }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await customerIn(organizationId, req.params.id);
      const at = now();
      return db.transaction().execute(async (trx) => {
        const res = await trx
          .updateTable("portalLinks")
          .set({ revokedAt: at })
          .where("organizationId", "=", organizationId)
          .where("customerId", "=", req.params.id)
          .where("revokedAt", "is", null)
          .where("expiresAt", ">", at)
          .executeTakeFirst();
        const revoked = Number(res.numUpdatedRows);
        await audit(trx, req, { action: "portal_link.revoked", entityType: "customer", entityId: req.params.id, changes: { revoked } });
        return { revoked };
      });
    },
  );

  const requestRows = (organizationId: string) =>
    db
      .selectFrom("serviceRequests as r")
      .innerJoin("sites as s", "s.id", "r.siteId")
      .innerJoin("customers as c", "c.id", "r.customerId")
      .select([
        "r.id",
        "r.kind",
        "r.description",
        "r.contactPhone",
        "r.status",
        "r.resolution",
        "r.createdAt",
        "r.closedAt",
        "s.id as siteId",
        "s.addressLine1",
        "s.city",
        "c.id as customerId",
        "c.displayName",
      ])
      .where("r.organizationId", "=", organizationId);

  const toRequest = (r: Awaited<ReturnType<ReturnType<typeof requestRows>["execute"]>>[number]): ServiceRequest => ({
    id: r.id,
    kind: r.kind,
    description: r.description,
    contactPhone: r.contactPhone,
    status: r.status,
    resolution: r.resolution,
    createdAt: r.createdAt.toISOString(),
    closedAt: iso(r.closedAt),
    site: { id: r.siteId, addressLine1: r.addressLine1, city: r.city },
    customer: { id: r.customerId, displayName: r.displayName },
  });

  app.get(
    "/service-requests",
    {
      config: { permission: "crm:read" },
      schema: {
        tags: ["portal"],
        summary: "Service requests customers sent from the portal, newest first",
        querystring: z.object({ customerId: id.optional(), status: z.enum(["open", "closed"]).optional() }),
        response: { 200: z.object({ items: z.array(serviceRequest) }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      let q = requestRows(organizationId);
      if (req.query.customerId) q = q.where("r.customerId", "=", req.query.customerId);
      if (req.query.status) q = q.where("r.status", "=", req.query.status);
      const rows = await q.orderBy("r.createdAt", "desc").limit(200).execute();
      return { items: rows.map(toRequest) };
    },
  );

  app.post(
    "/service-requests/:id/resolve",
    {
      config: { permission: "crm:write" },
      schema: { tags: ["portal"], summary: "Close a service request, saying what was done", params, body: serviceRequestResolveInput, response: { 200: serviceRequest } },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const r = await trx.selectFrom("serviceRequests").select(["id", "status"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).forUpdate().executeTakeFirst();
        if (!r) throw notFound("Service request");
        if (r.status !== "open") throw new HttpError(409, "already_closed", "This service request is already closed");
        await trx
          .updateTable("serviceRequests")
          .set({ status: "closed", resolution: req.body.resolution, closedAt: at, closedBy: userId, updatedAt: at })
          .where("organizationId", "=", organizationId)
          .where("id", "=", r.id)
          .execute();
        await audit(trx, req, { action: "service_request.closed", entityType: "service_request", entityId: r.id, changes: { resolution: req.body.resolution } });
      });
      return toRequest(await requestRows(organizationId).where("r.id", "=", req.params.id).executeTakeFirstOrThrow());
    },
  );
};
