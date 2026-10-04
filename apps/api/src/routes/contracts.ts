import type { Database, DB } from "@aerowise/db";
import {
  addDays,
  buildTermSchedule,
  cancelInput,
  contractDetail,
  contractInput,
  contractState,
  dueObligation,
  dueQuery,
  id,
  obligation,
  plan,
  planInput,
  planPatch,
  renewInput,
} from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { definedOnly, jsonRow } from "../lib/json.ts";
import { organizationToday } from "../lib/today.ts";

const PLAN_COLUMNS = [
  "id",
  "name",
  "customerType",
  "termMonths",
  "visitsPerTerm",
  "priceCents",
  "billingFrequency",
  "serviceType",
  "active",
  "createdAt",
] as const;

const CONTRACT_COLUMNS = [
  "c.id",
  "c.siteId",
  "c.planId",
  "c.planName",
  "c.startOn",
  "c.endOn",
  "c.termMonths",
  "c.visitsPerTerm",
  "c.priceCents",
  "c.billingFrequency",
  "c.serviceType",
  "c.autoRenew",
  "c.status",
  "c.renewalStatus",
  "c.previousContractId",
  "c.cancelledAt",
  "c.cancelReason",
  "c.notes",
  "c.createdAt",
] as const;

const OBLIGATION_COLUMNS = [
  "o.id",
  "o.contractId",
  "o.siteId",
  "o.serviceType",
  "o.sequence",
  "o.windowStart",
  "o.windowEnd",
  "o.dueOn",
  "o.status",
  "o.completedAt",
] as const;

const params = z.object({ id });

interface Terms {
  planId: string | null;
  planName: string;
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: DB["contracts"]["billingFrequency"];
  serviceType: DB["contracts"]["serviceType"];
}

/** Maps Postgres constraint errors on contracts to API errors. */
function contractConflict(err: unknown): never {
  const code = (err as { code?: string }).code;
  const constraint = (err as { constraint?: string }).constraint ?? "";
  if (code === "23P01") throw new HttpError(409, "overlapping_contract", "This site already has a contract covering those dates");
  if (code === "23505" && constraint.includes("previous_contract_id")) {
    throw new HttpError(409, "already_renewed", "This contract has already been renewed");
  }
  throw err;
}

export const contractRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  const today = (organizationId: string) => organizationToday(db, organizationId, now());

  const contractQuery = (organizationId: string) =>
    db
      .selectFrom("contracts as c")
      .select(CONTRACT_COLUMNS)
      .select((eb) =>
        eb
          .selectFrom("contracts as r")
          .select("r.id")
          .whereRef("r.previousContractId", "=", "c.id")
          .as("renewedById"),
      )
      .where("c.organizationId", "=", organizationId);

  const toContract = <T extends { status: "active" | "cancelled"; startOn: string; endOn: string; cancelledAt: Date | null; createdAt: Date }>(
    row: T,
    asOf: string,
  ) => ({ ...jsonRow(row), state: contractState(row, asOf) });

  const loadObligations = (organizationId: string, contractId: string) =>
    db
      .selectFrom("serviceObligations as o")
      .select(OBLIGATION_COLUMNS)
      .where("o.organizationId", "=", organizationId)
      .where("o.contractId", "=", contractId)
      .orderBy("o.sequence")
      .execute()
      .then((rows) => rows.map(jsonRow));

  async function loadContractDetail(organizationId: string, contractId: string) {
    const row = await contractQuery(organizationId).where("c.id", "=", contractId).executeTakeFirst();
    if (!row) throw notFound("Contract");
    const [obligations, asOf] = await Promise.all([loadObligations(organizationId, row.id), today(organizationId)]);
    return { ...toContract({ ...row, renewedById: row.renewedById ?? null }, asOf), obligations };
  }

  /** Inserts a contract and one open obligation per visit window, in the caller's transaction. */
  async function insertContract(
    trx: Transaction<DB>,
    organizationId: string,
    input: { siteId: string; startOn: string; terms: Terms; autoRenew: boolean; notes?: string | null; previousContractId?: string },
  ) {
    const schedule = buildTermSchedule(input.startOn, input.terms.termMonths, input.terms.visitsPerTerm);
    const created = await trx
      .insertInto("contracts")
      .values({
        organizationId,
        siteId: input.siteId,
        ...input.terms,
        startOn: input.startOn,
        endOn: schedule.endOn,
        autoRenew: input.autoRenew,
        notes: input.notes ?? null,
        previousContractId: input.previousContractId ?? null,
        cancelledAt: null,
        cancelReason: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
      .catch(contractConflict);
    await trx
      .insertInto("serviceObligations")
      .values(
        schedule.visits.map((v) => ({
          organizationId,
          contractId: created.id,
          siteId: input.siteId,
          serviceType: input.terms.serviceType,
          sequence: v.sequence,
          windowStart: v.windowStart,
          windowEnd: v.windowEnd,
          dueOn: v.dueOn,
          completedAt: null,
        })),
      )
      .execute();
    return created.id;
  }

  async function activePlanTerms(organizationId: string, planId: string, priceCents?: number): Promise<Terms> {
    const p = await db
      .selectFrom("plans")
      .select(["id", "name", "termMonths", "visitsPerTerm", "priceCents", "billingFrequency", "serviceType", "active"])
      .where("organizationId", "=", organizationId)
      .where("id", "=", planId)
      .executeTakeFirst();
    if (!p) throw unprocessable("planId does not match a plan in this organization");
    if (!p.active) throw unprocessable("That plan is no longer offered");
    return {
      planId: p.id,
      planName: p.name,
      termMonths: p.termMonths,
      visitsPerTerm: p.visitsPerTerm,
      priceCents: priceCents ?? p.priceCents,
      billingFrequency: p.billingFrequency,
      serviceType: p.serviceType,
    };
  }

  // Plans -----------------------------------------------------------------------------

  app.get(
    "/plans",
    {
      config: { permission: "contracts:read" },
      schema: { tags: ["plans"], summary: "List maintenance plans", response: { 200: z.object({ items: z.array(plan) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const rows = await db
        .selectFrom("plans")
        .select(PLAN_COLUMNS)
        .where("organizationId", "=", organizationId)
        .orderBy("active", "desc")
        .orderBy("name")
        .execute();
      return { items: rows.map(jsonRow) };
    },
  );

  app.post(
    "/plans",
    {
      config: { permission: "contracts:write" },
      schema: { tags: ["plans"], summary: "Create a maintenance plan", body: planInput, response: { 201: plan } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const row = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("plans")
          .values({ ...req.body, organizationId })
          .returning(PLAN_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "plan.created", entityType: "plan", entityId: created.id, changes: req.body });
        return created;
      });
      return reply.status(201).send(jsonRow(row));
    },
  );

  app.patch(
    "/plans/:id",
    {
      config: { permission: "contracts:write" },
      schema: { tags: ["plans"], summary: "Update a plan (existing contracts keep their terms)", params, body: planPatch, response: { 200: plan } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const row = await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("plans")
          .set({ ...definedOnly(req.body), updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning(PLAN_COLUMNS)
          .executeTakeFirst()
          .catch((err) => {
            // A partial edit can still break the term/visits rule against stored values.
            if ((err as { code?: string }).code === "23514") throw unprocessable("Visits must split the term into whole months");
            throw err;
          });
        if (!updated) throw notFound("Plan");
        await audit(trx, req, { action: "plan.updated", entityType: "plan", entityId: updated.id, changes: req.body });
        return updated;
      });
      return jsonRow(row);
    },
  );

  // Contracts -------------------------------------------------------------------------

  app.get(
    "/sites/:id/contracts",
    {
      config: { permission: "contracts:read" },
      schema: { tags: ["contracts"], summary: "A site's contracts, newest first, with their visits", params, response: { 200: z.object({ items: z.array(contractDetail) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const site = await db
        .selectFrom("sites")
        .select("id")
        .where("organizationId", "=", organizationId)
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!site) throw notFound("Site");
      const [rows, obligations, asOf] = await Promise.all([
        contractQuery(organizationId).where("c.siteId", "=", site.id).orderBy("c.startOn", "desc").execute(),
        db
          .selectFrom("serviceObligations as o")
          .select(OBLIGATION_COLUMNS)
          .where("o.organizationId", "=", organizationId)
          .where("o.siteId", "=", site.id)
          .orderBy("o.sequence")
          .execute(),
        today(organizationId),
      ]);
      return {
        items: rows.map((row) => ({
          ...toContract({ ...row, renewedById: row.renewedById ?? null }, asOf),
          obligations: obligations.filter((o) => o.contractId === row.id).map(jsonRow),
        })),
      };
    },
  );

  app.post(
    "/sites/:id/contracts",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["contracts"],
        summary: "Start a contract on a site and generate its inspection visits",
        params,
        body: contractInput,
        response: { 201: contractDetail },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const site = await db
        .selectFrom("sites")
        .select(["id", "active"])
        .where("organizationId", "=", organizationId)
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!site) throw notFound("Site");
      if (!site.active) throw unprocessable("This site is inactive");
      const terms = await activePlanTerms(organizationId, req.body.planId, req.body.priceCents);
      const contractId = await db.transaction().execute(async (trx) => {
        const created = await insertContract(trx, organizationId, {
          siteId: site.id,
          startOn: req.body.startOn,
          terms,
          autoRenew: req.body.autoRenew,
          notes: req.body.notes,
        });
        await audit(trx, req, { action: "contract.created", entityType: "contract", entityId: created, changes: req.body });
        return created;
      });
      return reply.status(201).send(await loadContractDetail(organizationId, contractId));
    },
  );

  app.get(
    "/contracts/:id",
    {
      config: { permission: "contracts:read" },
      schema: { tags: ["contracts"], summary: "A contract with its inspection visits", params, response: { 200: contractDetail } },
    },
    async (req) => loadContractDetail(req.requireAuth().organizationId, req.params.id),
  );

  app.post(
    "/contracts/:id/renew",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["contracts"],
        summary: "Create the next term, starting the day after this one ends",
        description: "The renewed contract is left unchanged as history. Renewal campaigns, e-signature and payment are separate modules.",
        params,
        body: renewInput,
        response: { 201: contractDetail },
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const prev = await contractQuery(organizationId).where("c.id", "=", req.params.id).executeTakeFirst();
      if (!prev) throw notFound("Contract");
      if (prev.status === "cancelled") throw unprocessable("A cancelled contract cannot be renewed");
      if (prev.renewedById) throw new HttpError(409, "already_renewed", "This contract has already been renewed");
      const terms: Terms = req.body.planId
        ? await activePlanTerms(organizationId, req.body.planId, req.body.priceCents)
        : {
            planId: prev.planId,
            planName: prev.planName,
            termMonths: prev.termMonths,
            visitsPerTerm: prev.visitsPerTerm,
            priceCents: req.body.priceCents ?? prev.priceCents,
            billingFrequency: prev.billingFrequency,
            serviceType: prev.serviceType,
          };
      const contractId = await db.transaction().execute(async (trx) => {
        const created = await insertContract(trx, organizationId, {
          siteId: prev.siteId,
          startOn: addDays(prev.endOn, 1),
          terms,
          autoRenew: prev.autoRenew,
          previousContractId: prev.id,
        });
        await audit(trx, req, {
          action: "contract.renewed",
          entityType: "contract",
          entityId: created,
          changes: { ...req.body, previousContractId: prev.id },
        });
        return created;
      });
      return reply.status(201).send(await loadContractDetail(organizationId, contractId));
    },
  );

  app.post(
    "/contracts/:id/cancel",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["contracts"],
        summary: "Cancel a contract and its remaining open visits",
        params,
        body: cancelInput,
        response: { 200: contractDetail },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("contracts")
          .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: req.body.reason, updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .where("status", "=", "active")
          .returning("id")
          .executeTakeFirst();
        if (!updated) {
          const exists = await trx
            .selectFrom("contracts")
            .select("id")
            .where("organizationId", "=", organizationId)
            .where("id", "=", req.params.id)
            .executeTakeFirst();
          if (!exists) throw notFound("Contract");
          throw new HttpError(409, "already_cancelled", "This contract is already cancelled");
        }
        // Completed visits stay as history.
        await trx
          .updateTable("serviceObligations")
          .set({ status: "cancelled", updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("contractId", "=", updated.id)
          .where("status", "=", "open")
          .execute();
        await audit(trx, req, { action: "contract.cancelled", entityType: "contract", entityId: updated.id, changes: req.body });
      });
      return loadContractDetail(organizationId, req.params.id);
    },
  );

  // Due inspections -------------------------------------------------------------------

  app.get(
    "/obligations/due",
    {
      config: { permission: "contracts:read" },
      schema: {
        tags: ["obligations"],
        summary: "Open inspection visits due by a date, overdue first",
        querystring: dueQuery,
        response: { 200: z.object({ items: z.array(dueObligation), total: z.number().int(), today: z.iso.date() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const asOf = await today(organizationId);
      const { through = addDays(asOf, 30), siteId, overdueOnly, unscheduledOnly, limit, offset } = req.query;
      let base = db
        .selectFrom("serviceObligations as o")
        .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "o.siteId").onRef("s.organizationId", "=", "o.organizationId"))
        .innerJoin("customers as cu", (j) => j.onRef("cu.id", "=", "s.customerId").onRef("cu.organizationId", "=", "s.organizationId"))
        .leftJoin("jobs as j", (join) =>
          join
            .onRef("j.obligationId", "=", "o.id")
            .onRef("j.organizationId", "=", "o.organizationId")
            .on("j.status", "<>", "cancelled"),
        )
        .leftJoin("users as tu", "tu.id", "j.technicianUserId")
        .where("o.organizationId", "=", organizationId)
        .where("o.status", "=", "open")
        .where("o.dueOn", "<=", through);
      if (siteId) base = base.where("o.siteId", "=", siteId);
      if (overdueOnly) base = base.where("o.dueOn", "<", asOf);
      if (unscheduledOnly) base = base.where("j.id", "is", null);
      const [rows, count] = await Promise.all([
        base
          .select(OBLIGATION_COLUMNS)
          .select([
            "s.addressLine1",
            "s.city",
            "s.safetyFlags",
            "s.schedulingNotes",
            "cu.id as customerId",
            "cu.displayName as customerName",
            "j.id as jobId",
            "j.scheduledDate as jobDate",
            "j.technicianUserId as jobTechnicianId",
            "tu.name as jobTechnicianName",
          ])
          .orderBy("o.dueOn")
          .orderBy("o.id")
          .limit(limit)
          .offset(offset)
          .execute(),
        base.select(sql<number>`count(*)::int`.as("total")).executeTakeFirstOrThrow(),
      ]);
      return {
        today: asOf,
        total: count.total,
        items: rows.map(({ addressLine1, city, safetyFlags, schedulingNotes, customerId, customerName, jobId, jobDate, jobTechnicianId, jobTechnicianName, ...o }) => ({
          ...obligation.parse(jsonRow(o)),
          overdue: o.dueOn < asOf,
          job:
            jobId && jobDate && jobTechnicianId
              ? { id: jobId, scheduledDate: jobDate, technicianId: jobTechnicianId, technicianName: jobTechnicianName ?? "" }
              : null,
          site: { id: o.siteId, addressLine1, city, safetyFlags, schedulingNotes },
          customer: { id: customerId, displayName: customerName },
        })),
      };
    },
  );
};
