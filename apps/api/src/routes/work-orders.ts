import type { Database, DB } from "@aerowise/db";
import {
  id,
  ISSUE_LABELS,
  JOB_STATE_MACHINE,
  SERVICE_REQUEST_LABELS,
  toMilli,
  WORK_ORDER_STATE_MACHINE,
  workOrderCancelInput,
  workOrderCompleteInput,
  workOrderConvertInput,
  workOrderDetail,
  workOrderFields,
  workOrderInput,
  workOrderLabel,
  workOrderListQuery,
  workOrderNoteInput,
  workOrderScheduleInput,
  workOrderSummary,
  workType,
  workTypeFields,
  workTypeInput,
  workTypeKeyForIssue,
  workTypeKeyForRequest,
  type Feature,
  type WorkOrderDetail,
  type WorkOrderSummary,
  type WorkSourceKind,
} from "@aerowise/domain";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { invoiceEvent } from "@aerowise/payments";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { coveredInvoiceLines } from "../lib/coverage.ts";
import { isWorkForm } from "../lib/forms.ts";
import { acceptedPricing } from "../lib/estimates.ts";
import { checkDraftRefs, writeDraftLines } from "../lib/invoices.ts";
import { pumpedVolume } from "../lib/pumping.ts";
import { featureOff, lockWorkOrder, nextWorkOrderNumber, setWorkOrderStatus, workOrderEvent } from "../lib/work-orders.ts";

// General work orders (SW-1 of the service workflows plan): the office creates them, turns
// inspection issues and homeowner requests into them, schedules their visits and completes
// or cancels them. None of this reaches the compliance path: no filing, report, compliance
// event or aerobic visit is touched (the database keeps work jobs away from all of them).
// Completing a visit on the phone comes with SW-2.

const params = z.object({ id });
type Trx = Transaction<DB>;

const WORK_TYPE_COLUMNS = ["id", "key", "name", "category", "defaultFormTemplateKey", "defaultDurationMinutes", "requiresDisposalRecord", "active", "position"] as const;

/** A kind of work may point only at a work form the company can use (SW-F). */
async function checkWorkForm(ex: Kysely<DB>, organizationId: string, key: string | null | undefined) {
  if (key == null) return;
  if (!(await isWorkForm(ex, organizationId, key))) throw unprocessable(`There is no work form with the key ${key}`);
}

// Members who can be sent on a visit, as for inspections.
const ASSIGNABLE_ROLES = ["technician", "owner"] as const;

export const workOrderRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; features: ReadonlySet<Feature> }> = async (app, { db, now, features }) => {
  const enabled = features.has("work_orders");
  const requireFeature = () => {
    if (!enabled) throw featureOff();
  };

  /** A technician sees only work orders with a visit assigned to them. */
  const visibleTo = (req: FastifyRequest) => {
    const { role, userId } = req.requireAuth();
    return role === "technician" ? userId : null;
  };

  const summaryQuery = (organizationId: string) =>
    db
      .selectFrom("workOrders as w")
      .innerJoin("workTypes as t", (k) => k.onRef("t.id", "=", "w.workTypeId").onRef("t.organizationId", "=", "w.organizationId"))
      .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "w.siteId").onRef("s.organizationId", "=", "w.organizationId"))
      .innerJoin("customers as c", (k) => k.onRef("c.id", "=", "w.customerId").onRef("c.organizationId", "=", "w.organizationId"))
      .leftJoin("jobs as j", (k) => k.onRef("j.workOrderId", "=", "w.id").onRef("j.organizationId", "=", "w.organizationId").on("j.type", "=", "work").on("j.status", "in", ["scheduled", "in_progress"]))
      .leftJoin("users as u", "u.id", "j.technicianUserId")
      .select([
        "w.id",
        "w.number",
        "w.title",
        "w.category",
        "w.status",
        "w.priority",
        "w.billingStatus",
        "w.sourceKind",
        "w.sourceId",
        "w.requestedOn",
        "w.createdAt",
        "w.completedAt",
        "t.id as workTypeId",
        "t.name as workTypeName",
        "c.id as customerId",
        "c.displayName",
        "s.id as siteId",
        "s.addressLine1",
        "s.city",
        "j.id as jobId",
        "j.scheduledDate",
        "j.technicianUserId",
        "j.status as jobStatus",
        "u.name as technicianName",
      ])
      .where("w.organizationId", "=", organizationId);

  type SummaryRow = Awaited<ReturnType<ReturnType<typeof summaryQuery>["execute"]>>[number];
  const toSummary = (r: SummaryRow): WorkOrderSummary => ({
    id: r.id,
    number: r.number,
    label: workOrderLabel(r.number),
    title: r.title,
    category: r.category,
    workType: { id: r.workTypeId, name: r.workTypeName },
    status: r.status,
    priority: r.priority,
    billingStatus: r.billingStatus,
    sourceKind: r.sourceKind,
    sourceId: r.sourceId,
    requestedOn: r.requestedOn,
    customer: { id: r.customerId, displayName: r.displayName },
    site: { id: r.siteId, addressLine1: r.addressLine1, city: r.city },
    nextVisit:
      r.jobId && r.scheduledDate && r.technicianUserId && r.jobStatus
        ? { jobId: r.jobId, scheduledDate: r.scheduledDate, technicianId: r.technicianUserId, technicianName: r.technicianName ?? "", status: r.jobStatus }
        : null,
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
  });

  const assignedTo = (userId: string) =>
    sql<boolean>`exists (select 1 from jobs aj where aj.organization_id = w.organization_id and aj.work_order_id = w.id and aj.type = 'work' and aj.technician_user_id = ${userId})`;

  async function sourceLabel(organizationId: string, kind: WorkSourceKind, sourceId: string | null) {
    if (kind === "inspection_issue" && sourceId) {
      const issue = await db.selectFrom("issues").select(["type"]).where("organizationId", "=", organizationId).where("id", "=", sourceId).executeTakeFirst();
      return issue ? `Inspection issue: ${ISSUE_LABELS[issue.type as keyof typeof ISSUE_LABELS] ?? issue.type}` : "Inspection issue (removed)";
    }
    if (kind === "portal_request" && sourceId) {
      const r = await db.selectFrom("serviceRequests").select(["kind", "source"]).where("organizationId", "=", organizationId).where("id", "=", sourceId).executeTakeFirst();
      return r ? `${r.source === "portal" ? "Customer request" : "Service request"}: ${SERVICE_REQUEST_LABELS[r.kind].toLowerCase()}` : "Service request";
    }
    if (kind === "estimate") return "Estimate";
    if (kind === "contract_cycle") return "Service plan visit";
    return "Created by the office";
  }

  async function loadDetail(req: FastifyRequest, workOrderId: string): Promise<WorkOrderDetail> {
    const { organizationId } = req.requireAuth();
    let q = summaryQuery(organizationId)
      .leftJoin("users as cb", "cb.id", "w.createdBy")
      .select(["w.description", "w.stateMachineVersion", "w.completedWithoutRecordReason", "w.cancelledAt", "w.cancelReason", "cb.name as createdByName"])
      .where("w.id", "=", workOrderId);
    const tech = visibleTo(req);
    if (tech) q = q.where(assignedTo(tech));
    const row = await q.executeTakeFirst();
    if (!row) throw notFound("Work order");
    const [lines, visits, events, notes, invoices] = await Promise.all([
      db.selectFrom("workOrderLines").selectAll().where("organizationId", "=", organizationId).where("workOrderId", "=", row.id).orderBy("position").orderBy("createdAt").execute(),
      db
        .selectFrom("jobs as j")
        .innerJoin("users as u", "u.id", "j.technicianUserId")
        .select(["j.id", "j.visitNumber", "j.status", "j.scheduledDate", "j.technicianUserId", "u.name", "j.notes", "j.cancelReason"])
        .where("j.organizationId", "=", organizationId)
        .where("j.type", "=", "work")
        .where("j.workOrderId", "=", row.id)
        .orderBy("j.visitNumber")
        .execute(),
      db
        .selectFrom("workOrderEvents as e")
        .leftJoin("users as u", "u.id", "e.actorUserId")
        .select(["e.id", "e.eventType", "e.summary", "e.occurredAt", "e.homeownerVisible", "u.name"])
        .where("e.organizationId", "=", organizationId)
        .where("e.workOrderId", "=", row.id)
        .orderBy("e.seq")
        .execute(),
      db
        .selectFrom("workOrderNotes as n")
        .leftJoin("users as u", "u.id", "n.authorUserId")
        .select(["n.id", "n.body", "n.visibility", "n.createdAt", "u.name"])
        .where("n.organizationId", "=", organizationId)
        .where("n.workOrderId", "=", row.id)
        .orderBy("n.createdAt")
        .execute(),
      // Invoices made from this order, or that bill one of its visits.
      db
        .selectFrom("invoices as i")
        .select(["i.id", "i.number", "i.status", "i.totalCents"])
        .where("i.organizationId", "=", organizationId)
        .where(({ eb, exists, or, selectFrom }) =>
          or([
            eb("i.workOrderId", "=", row.id),
            exists(
            selectFrom("invoiceLines as l")
              .innerJoin("jobs as j", (k) => k.onRef("j.id", "=", "l.jobId").onRef("j.organizationId", "=", "l.organizationId"))
              .select("l.id")
              .whereRef("l.invoiceId", "=", "i.id")
              .whereRef("l.organizationId", "=", "i.organizationId")
              .where("j.type", "=", "work")
              .where("j.workOrderId", "=", row.id),
            ),
          ]),
        )
        .orderBy("i.createdAt")
        .execute(),
    ]);
    const lineItems = lines.map((l) => ({
      id: l.id,
      position: l.position,
      description: l.description,
      quantityMilli: l.quantityMilli,
      quantity: l.quantityMilli / 1000,
      unitPriceCents: l.unitPriceCents,
      taxable: l.taxable,
      source: l.source,
      amountCents: Math.round((l.quantityMilli * l.unitPriceCents) / 1000),
      serviceItemId: l.serviceItemId,
      billPumpedVolume: l.billPumpedVolume,
    }));
    return {
      ...toSummary(row),
      description: row.description,
      stateMachineVersion: row.stateMachineVersion,
      completedWithoutRecordReason: row.completedWithoutRecordReason,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelReason: row.cancelReason,
      createdByName: row.createdByName,
      source: { kind: row.sourceKind, id: row.sourceId, label: await sourceLabel(organizationId, row.sourceKind, row.sourceId) },
      lines: lineItems,
      linesTotalCents: lineItems.reduce((n, l) => n + l.amountCents, 0),
      visits: visits.map((v) => ({
        jobId: v.id,
        visitNumber: v.visitNumber ?? 1,
        status: v.status,
        scheduledDate: v.scheduledDate,
        technicianId: v.technicianUserId,
        technicianName: v.name,
        notes: v.notes,
        cancelReason: v.cancelReason,
      })),
      events: events.map((e) => ({ id: e.id, eventType: e.eventType, summary: e.summary, occurredAt: e.occurredAt.toISOString(), actorName: e.name, homeownerVisible: e.homeownerVisible })),
      notes: notes.map((n) => ({ id: n.id, body: n.body, visibility: n.visibility, authorName: n.name, createdAt: n.createdAt.toISOString() })),
      invoices: invoices.map((i) => ({ id: i.id, number: i.number === null ? null : String(i.number), status: i.status, totalCents: i.totalCents })),
    };
  }

  async function writeLines(trx: Trx, organizationId: string, workOrderId: string, lines: z.infer<typeof workOrderInput>["lines"], at: Date) {
    await trx.deleteFrom("workOrderLines").where("organizationId", "=", organizationId).where("workOrderId", "=", workOrderId).where("source", "=", "planned").execute();
    if (!lines.length) return;
    const itemIds = [...new Set(lines.map((l) => l.serviceItemId).filter((x): x is string => !!x))];
    if (itemIds.length) {
      const found = await trx.selectFrom("serviceItems").select("id").where("organizationId", "=", organizationId).where("id", "in", itemIds).execute();
      if (found.length !== itemIds.length) throw notFound("Service item");
    }
    await trx
      .insertInto("workOrderLines")
      .values(lines.map((l, i) => ({ organizationId, workOrderId, position: i + 1, description: l.description, quantityMilli: toMilli(l.quantity), unitPriceCents: l.unitPriceCents, taxable: l.taxable, serviceItemId: l.serviceItemId ?? null, billPumpedVolume: l.billPumpedVolume, source: "planned" as const, updatedAt: at })))
      .execute();
  }

  async function activeWorkType(ex: Database | Trx, organizationId: string, workTypeId: string) {
    const t = await ex.selectFrom("workTypes").select(["id", "name", "category", "active"]).where("organizationId", "=", organizationId).where("id", "=", workTypeId).executeTakeFirst();
    if (!t) throw unprocessable("workTypeId does not match a kind of work in this organization");
    if (!t.active) throw unprocessable(`${t.name} is switched off; switch it on under Settings or pick another kind of work`);
    return t;
  }

  async function workTypeByKey(trx: Trx, organizationId: string, key: string) {
    const t = await trx.selectFrom("workTypes").select("id").where("organizationId", "=", organizationId).where("key", "=", key).where("active", "=", true).executeTakeFirst();
    if (t) return t.id;
    // The default was switched off or renamed away: the first active kind of work.
    const any = await trx.selectFrom("workTypes").select("id").where("organizationId", "=", organizationId).where("active", "=", true).orderBy("position").limit(1).executeTakeFirst();
    if (!any) throw unprocessable("No kind of work is switched on; switch one on under Settings first");
    return any.id;
  }

  /** Inserts the order and its first timeline entry. The caller holds any locks it needs. */
  async function insertWorkOrder(
    trx: Trx,
    req: FastifyRequest,
    o: {
      siteId: string;
      customerId: string;
      workTypeId: string;
      title: string;
      description: string;
      priority: "normal" | "urgent";
      requestedOn: string | null;
      draft: boolean;
      sourceKind: WorkSourceKind;
      sourceId: string | null;
      lines: z.infer<typeof workOrderInput>["lines"];
      createdSummary: string;
      /** The pumping or maintenance visit it is done for (SW-9). */
      obligationId?: string;
    },
  ) {
    const { organizationId, userId } = req.requireAuth();
    const at = now();
    const type = await activeWorkType(trx, organizationId, o.workTypeId);
    const number = await nextWorkOrderNumber(trx, organizationId);
    const created = await trx
      .insertInto("workOrders")
      .values({
        organizationId,
        number,
        customerId: o.customerId,
        siteId: o.siteId,
        workTypeId: type.id,
        category: type.category,
        title: o.title,
        description: o.description,
        priority: o.priority,
        status: o.draft ? "draft" : "open",
        stateMachineVersion: WORK_ORDER_STATE_MACHINE.version,
        requestedOn: o.requestedOn,
        createdBy: userId,
        sourceKind: o.sourceKind,
        sourceId: o.sourceId,
        obligationId: o.obligationId ?? null,
        updatedAt: at,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await writeLines(trx, organizationId, created.id, o.lines, at);
    await workOrderEvent(trx, req, { organizationId, workOrderId: created.id, eventType: "created", summary: o.createdSummary, details: { sourceKind: o.sourceKind, sourceId: o.sourceId }, homeownerVisible: true, at });
    await audit(trx, req, { action: "work_order.created", entityType: "work_order", entityId: created.id, changes: { number, title: o.title, sourceKind: o.sourceKind, sourceId: o.sourceId } });
    return created.id;
  }

  // ---- Kinds of work ----

  app.get(
    "/work-types",
    { config: { permission: "work:read" }, schema: { tags: ["work"], summary: "The company's kinds of work (its service menu)", response: { 200: z.object({ items: z.array(workType) }) } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const items = await db
        .selectFrom("workTypes")
        .select(WORK_TYPE_COLUMNS)
        .where("organizationId", "=", organizationId)
        .orderBy("position")
        .orderBy("name")
        .execute();
      return { items };
    },
  );

  app.post(
    "/work-types",
    { config: { permission: "org:manage" }, schema: { tags: ["work"], summary: "Add a kind of work", body: workTypeInput, response: { 201: workType } } },
    async (req, reply) => {
      requireFeature();
      const { organizationId } = req.requireAuth();
      const created = await db.transaction().execute(async (trx) => {
        await checkWorkForm(trx, organizationId, req.body.defaultFormTemplateKey);
        const position = await trx.selectFrom("workTypes").select(sql<number>`coalesce(max(position), 0) + 1`.as("n")).where("organizationId", "=", organizationId).executeTakeFirstOrThrow();
        const row = await trx
          .insertInto("workTypes")
          .values({ organizationId, key: req.body.key, name: req.body.name, category: req.body.category, defaultFormTemplateKey: req.body.defaultFormTemplateKey ?? null, defaultDurationMinutes: req.body.defaultDurationMinutes ?? null, requiresDisposalRecord: req.body.requiresDisposalRecord, position: Number(position.n), updatedAt: now() })
          .returning(WORK_TYPE_COLUMNS)
          .executeTakeFirstOrThrow()
          .catch((err) => {
            if ((err as { code?: string }).code === "23505") throw new HttpError(409, "duplicate_key", `There is already a kind of work with the key ${req.body.key}`);
            throw err;
          });
        await audit(trx, req, { action: "work_type.created", entityType: "work_type", entityId: row.id, changes: req.body });
        return row;
      });
      return reply.status(201).send(created);
    },
  );

  app.patch(
    "/work-types/:id",
    { config: { permission: "org:manage" }, schema: { tags: ["work"], summary: "Rename, reorder or switch off a kind of work", params, body: workTypeFields, response: { 200: workType } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      return db.transaction().execute(async (trx) => {
        await checkWorkForm(trx, organizationId, req.body.defaultFormTemplateKey);
        const row = await trx
          .updateTable("workTypes")
          .set({
            ...(req.body.name !== undefined ? { name: req.body.name } : {}),
            ...(req.body.defaultFormTemplateKey !== undefined ? { defaultFormTemplateKey: req.body.defaultFormTemplateKey } : {}),
            ...(req.body.defaultDurationMinutes !== undefined ? { defaultDurationMinutes: req.body.defaultDurationMinutes } : {}),
            ...(req.body.requiresDisposalRecord !== undefined ? { requiresDisposalRecord: req.body.requiresDisposalRecord } : {}),
            ...(req.body.active !== undefined ? { active: req.body.active } : {}),
            ...(req.body.position !== undefined ? { position: req.body.position } : {}),
            updatedAt: now(),
          })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning(WORK_TYPE_COLUMNS)
          .executeTakeFirst();
        if (!row) throw notFound("Kind of work");
        await audit(trx, req, { action: "work_type.updated", entityType: "work_type", entityId: row.id, changes: req.body });
        return row;
      });
    },
  );

  // ---- Work orders ----

  app.get(
    "/work-orders",
    {
      config: { permission: "work:read" },
      schema: { tags: ["work"], summary: "Work orders, newest first; a technician sees only their own", querystring: workOrderListQuery, response: { 200: z.object({ items: z.array(workOrderSummary), total: z.number().int() }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const f = req.query;
      let q = summaryQuery(organizationId);
      const tech = visibleTo(req);
      if (tech) q = q.where(assignedTo(tech));
      if (f.status) q = q.where("w.status", "=", f.status);
      if (f.active) q = q.where("w.status", "not in", ["completed", "cancelled"]);
      if (f.category) q = q.where("w.category", "=", f.category);
      if (f.siteId) q = q.where("w.siteId", "=", f.siteId);
      if (f.customerId) q = q.where("w.customerId", "=", f.customerId);
      if (f.sourceKind) q = q.where("w.sourceKind", "=", f.sourceKind);
      if (f.technicianId) q = q.where(assignedTo(f.technicianId));
      if (f.scheduledFrom) q = q.where("j.scheduledDate", ">=", f.scheduledFrom);
      if (f.scheduledTo) q = q.where("j.scheduledDate", "<=", f.scheduledTo);
      const [rows, count] = await Promise.all([
        q.orderBy(sql`w.status in ('completed', 'cancelled')`).orderBy("w.priority", "desc").orderBy("w.createdAt", "desc").limit(f.limit).offset(f.offset).execute(),
        q.clearSelect().select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow(),
      ]);
      return { items: rows.map(toSummary), total: Number(count.n) };
    },
  );

  app.get(
    "/work-orders/:id",
    { config: { permission: "work:read" }, schema: { tags: ["work"], summary: "A work order with its lines, visits, timeline, notes and invoices", params, response: { 200: workOrderDetail } } },
    async (req) => loadDetail(req, req.params.id),
  );

  app.post(
    "/work-orders",
    { config: { permission: "work:write" }, schema: { tags: ["work"], summary: "Create a work order at a site", body: workOrderInput, response: { 201: workOrderDetail } } },
    async (req, reply) => {
      requireFeature();
      const { organizationId } = req.requireAuth();
      const b = req.body;
      const site = await db.selectFrom("sites").select(["id", "customerId"]).where("organizationId", "=", organizationId).where("id", "=", b.siteId).executeTakeFirst();
      if (!site) throw notFound("Site");
      const id = await db.transaction().execute(async (trx) => {
        const type = await activeWorkType(trx, organizationId, b.workTypeId);
        return insertWorkOrder(trx, req, {
          siteId: site.id,
          customerId: site.customerId,
          workTypeId: type.id,
          title: b.title ?? type.name,
          description: b.description,
          priority: b.priority,
          requestedOn: b.requestedOn ?? null,
          draft: b.draft,
          sourceKind: "office",
          sourceId: null,
          lines: b.lines,
          createdSummary: "Created by the office",
        });
      });
      return reply.status(201).send(await loadDetail(req, id));
    },
  );

  app.post(
    "/obligations/:id/work-order",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["work"],
        summary: "Book a contract's pumping or maintenance visit as its work order; a second call returns the same order",
        description:
          "One work order per visit (SW-9), of the cycle's kind of work, requested for the visit's due date. Its visits are scheduled like any work order's; completing the order completes the visit, and cancelling it leaves the visit to book again while the contract still serves it.",
        params,
        body: z.object({}).optional(),
        response: { 200: workOrderDetail, 201: workOrderDetail },
      },
    },
    async (req, reply) => {
      requireFeature();
      const { organizationId } = req.requireAuth();
      const live = (ex: Database | Trx) =>
        ex.selectFrom("workOrders").select("id").where("organizationId", "=", organizationId).where("obligationId", "=", req.params.id).where("status", "<>", "cancelled").executeTakeFirst();
      let r: { created: boolean; id: string };
      try {
        r = await db.transaction().execute(async (trx) => {
          // The visit is locked, so two clicks at once take turns and the second finds the first's order.
          const o = await trx
            .selectFrom("serviceObligations as o")
            .innerJoin("contractServiceCycles as y", (j) => j.onRef("y.id", "=", "o.cycleId").onRef("y.organizationId", "=", "o.organizationId"))
            .innerJoin("contracts as c", (j) => j.onRef("c.id", "=", "o.contractId").onRef("c.organizationId", "=", "o.organizationId"))
            .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "o.siteId").onRef("s.organizationId", "=", "o.organizationId"))
            .select(["o.id", "o.status", "o.serviceType", "o.siteId", "o.sequence", "o.dueOn", "o.windowStart", "y.workTypeId", "y.snapshot", "c.status as contractStatus", "c.serviceEndsOn", "s.customerId"])
            .where("o.organizationId", "=", organizationId)
            .where("o.id", "=", req.params.id)
            .forUpdate("o")
            .executeTakeFirst();
          if (!o) throw notFound("Visit");
          if (o.serviceType === "aerobic_inspection" || !o.workTypeId) throw new HttpError(422, "inspection_visit", "This is an inspection visit: schedule it as an inspection");
          const found = await live(trx);
          if (found) return { created: false, id: found.id };
          // Booking new cycle work needs the switch; an order already booked stays readable and finishable.
          if (!features.has("service_cycles")) throw new HttpError(409, "feature_off", "Pumping and maintenance cycles are not switched on for this deployment");
          if (o.status !== "open") throw new HttpError(409, "visit_closed", `This visit is ${o.status}`);
          if (o.contractStatus === "cancelled" || (o.serviceEndsOn !== null && o.windowStart > o.serviceEndsOn)) {
            throw new HttpError(409, "contract_ended", "The contract no longer serves this visit");
          }
          const label = (o.snapshot as { label?: string }).label ?? "Service";
          const id = await insertWorkOrder(trx, req, {
            siteId: o.siteId,
            customerId: o.customerId,
            workTypeId: o.workTypeId,
            title: `${label}, visit ${o.sequence}`,
            description: "",
            priority: "normal",
            requestedOn: o.dueOn,
            draft: false,
            sourceKind: "contract_cycle",
            sourceId: o.id,
            obligationId: o.id,
            lines: [],
            createdSummary: `Booked from the contract: ${label}, visit ${o.sequence}, due ${o.dueOn}`,
          });
          return { created: true, id };
        });
      } catch (err) {
        // The one-per-visit index is the backstop: the other request's order is the one.
        const found = (err as { code?: string }).code === "23505" ? await live(db) : undefined;
        if (!found) throw err;
        r = { created: false, id: found.id };
      }
      return reply.status(r.created ? 201 : 200).send(await loadDetail(req, r.id));
    },
  );

  app.patch(
    "/work-orders/:id",
    { config: { permission: "work:write" }, schema: { tags: ["work"], summary: "Change a work order's details or planned lines", params, body: workOrderFields, response: { 200: workOrderDetail } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const b = req.body;
      const at = now();
      await db.transaction().execute(async (trx) => {
        const wo = await lockWorkOrder(trx, organizationId, req.params.id);
        if (wo.status === "completed" || wo.status === "cancelled") throw new HttpError(409, "work_order_closed", `This work order is ${wo.status}`);
        // An invoiced order's billing follows its invoice: void it to bill again or not at all.
        if (b.billingStatus && wo.billingStatus === "invoiced") throw new HttpError(409, "invoiced", "This work order has an invoice. Void or discard it first.");
        let category: string | undefined;
        if (b.workTypeId) category = (await activeWorkType(trx, organizationId, b.workTypeId)).category;
        await trx
          .updateTable("workOrders")
          .set({
            ...(b.title !== undefined ? { title: b.title } : {}),
            ...(b.description !== undefined ? { description: b.description } : {}),
            ...(b.priority !== undefined ? { priority: b.priority } : {}),
            ...(b.requestedOn !== undefined ? { requestedOn: b.requestedOn } : {}),
            ...(b.workTypeId ? { workTypeId: b.workTypeId, category: category as never } : {}),
            ...(b.billingStatus ? { billingStatus: b.billingStatus } : {}),
            updatedAt: at,
          })
          .where("organizationId", "=", organizationId)
          .where("id", "=", wo.id)
          .execute();
        if (b.lines) await writeLines(trx, organizationId, wo.id, b.lines, at);
        if (b.ready) {
          if (wo.status !== "draft") throw new HttpError(409, "not_draft", "Only a draft is made ready to schedule");
          await setWorkOrderStatus(trx, organizationId, wo, "open", at);
          await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "ready", summary: "Ready to schedule", at });
        }
        const changed = Object.keys(b).filter((k) => k !== "ready");
        if (changed.length) await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "updated", summary: `Changed ${changed.join(", ")}`, details: { fields: changed }, at });
        await audit(trx, req, { action: "work_order.updated", entityType: "work_order", entityId: wo.id, changes: b });
      });
      return loadDetail(req, req.params.id);
    },
  );

  app.post(
    "/work-orders/:id/schedule",
    {
      config: { permission: "schedule:write" },
      schema: { tags: ["work"], summary: "Schedule the next visit for a work order: a work job on a technician's day", params, body: workOrderScheduleInput, response: { 201: workOrderDetail } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const { technicianId, scheduledDate, notes } = req.body;
      const tech = await db
        .selectFrom("memberships as m")
        .innerJoin("users as u", "u.id", "m.userId")
        .select(["m.userId", "u.name"])
        .where("m.organizationId", "=", organizationId)
        .where("m.userId", "=", technicianId)
        .where("m.active", "=", true)
        .where("u.active", "=", true)
        .where("m.role", "in", ASSIGNABLE_ROLES)
        .executeTakeFirst();
      if (!tech) throw unprocessable("technicianId is not an active technician in this organization");
      const at = now();
      await db.transaction().execute(async (trx) => {
        const wo = await lockWorkOrder(trx, organizationId, req.params.id);
        if (wo.status === "draft") throw new HttpError(409, "not_ready", "Make the draft ready to schedule first");
        if (wo.status !== "open") throw new HttpError(409, "already_scheduled", wo.status === "scheduled" || wo.status === "in_progress" ? "This work order already has an open visit" : `This work order is ${wo.status}`);
        const prior = await trx
          .selectFrom("jobs")
          .select(sql<number>`coalesce(max(visit_number), 0) + 1`.as("next"))
          .where("organizationId", "=", organizationId)
          .where("type", "=", "work")
          .where("workOrderId", "=", wo.id)
          .executeTakeFirstOrThrow();
        const position = await trx
          .selectFrom("jobs")
          .select(sql<number>`coalesce(max(route_position), 0) + 1`.as("next"))
          .where("organizationId", "=", organizationId)
          .where("technicianUserId", "=", technicianId)
          .where("scheduledDate", "=", scheduledDate)
          .where("type", "in", ["inspection", "work"])
          .where("status", "<>", "cancelled")
          .executeTakeFirstOrThrow();
        const visitNumber = Number(prior.next);
        const job = await trx
          .insertInto("jobs")
          .values({
            organizationId,
            type: "work",
            workOrderId: wo.id,
            visitNumber,
            siteId: wo.siteId,
            obligationId: null,
            stateMachineVersion: JOB_STATE_MACHINE.version,
            scheduledDate,
            technicianUserId: technicianId,
            routePosition: Number(position.next),
            notes: notes ?? null,
            cancelledAt: null,
            cancelReason: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
          .catch((err) => {
            if ((err as { code?: string }).code === "23505") throw new HttpError(409, "already_scheduled", "This work order already has an open visit");
            throw err;
          });
        await setWorkOrderStatus(trx, organizationId, wo, "scheduled", at);
        await workOrderEvent(trx, req, {
          organizationId,
          workOrderId: wo.id,
          eventType: "visit_scheduled",
          summary: `Visit ${visitNumber} scheduled for ${scheduledDate} with ${tech.name}`,
          details: { jobId: job.id, technicianId, scheduledDate, visitNumber },
          homeownerVisible: true,
          at,
        });
        await audit(trx, req, { action: "job.scheduled", entityType: "job", entityId: job.id, changes: { workOrderId: wo.id, technicianId, scheduledDate, visitNumber } });
      });
      return reply.status(201).send(await loadDetail(req, req.params.id));
    },
  );

  /** Ends the order's open visit, if any, when the order itself is cancelled or completed by the office. */
  async function endOpenVisit(trx: Trx, req: FastifyRequest, organizationId: string, workOrderId: string, reason: string, at: Date) {
    const open = await trx
      .selectFrom("jobs")
      .select(["id"])
      .where("organizationId", "=", organizationId)
      .where("type", "=", "work")
      .where("workOrderId", "=", workOrderId)
      .where("status", "in", ["scheduled", "in_progress"])
      .forUpdate()
      .executeTakeFirst();
    if (!open) return null;
    await trx.updateTable("jobs").set({ status: "cancelled", cancelledAt: at, cancelReason: reason, updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", open.id).execute();
    await audit(trx, req, { action: "job.cancelled", entityType: "job", entityId: open.id, changes: { reason, workOrderId } });
    return open.id;
  }

  app.post(
    "/work-orders/:id/cancel",
    {
      config: { permission: "work:write" },
      schema: { tags: ["work"], summary: "Cancel a work order; its open visit is unscheduled and finished visits are kept", params, body: workOrderCancelInput, response: { 200: workOrderDetail } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const wo = await lockWorkOrder(trx, organizationId, req.params.id);
        const jobId = await endOpenVisit(trx, req, organizationId, wo.id, `Work order cancelled: ${req.body.reason}`, at);
        await setWorkOrderStatus(trx, organizationId, wo, "cancelled", at, { cancelledAt: at, cancelReason: req.body.reason }, req);
        await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "cancelled", summary: `Cancelled: ${req.body.reason}`, details: { reason: req.body.reason, jobId }, homeownerVisible: true, at });
        await audit(trx, req, { action: "work_order.cancelled", entityType: "work_order", entityId: wo.id, changes: req.body });
      });
      return loadDetail(req, req.params.id);
    },
  );

  app.post(
    "/work-orders/:id/complete",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["work"],
        summary: "Complete a work order without a field record, saying why (for example, recorded on a paper ticket)",
        params,
        body: workOrderCompleteInput,
        response: { 200: workOrderDetail },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const at = now();
      await db.transaction().execute(async (trx) => {
        const wo = await lockWorkOrder(trx, organizationId, req.params.id);
        if (wo.status === "draft") throw new HttpError(409, "invalid_transition", "Make the draft ready to schedule first");
        // Work done at no charge spends its coverage now; billed work spends it when invoiced.
        await setWorkOrderStatus(trx, organizationId, wo, "completed", at, { completedAt: at, completedWithoutRecordReason: req.body.reason }, req);
        const jobId = await endOpenVisit(trx, req, organizationId, wo.id, "Work order completed by the office without a field record", at);
        await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "completed", summary: `Completed by the office without a field record: ${req.body.reason}`, details: { reason: req.body.reason, jobId }, homeownerVisible: true, at });
        await audit(trx, req, { action: "work_order.completed", entityType: "work_order", entityId: wo.id, changes: { ...req.body, withoutRecord: true } });
      });
      return loadDetail(req, req.params.id);
    },
  );

  app.post(
    "/work-orders/:id/invoice",
    {
      config: { permission: "invoices:write" },
      schema: {
        tags: ["work"],
        summary: "Start a draft invoice from a work order's lines; a second call returns the same invoice",
        description:
          "One invoice that is not void per work order. Voiding it (or discarding the draft) makes the order unbilled again, so a replacement can be made; the field work is never reopened.",
        params,
        body: z.object({}).optional(),
        response: { 200: z.object({ invoiceId: id, workOrder: workOrderDetail }), 201: z.object({ invoiceId: id, workOrder: workOrderDetail }) },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const existing = (ex: Database | Trx) =>
        ex.selectFrom("invoices").select("id").where("organizationId", "=", organizationId).where("workOrderId", "=", req.params.id).where("status", "<>", "void").executeTakeFirst();
      let r: { created: boolean; invoiceId: string };
      try {
        r = await db.transaction().execute(async (trx) => {
          const at = now();
          // The order is locked first, so two clicks at once take turns and the second finds the first's invoice.
          const wo = await lockWorkOrder(trx, organizationId, req.params.id);
          const found = await existing(trx);
          if (found) return { created: false, invoiceId: found.id };
          if (!features.has("service_items")) throw new HttpError(409, "feature_off", "Invoicing work orders is not switched on for this deployment");
          if (wo.status === "draft" || wo.status === "cancelled") throw new HttpError(409, "not_billable", `A ${wo.status} work order is not invoiced`);
          if (wo.billingStatus === "no_charge") throw new HttpError(409, "no_charge", "This work order is marked no charge");
          const lines = await trx.selectFrom("workOrderLines").selectAll().where("organizationId", "=", organizationId).where("workOrderId", "=", wo.id).orderBy("position").orderBy("createdAt").execute();
          if (!lines.length) throw unprocessable("Add the work order's labor, parts or fees before invoicing it");
          // A line billed by the pumped volume takes the work order's current pump-out total, and cites it (SW-6).
          const pumped = lines.some((l) => l.billPumpedVolume) ? await pumpedVolume(trx, organizationId, wo.id) : null;
          if (pumped && pumped.milligallons === 0) throw unprocessable("A line bills the pumped volume, but no pump-out is recorded on this work order yet");
          const billed = lines.map((l) =>
            l.billPumpedVolume && pumped ? { ...l, quantityMilli: pumped.milligallons, description: `${l.description.slice(0, 495 - pumped.text.length)} (${pumped.text})` } : l,
          );
          // Lines the work order's applied coverage fits are priced under it, and say so (SW-8).
          const invoiceLines = await coveredInvoiceLines(
            trx,
            organizationId,
            wo,
            billed.map((l) => ({ description: l.description, quantity: l.quantityMilli / 1000, unitPriceCents: l.unitPriceCents, taxable: l.taxable, serviceItemId: l.serviceItemId })),
          );
          await checkDraftRefs(trx, organizationId, wo.customerId, wo.siteId, invoiceLines);
          const org = await trx.selectFrom("organizations").select(["invoiceTermsDays", "defaultTaxRateBps"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
          // Work from an accepted estimate bills at the rate and discount the customer accepted.
          const pricing = (await acceptedPricing(trx, organizationId, wo.id)) ?? { taxRateBps: org.defaultTaxRateBps, discountCents: 0 };
          const inv = await trx
            .insertInto("invoices")
            .values({
              organizationId,
              customerId: wo.customerId,
              siteId: wo.siteId,
              workOrderId: wo.id,
              number: null,
              memo: null,
              termsDays: org.invoiceTermsDays,
              taxRateBps: pricing.taxRateBps,
              discountCents: 0,
              subtotalCents: 0,
              taxableCents: 0,
              taxCents: 0,
              totalCents: 0,
              issuedOn: null,
              dueOn: null,
              publicToken: null,
              pdfStorageKey: null,
              pdfSha256: null,
              pdfByteSize: null,
              sentAt: null,
              paidAt: null,
              voidedAt: null,
              voidReason: null,
              createdBy: userId,
              updatedAt: at,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          await writeDraftLines(trx, organizationId, inv.id, invoiceLines, pricing, at);
          await trx.updateTable("workOrders").set({ billingStatus: "invoiced", updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", wo.id).execute();
          const woLabel = workOrderLabel(wo.number);
          await invoiceEvent(trx, { organizationId, invoiceId: inv.id, eventType: "created", summary: `Draft created from work order ${woLabel}`, actorUserId: userId, at });
          await workOrderEvent(trx, req, { organizationId, workOrderId: wo.id, eventType: "invoiced", summary: "Draft invoice created", details: { invoiceId: inv.id }, at });
          await audit(trx, req, { action: "invoice.created", entityType: "invoice", entityId: inv.id, changes: { workOrderId: wo.id, lines: invoiceLines.length } });
          return { created: true, invoiceId: inv.id };
        });
      } catch (err) {
        // The database's one-live-invoice index is the backstop: the other request's invoice is the one.
        const found = (err as { code?: string }).code === "23505" ? await existing(db) : undefined;
        if (!found) throw err;
        r = { created: false, invoiceId: found.id };
      }
      return reply.status(r.created ? 201 : 200).send({ invoiceId: r.invoiceId, workOrder: await loadDetail(req, req.params.id) });
    },
  );

  app.post(
    "/work-orders/:id/notes",
    { config: { permission: "work:write" }, schema: { tags: ["work"], summary: "Add an internal or customer-visible note", params, body: workOrderNoteInput, response: { 201: workOrderDetail } } },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const wo = await lockWorkOrder(trx, organizationId, req.params.id);
        const note = await trx
          .insertInto("workOrderNotes")
          .values({ organizationId, workOrderId: wo.id, body: req.body.body, visibility: req.body.visibility, authorUserId: userId })
          .returning("id")
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "work_order.note_added", entityType: "work_order", entityId: wo.id, changes: { noteId: note.id, visibility: req.body.visibility } });
      });
      return reply.status(201).send(await loadDetail(req, req.params.id));
    },
  );

  // ---- Turning an issue or a request into work, exactly once ----

  /**
   * Returns the live work order made from this source, or makes one. The source row is locked
   * first and the database's one-live-order-per-source index backs it, so two clicks at once
   * still make one order. 201 when made, 200 when it already existed.
   */
  async function convert(
    req: FastifyRequest,
    sourceKind: "inspection_issue" | "portal_request",
    lockSource: (trx: Trx) => Promise<{ siteId: string; customerId: string; defaultTypeKey: string; title: string; description: string; summary: string; priority: "normal" | "urgent" }>,
    linkSource: (trx: Trx, workOrderId: string) => Promise<void>,
    sourceId: string,
    input: z.infer<typeof workOrderConvertInput>,
  ): Promise<{ created: boolean; id: string }> {
    const { organizationId } = req.requireAuth();
    const existing = async (ex: Database | Trx) =>
      ex
        .selectFrom("workOrders")
        .select("id")
        .where("organizationId", "=", organizationId)
        .where("sourceKind", "=", sourceKind)
        .where("sourceId", "=", sourceId)
        .where("status", "<>", "cancelled")
        .executeTakeFirst();
    try {
      return await db.transaction().execute(async (trx) => {
        const src = await lockSource(trx);
        const found = await existing(trx);
        if (found) return { created: false, id: found.id };
        requireFeature();
        const workTypeId = input.workTypeId ?? (await workTypeByKey(trx, organizationId, src.defaultTypeKey));
        const id = await insertWorkOrder(trx, req, {
          siteId: src.siteId,
          customerId: src.customerId,
          workTypeId,
          title: input.title ?? src.title,
          description: src.description,
          priority: input.priority ?? src.priority,
          requestedOn: null,
          draft: false,
          sourceKind,
          sourceId,
          lines: [],
          createdSummary: src.summary,
        });
        await linkSource(trx, id);
        return { created: true, id };
      });
    } catch (err) {
      // Lost a race to another conversion of the same source: theirs is the one.
      if ((err as { code?: string }).code === "23505") {
        const found = await existing(db);
        if (found) return { created: false, id: found.id };
      }
      throw err;
    }
  }

  app.post(
    "/issues/:id/work-order",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["work"],
        summary: "Turn an inspection issue into a work order; a second call returns the same work order",
        params,
        body: workOrderConvertInput,
        response: { 200: workOrderDetail, 201: workOrderDetail },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const r = await convert(
        req,
        "inspection_issue",
        async (trx) => {
          const issue = await trx
            .selectFrom("issues as x")
            .innerJoin("sites as s", (k) => k.onRef("s.id", "=", "x.siteId").onRef("s.organizationId", "=", "x.organizationId"))
            .innerJoin("inspections as i", (k) => k.onRef("i.id", "=", "x.inspectionId").onRef("i.organizationId", "=", "x.organizationId"))
            .select(["x.id", "x.type", "x.severity", "x.description", "x.siteId", "s.customerId", "i.completedAt"])
            .where("x.organizationId", "=", organizationId)
            .where("x.id", "=", req.params.id)
            .forUpdate("x")
            .executeTakeFirst();
          if (!issue) throw notFound("Issue");
          const label = ISSUE_LABELS[issue.type as keyof typeof ISSUE_LABELS] ?? issue.type;
          return {
            siteId: issue.siteId,
            customerId: issue.customerId,
            defaultTypeKey: workTypeKeyForIssue(issue.type as keyof typeof ISSUE_LABELS),
            title: label,
            description: issue.description,
            summary: `Created from an inspection issue: ${label}${issue.completedAt ? ` (found ${issue.completedAt.toISOString().slice(0, 10)})` : ""}`,
            priority: issue.severity === "high" ? "urgent" : "normal",
          };
        },
        async (trx, workOrderId) => {
          await trx.updateTable("issues").set({ workOrderId, updatedAt: now() }).where("organizationId", "=", organizationId).where("id", "=", req.params.id).execute();
          await audit(trx, req, { action: "issue.work_order_created", entityType: "issue", entityId: req.params.id, changes: { workOrderId } });
        },
        req.params.id,
        req.body,
      );
      return reply.status(r.created ? 201 : 200).send(await loadDetail(req, r.id));
    },
  );

  app.post(
    "/service-requests/:id/work-order",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["work"],
        summary: "Turn a customer's service request into a work order; a second call returns the same work order",
        description: "The request keeps its own classification and response for authority reports; turning it into work does not close it.",
        params,
        body: workOrderConvertInput,
        response: { 200: workOrderDetail, 201: workOrderDetail },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const r = await convert(
        req,
        "portal_request",
        async (trx) => {
          const sr = await trx
            .selectFrom("serviceRequests")
            .select(["id", "kind", "description", "siteId", "customerId", "source", "receivedAt"])
            .where("organizationId", "=", organizationId)
            .where("id", "=", req.params.id)
            .forUpdate()
            .executeTakeFirst();
          if (!sr) throw notFound("Service request");
          const label = SERVICE_REQUEST_LABELS[sr.kind];
          return {
            siteId: sr.siteId,
            customerId: sr.customerId,
            defaultTypeKey: workTypeKeyForRequest(sr.kind),
            title: label,
            description: sr.description,
            summary: `Created from ${sr.source === "portal" ? "the customer's request" : "a service request"} of ${sr.receivedAt.toISOString().slice(0, 10)}: ${label.toLowerCase()}`,
            priority: sr.kind === "alarm" || sr.kind === "odor" ? "urgent" : "normal",
          };
        },
        async (trx, workOrderId) => {
          await trx.updateTable("serviceRequests").set({ workOrderId, updatedAt: now() }).where("organizationId", "=", organizationId).where("id", "=", req.params.id).execute();
          await audit(trx, req, { action: "service_request.work_order_created", entityType: "service_request", entityId: req.params.id, changes: { workOrderId } });
        },
        req.params.id,
        req.body,
      );
      return reply.status(r.created ? 201 : 200).send(await loadDetail(req, r.id));
    },
  );
};
