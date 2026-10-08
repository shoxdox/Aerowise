import { openContractFiling } from "@aerowise/compliance";
import type { Database, DB } from "@aerowise/db";
import { agreementCycles, agreementPreview, coverageItemNames, coverageLines, loadPlanVersion, MoreVisitsRequired, siteVisitTerms, type ContractCycles } from "@aerowise/renewals";
import { FORM_COLUMNS, toForm } from "../lib/forms.ts";
import { cancelOpenVisits } from "@aerowise/tasks";
import {
  addDays,
  cancelInput,
  contractDetail,
  contractInput,
  contractTermsPreview,
  contractState,
  coverageSummary,
  buildIntervalSchedule,
  cycleSummary,
  cycleWithoutVisit,
  DEFAULT_RENEWAL_TERMS,
  parseServiceCycles,
  workOrderLabel,
  formTemplate,
  intakeFormInput,
  keyAllowedForPurpose,
  parseSnapshotOptions,
  type PlanOption,
  parseCoverageRules,
  parsePlanOptions,
  planDetail,
  planVersionInput,
  type Feature,
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
import { requireSystemConfirmation, siteSystemWarning } from "../lib/system-categories.ts";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { usedCounts } from "../lib/coverage.ts";
import { definedOnly, jsonRow } from "../lib/json.ts";
import { insertContract, type Terms } from "../lib/contracts.ts";
import { organizationToday } from "../lib/today.ts";

const PLAN_COLUMNS = [
  "p.id",
  "p.name",
  "p.customerType",
  "p.termMonths",
  "p.visitsPerTerm",
  "p.priceCents",
  "p.billingFrequency",
  "p.serviceType",
  "p.active",
  "p.currentVersionId",
  "v.version",
  "p.createdAt",
] as const;

const CONTRACT_COLUMNS = [
  "c.id",
  "c.siteId",
  "c.planId",
  "c.planName",
  "c.customerType",
  "c.startOn",
  "c.endOn",
  "c.termMonths",
  "c.visitsPerTerm",
  "c.priceCents",
  "c.billingFrequency",
  "c.serviceType",
  "c.autoRenew",
  "c.status",
  "c.previousContractId",
  "c.cancelledAt",
  "c.cancelReason",
  "c.serviceEndsOn",
  "c.discontinuedBy",
  "c.providerCredentialId",
  "c.planVersionId",
  "c.notes",
  "c.createdAt",
] as const;

const OBLIGATION_COLUMNS = [
  "o.id",
  "o.contractId",
  "o.siteId",
  "o.serviceType",
  "y.cycleKey",
  "o.sequence",
  "o.windowStart",
  "o.windowEnd",
  "o.dueOn",
  "o.status",
  "o.completedAt",
  "wo.id as workOrderId",
  "wo.number as workOrderNumber",
  "wo.status as workOrderStatus",
] as const;

/** Visits with their cycle and, for pumping or maintenance, the work order they are done as (SW-9). */
const obligationsFrom = (ex: Database) =>
  ex
    .selectFrom("serviceObligations as o")
    .innerJoin("contractServiceCycles as y", (j) => j.onRef("y.id", "=", "o.cycleId").onRef("y.organizationId", "=", "o.organizationId"))
    .leftJoin("workOrders as wo", (j) => j.onRef("wo.obligationId", "=", "o.id").onRef("wo.organizationId", "=", "o.organizationId").on("wo.status", "<>", "cancelled"));

const toObligation = <T extends { workOrderId: string | null; workOrderNumber: number | null; workOrderStatus: string | null }>({ workOrderId, workOrderNumber, workOrderStatus, ...o }: T) => ({
  ...jsonRow(o),
  workOrder: workOrderId && workOrderNumber !== null ? { id: workOrderId, label: workOrderLabel(workOrderNumber), status: workOrderStatus! } : null,
});

const params = z.object({ id });

export const contractRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; features?: ReadonlySet<Feature> }> = async (app, { db, now, features = new Set() }) => {
  const today = (organizationId: string) => organizationToday(db, organizationId, now());
  const planBuilder = features.has("plan_builder");
  const serviceCyclesOn = features.has("service_cycles");

  /** Plans with the number of their current version. */
  const planQuery = (ex: Database | Transaction<DB>, organizationId: string) =>
    ex
      .selectFrom("plans as p")
      .innerJoin("planVersions as v", "v.id", "p.currentVersionId")
      .select(PLAN_COLUMNS)
      .where("p.organizationId", "=", organizationId);

  /**
   * With the plan builder on (SW-8), a contract the office makes takes its version's coverage
   * rules, frozen, and a record of the terms that apply. Off, it is made exactly as before.
   */
  async function planContent(ex: Database | Transaction<DB>, organizationId: string, planVersionId: string | null | undefined, optionKeys?: string[]) {
    const cycles = await planCycles(ex, organizationId, planVersionId);
    const withCycles = cycles ? { cycles } : {};
    if (!planBuilder) {
      if (optionKeys?.length) throw new HttpError(409, "feature_off", "Plan options need the plan builder, which is not switched on for this deployment");
      return withCycles;
    }
    const v = planVersionId ? await loadPlanVersion(ex, organizationId, planVersionId) : null;
    if (!v) {
      if (optionKeys?.length) throw unprocessable("This plan offers no options");
      return withCycles;
    }
    const unknown = (optionKeys ?? []).filter((k) => !v.options.some((o) => o.optionKey === k));
    if (unknown.length) throw unprocessable(`The plan has no option ${unknown.map((k) => `"${k}"`).join(", ")}`);
    // Required options always, and what the office ticked; nothing else is charged unasked.
    const options: PlanOption[] = v.options.filter((o) => o.required || !!optionKeys?.includes(o.optionKey));
    const org = await ex.selectFrom("organizations").select("renewalTerms").where("id", "=", organizationId).executeTakeFirstOrThrow();
    return {
      coverage: v.coverage,
      agreementSnapshot: {
        format: 1,
        signed: false,
        plan: { versionId: v.id, version: v.version, termsSource: v.termsText ? "plan" : "organization" },
        terms: v.termsText ?? org.renewalTerms ?? DEFAULT_RENEWAL_TERMS,
        coverage: await coverageLines(ex, organizationId, v.coverage),
        // Only when some were taken, so a snapshot without options reads as it did before.
        ...(options.length ? { options } : {}),
        // Only with pumping or maintenance (SW-9), likewise.
        ...(cycles ? { cycles: agreementCycles(v) } : {}),
      },
      ...withCycles,
    };
  }

  /**
   * The cycles a contract made from this version takes (SW-9), or undefined for an
   * inspection-only one (made exactly as before). With service cycles off, a version's
   * pumping or maintenance cycles are left out, and a version with no inspections is refused.
   */
  async function planCycles(ex: Database | Transaction<DB>, organizationId: string, planVersionId: string | null | undefined): Promise<ContractCycles | undefined> {
    if (!planVersionId) return undefined;
    const row = await ex.selectFrom("planVersions").select("serviceCycles").where("organizationId", "=", organizationId).where("id", "=", planVersionId).executeTakeFirst();
    if (!row) return undefined;
    const { aerobic, cycles } = parseServiceCycles(row.serviceCycles);
    if (aerobic && !cycles.length) return undefined;
    if (!serviceCyclesOn) {
      if (!aerobic) throw new HttpError(409, "feature_off", "This plan is pumping or maintenance only, and service cycles are not switched on for this deployment");
      return undefined;
    }
    return { aerobic: !!aerobic, serviceCycles: cycles };
  }

  /** A contract's frozen cycles, as the office sees them. */
  async function contractCycles(organizationId: string, contractIds: string[]) {
    if (!contractIds.length) return [];
    const rows = await db
      .selectFrom("contractServiceCycles as y")
      .leftJoin("workTypes as t", (j) => j.onRef("t.id", "=", "y.workTypeId").onRef("t.organizationId", "=", "y.organizationId"))
      .select(["y.id", "y.contractId", "y.cycleKey", "y.serviceType", "y.schedule", "y.snapshot", "t.id as workTypeId", "t.name as workTypeName"])
      .where("y.organizationId", "=", organizationId)
      .where("y.contractId", "in", contractIds)
      .orderBy(sql`y.service_type <> 'aerobic_inspection'`)
      .orderBy("y.cycleKey")
      .execute();
    return rows.map((r) => ({
      contractId: r.contractId,
      id: r.id,
      cycleKey: r.cycleKey,
      serviceType: r.serviceType,
      label: (r.snapshot as { label?: string }).label ?? "Aerobic inspections",
      workType: r.workTypeId ? { id: r.workTypeId, name: r.workTypeName ?? "" } : null,
      summary: cycleSummary(r),
    }));
  }

  /** Each contract's frozen coverage rules with their use this term, and the version it was made from. */
  async function contractPlanFacts(organizationId: string, contracts: { id: string; planVersionId: string | null }[]) {
    const ids = contracts.map((c) => c.id);
    const versionIds = [...new Set(contracts.flatMap((c) => (c.planVersionId ? [c.planVersionId] : [])))];
    const [rules, versions, snapshots] = await Promise.all([
      ids.length ? db.selectFrom("contractCoverageRules").select(["id", "contractId", "ruleKey", "rule", "limitCount"]).where("organizationId", "=", organizationId).where("contractId", "in", ids).orderBy("position").execute() : [],
      versionIds.length ? db.selectFrom("planVersions").select(["id", "version"]).where("organizationId", "=", organizationId).where("id", "in", versionIds).execute() : [],
      ids.length ? db.selectFrom("contracts").select(["id", "agreementSnapshot"]).where("organizationId", "=", organizationId).where("id", "in", ids).execute() : [],
    ]);
    const optionsOf = new Map(snapshots.map((c) => [c.id, parseSnapshotOptions(c.agreementSnapshot)]));
    const parsed = rules.map((r) => ({ ...r, rule: parseCoverageRules([r.rule])[0]! }));
    const [used, names] = await Promise.all([usedCounts(db, organizationId, rules.map((r) => r.id)), coverageItemNames(db, organizationId, parsed.map((r) => r.rule))]);
    return (c: { id: string; planVersionId: string | null }) => ({
      planVersion: versions.find((v) => v.id === c.planVersionId) ?? null,
      coverage: parsed
        .filter((r) => r.contractId === c.id)
        .map((r) => ({
          id: r.id,
          ruleKey: r.ruleKey,
          label: r.rule.label,
          summary: coverageSummary(r.rule, "serviceItemId" in r.rule.match ? names.get(r.rule.match.serviceItemId) : undefined),
          limit: r.limitCount,
          used: used.get(r.id) ?? 0,
        })),
      options: (optionsOf.get(c.id) ?? []).map((o) => ({ optionKey: o.optionKey, name: o.name, priceCents: o.priceCents, taxable: o.taxable })),
    });
  }

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
      // The latest renewal of this contract, if one has been started.
      .select((eb) =>
        eb.selectFrom("renewals as rn").select("rn.id").whereRef("rn.contractId", "=", "c.id").orderBy("rn.createdAt", "desc").limit(1).as("renewalId"),
      )
      .select((eb) =>
        eb.fn
          .coalesce(eb.selectFrom("renewals as rn").select("rn.status").whereRef("rn.contractId", "=", "c.id").orderBy("rn.createdAt", "desc").limit(1), eb.val("not_started"))
          .as("renewalStatus"),
      )
      .where("c.organizationId", "=", organizationId);

  const toContract = <T extends { status: "active" | "cancelled"; startOn: string; endOn: string; cancelledAt: Date | null; createdAt: Date }>(
    row: T,
    asOf: string,
  ) => ({ ...jsonRow(row), state: contractState(row, asOf) });

  // Inspections first, then each other cycle; each in its own order.
  const loadObligations = (organizationId: string, contractId: string) =>
    obligationsFrom(db)
      .select(OBLIGATION_COLUMNS)
      .where("o.organizationId", "=", organizationId)
      .where("o.contractId", "=", contractId)
      .orderBy(sql`o.service_type <> 'aerobic_inspection'`)
      .orderBy("y.cycleKey")
      .orderBy("o.sequence")
      .execute()
      .then((rows) => rows.map(toObligation));

  async function loadContractDetail(organizationId: string, contractId: string) {
    const row = await contractQuery(organizationId).where("c.id", "=", contractId).executeTakeFirst();
    if (!row) throw notFound("Contract");
    const [obligations, asOf, facts, cycles] = await Promise.all([loadObligations(organizationId, row.id), today(organizationId), contractPlanFacts(organizationId, [row]), contractCycles(organizationId, [row.id])]);
    return {
      ...toContract({ ...row, renewedById: row.renewedById ?? null, renewalId: row.renewalId ?? null }, asOf),
      obligations,
      cycles: cycles.map(({ contractId: _, ...c }) => c),
      ...facts(row),
    };
  }

  async function activePlanTerms(organizationId: string, planId: string, priceCents?: number): Promise<Terms> {
    const p = await db
      .selectFrom("plans")
      .select(["id", "name", "customerType", "termMonths", "visitsPerTerm", "priceCents", "billingFrequency", "serviceType", "active", "currentVersionId"])
      .where("organizationId", "=", organizationId)
      .where("id", "=", planId)
      .executeTakeFirst();
    if (!p) throw unprocessable("planId does not match a plan in this organization");
    if (!p.active) throw unprocessable("That plan is no longer offered");
    return {
      planId: p.id,
      planName: p.name,
      customerType: p.customerType,
      termMonths: p.termMonths,
      visitsPerTerm: p.visitsPerTerm,
      priceCents: priceCents ?? p.priceCents,
      billingFrequency: p.billingFrequency,
      serviceType: p.serviceType,
      planVersionId: p.currentVersionId,
    };
  }

  // Plans -----------------------------------------------------------------------------

  const planRow = (ex: Database | Transaction<DB>, organizationId: string, planId: string) => planQuery(ex, organizationId).where("p.id", "=", planId).executeTakeFirst();

  async function loadPlanDetail(organizationId: string, planId: string) {
    const p = await planRow(db, organizationId, planId);
    if (!p) throw notFound("Plan");
    const [versions, current, org] = await Promise.all([
      db
        .selectFrom("planVersions as v")
        .select([
          "v.id",
          "v.planId",
          "v.version",
          "v.name",
          "v.customerType",
          "v.termsText",
          "v.termMonths",
          "v.visitsPerTerm",
          "v.priceCents",
          "v.billingFrequency",
          "v.serviceType",
          "v.options",
          "v.coverage",
          "v.intakeTemplateId",
          "v.serviceCycles",
          "v.createdAt",
          (eb) => eb.selectFrom("contracts as c").select(sql<number>`count(*)::int`.as("n")).whereRef("c.planVersionId", "=", "v.id").as("contracts"),
          (eb) => eb.selectFrom("renewals as r").select(sql<number>`count(*)::int`.as("n")).whereRef("r.planVersionId", "=", "v.id").as("renewals"),
        ])
        .where("v.organizationId", "=", organizationId)
        .where("v.planId", "=", p.id)
        .orderBy("v.version", "desc")
        .execute(),
      loadPlanVersion(db, organizationId, p.currentVersionId),
      db.selectFrom("organizations").select("renewalTerms").where("id", "=", organizationId).executeTakeFirstOrThrow(),
    ]);
    const intakeIds = [...new Set(versions.flatMap((v) => (v.intakeTemplateId ? [v.intakeTemplateId] : [])))];
    const intakeForms = intakeIds.length ? await db.selectFrom("inspectionTemplates").select(["id", "key", "version", "name"]).where("id", "in", intakeIds).execute() : [];
    return {
      ...jsonRow(p),
      versions: versions.map(({ intakeTemplateId, serviceCycles, ...v }) => ({
        ...jsonRow(v),
        aerobic: parseServiceCycles(serviceCycles).aerobic !== null,
        serviceCycles: parseServiceCycles(serviceCycles).cycles,
        intake: intakeForms.find((f) => f.id === intakeTemplateId) ?? null,
        options: parsePlanOptions(v.options),
        coverage: parseCoverageRules(v.coverage),
        contracts: Number(v.contracts ?? 0),
        renewals: Number(v.renewals ?? 0),
      })),
      preview: await agreementPreview(db, organizationId, current!, org.renewalTerms),
    };
  }

  app.get(
    "/plans",
    {
      config: { permission: "contracts:read" },
      schema: { tags: ["plans"], summary: "List maintenance plans", response: { 200: z.object({ items: z.array(plan) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const rows = await planQuery(db, organizationId).orderBy("p.active", "desc").orderBy("p.name").execute();
      return { items: rows.map(jsonRow) };
    },
  );

  app.post(
    "/plans",
    {
      config: { permission: "contracts:write" },
      schema: { tags: ["plans"], summary: "Create a maintenance plan (its version 1 is made with it)", body: planInput, response: { 201: plan } },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const row = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("plans")
          .values({ ...req.body, organizationId })
          .returning("id")
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "plan.created", entityType: "plan", entityId: created.id, changes: req.body });
        return (await planRow(trx, organizationId, created.id))!;
      });
      return reply.status(201).send(jsonRow(row));
    },
  );

  app.get(
    "/plans/:id",
    {
      config: { permission: "contracts:read" },
      schema: { tags: ["plans"], summary: "A plan with its versions and what its current version has a customer sign", params, response: { 200: planDetail } },
    },
    async (req) => loadPlanDetail(req.requireAuth().organizationId, req.params.id),
  );

  app.patch(
    "/plans/:id",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["plans"],
        summary: "Update a plan (existing contracts keep their terms)",
        description: "A change to its name, term, visits, price, billing or customer type makes a new version, keeping the current version's terms, options and coverage.",
        params,
        body: planPatch,
        response: { 200: plan },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const row = await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("plans")
          .set({ ...definedOnly(req.body), updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning("id")
          .executeTakeFirst()
          .catch((err) => {
            // A partial edit can still break the term/visits rule against stored values.
            if ((err as { code?: string }).code === "23514") throw unprocessable("Visits must split the term into whole months");
            throw err;
          });
        if (!updated) throw notFound("Plan");
        await audit(trx, req, { action: "plan.updated", entityType: "plan", entityId: updated.id, changes: req.body });
        return (await planRow(trx, organizationId, updated.id))!;
      });
      return jsonRow(row);
    },
  );

  app.post(
    "/plans/:id/versions",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["plans"],
        summary: "Save new terms, options or coverage for a plan as its next version",
        description:
          "Earlier versions never change. Contracts already made keep the coverage they were made with; new contracts and renewal offers made from now on take this version. Needs the plan builder (409 `feature_off` otherwise).",
        params,
        body: planVersionInput,
        response: { 201: planDetail },
      },
    },
    async (req, reply) => {
      if (!planBuilder) throw new HttpError(409, "feature_off", "The plan builder is not switched on for this deployment");
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      await db.transaction().execute(async (trx) => {
        // Locked, so two saves at once make versions one after the other.
        const p = await trx.selectFrom("plans").select(["id", "currentVersionId"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).forUpdate().executeTakeFirst();
        if (!p) throw notFound("Plan");
        const itemIds = [...new Set(b.coverage.flatMap((r) => ("serviceItemId" in r.match ? [r.match.serviceItemId] : [])))];
        if (itemIds.length) {
          const found = await trx.selectFrom("serviceItems").select("id").where("organizationId", "=", organizationId).where("id", "in", itemIds).execute();
          if (found.length !== itemIds.length) throw unprocessable("A coverage rule names a catalog item that is not in this company's catalog");
        }
        if (b.intakeTemplateId) {
          const form = await trx
            .selectFrom("inspectionTemplates")
            .select("id")
            .where("id", "=", b.intakeTemplateId)
            .where("purpose", "=", "intake")
            .where((eb) => eb.or([eb("organizationId", "is", null), eb("organizationId", "=", organizationId)]))
            .executeTakeFirst();
          if (!form) throw unprocessable("intakeTemplateId is not one of this company's intake forms");
        }
        const cur = await trx.selectFrom("planVersions").selectAll().where("id", "=", p.currentVersionId).executeTakeFirstOrThrow();
        const serviceCycles = await versionCycles(trx, organizationId, cur, b);
        const created = await trx
          .insertInto("planVersions")
          .values({
            organizationId,
            planId: p.id,
            version: sql<number>`(select max(version) + 1 from plan_versions where plan_id = ${p.id})`,
            name: cur.name,
            customerType: cur.customerType,
            termMonths: cur.termMonths,
            visitsPerTerm: cur.visitsPerTerm,
            priceCents: cur.priceCents,
            billingFrequency: cur.billingFrequency,
            serviceType: cur.serviceType,
            termsText: b.termsText,
            options: JSON.stringify(b.options),
            coverage: JSON.stringify(b.coverage),
            serviceCycles: JSON.stringify(serviceCycles),
            intakeTemplateId: b.intakeTemplateId,
            createdBy: userId,
          })
          .returning(["id", "version"])
          .executeTakeFirstOrThrow();
        await trx.updateTable("plans").set({ currentVersionId: created.id, updatedAt: now() }).where("id", "=", p.id).execute();
        await audit(trx, req, { action: "plan.version_created", entityType: "plan", entityId: p.id, changes: { version: created.version, ...b } });
      });
      return reply.status(201).send(await loadPlanDetail(organizationId, req.params.id));
    },
  );

  /**
   * The cycles a new version has (SW-9). Without `serviceCycles` or `aerobic` in the save, the
   * current version's are kept as they are, so a builder that does not know about cycles
   * never drops them. Otherwise the inspection cycle follows the plan's own visits.
   */
  async function versionCycles(trx: Transaction<DB>, organizationId: string, cur: { serviceCycles: unknown; serviceType: string; visitsPerTerm: number; termMonths: number }, b: z.infer<typeof planVersionInput>) {
    if (b.serviceCycles === undefined && b.aerobic === undefined) return cur.serviceCycles;
    const current = parseServiceCycles(cur.serviceCycles);
    const aerobic = b.aerobic ?? current.aerobic !== null;
    const cycles = b.serviceCycles ?? current.cycles;
    if ((cycles.length || !aerobic) && !serviceCyclesOn) throw new HttpError(409, "feature_off", "Pumping and maintenance cycles are not switched on for this deployment");
    if (!aerobic && !cycles.length) throw unprocessable("A plan without inspections needs at least one pumping or maintenance cycle");
    const problems = cycles.map((c) => cycleWithoutVisit(c, cur.termMonths)).filter((m): m is string => m !== null);
    if (problems.length) throw unprocessable(problems.join(" "));
    const typeIds = [...new Set(cycles.map((c) => c.workTypeId))];
    const types = typeIds.length ? await trx.selectFrom("workTypes").select(["id", "category", "active"]).where("organizationId", "=", organizationId).where("id", "in", typeIds).execute() : [];
    for (const c of cycles) {
      const t = types.find((x) => x.id === c.workTypeId);
      if (!t) throw unprocessable(`"${c.label}" names a kind of work that is not this company's`);
      if (!t.active) throw unprocessable(`"${c.label}" names a kind of work that is no longer offered`);
      // A pumping cycle is booked as pumping work, a maintenance cycle as maintenance work.
      if (t.category !== c.serviceType) throw unprocessable(`"${c.label}" is a ${c.serviceType} cycle, so its kind of work must be ${c.serviceType} work`);
    }
    return [...(aerobic ? [{ cycleKey: "aerobic", serviceType: cur.serviceType, schedule: { kind: "visits_per_term", visitsPerTerm: cur.visitsPerTerm } }] : []), ...cycles];
  }

  app.post(
    "/intake-forms",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["plans"],
        summary: "Save a new version of an intake form a plan can ask at online signing",
        description:
          "An SW-F form with purpose `intake`: questions only, no photos or signatures. Versions never change; a plan version names the exact version it asks. List them with `GET /form-templates?purpose=intake`. Needs the plan builder (409 `feature_off` otherwise).",
        body: intakeFormInput,
        response: { 201: formTemplate },
      },
    },
    async (req, reply) => {
      if (!planBuilder) throw new HttpError(409, "feature_off", "The plan builder is not switched on for this deployment");
      const { organizationId, userId } = req.requireAuth();
      const b = req.body;
      if (!keyAllowedForPurpose(b.key, "intake")) throw new HttpError(409, "wrong_purpose", "That key belongs to the inspection form");
      const row = await db.transaction().execute(async (trx) => {
        // The lock every form version takes: one numbering per company (SW-F).
        await sql`select pg_advisory_xact_lock(hashtext(${`inspection_templates:${organizationId}`}))`.execute(trx);
        const same = await trx
          .selectFrom("inspectionTemplates")
          .select(["purpose", sql<number>`max(version)`.as("v")])
          .where((eb) => eb.or([eb("organizationId", "is", null), eb("organizationId", "=", organizationId)]))
          .where("key", "=", b.key)
          .groupBy("purpose")
          .execute();
        if (same.some((r) => r.purpose !== "intake")) throw new HttpError(409, "wrong_purpose", "That key is already used by a form that is not an intake form");
        const version = Math.max(0, ...same.map((r) => Number(r.v))) + 1;
        const created = await trx
          .insertInto("inspectionTemplates")
          .values({ organizationId, key: b.key, version, name: b.name, purpose: "intake", definition: JSON.stringify(b.definition), createdBy: userId })
          .returning(FORM_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "form_template.versioned", entityType: "inspection_template", entityId: created.id, changes: { key: b.key, version, purpose: "intake" } });
        return created;
      });
      return reply.status(201).send(toForm(row));
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
        obligationsFrom(db)
          .select(OBLIGATION_COLUMNS)
          .where("o.organizationId", "=", organizationId)
          .where("o.siteId", "=", site.id)
          .orderBy(sql`o.service_type <> 'aerobic_inspection'`)
          .orderBy("y.cycleKey")
          .orderBy("o.sequence")
          .execute(),
        today(organizationId),
      ]);
      const [facts, cycles] = await Promise.all([contractPlanFacts(organizationId, rows), contractCycles(organizationId, rows.map((r) => r.id))]);
      return {
        items: rows.map((row) => ({
          ...toContract({ ...row, renewedById: row.renewedById ?? null, renewalId: row.renewalId ?? null }, asOf),
          obligations: obligations.filter((o) => o.contractId === row.id).map(toObligation),
          cycles: cycles.filter((c) => c.contractId === row.id).map(({ contractId: _, ...c }) => c),
          ...facts(row),
        })),
      };
    },
  );

  app.get(
    "/sites/:id/contract-terms",
    {
      config: { permission: "contracts:read" },
      schema: {
        tags: ["contracts"],
        summary: "The visits a contract on this plan would get at this site, and a warning when its authority needs more than the plan has",
        params,
        querystring: z.object({ planId: id, startOn: z.iso.date() }),
        response: { 200: contractTermsPreview },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const site = await db.selectFrom("sites").select("id").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!site) throw notFound("Site");
      const terms = await activePlanTerms(organizationId, req.query.planId);
      // A pumping or maintenance only version (SW-9) gets its own cycles' visits: no authority
      // inspections are added and no aerobic system confirmation is asked.
      const cycles = await planCycles(db, organizationId, terms.planVersionId);
      if (cycles && !cycles.aerobic) {
        const visits = cycles.serviceCycles.reduce((n, c) => n + buildIntervalSchedule(req.query.startOn, terms.termMonths, c.schedule).length, 0);
        return { planVisits: visits, visitsPerTerm: visits, warning: null, scheduleNotice: null, systemWarning: null };
      }
      const { terms: t, added, scheduleNotice } = await siteVisitTerms(db, organizationId, site.id, req.query.startOn, terms);
      const systemWarning = await siteSystemWarning(db, organizationId, site.id, terms.serviceType);
      return { planVisits: terms.visitsPerTerm, visitsPerTerm: t.visitsPerTerm, warning: added ? new MoreVisitsRequired(added).message : null, scheduleNotice, systemWarning };
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
        const content = await planContent(trx, organizationId, terms.planVersionId, req.body.optionKeys);
        // SW-7: a warning the office confirms, never a hard refusal. Asked only for a contract
        // with aerobic inspections: a pumping or maintenance only version (SW-9) is not one.
        const effectiveType = content.cycles && !content.cycles.aerobic ? content.cycles.serviceCycles[0]!.serviceType : terms.serviceType;
        await requireSystemConfirmation(trx, organizationId, site.id, effectiveType, req.body.confirmSystemCategory);
        const created = await insertContract(trx, organizationId, {
          siteId: site.id,
          startOn: req.body.startOn,
          terms,
          autoRenew: req.body.autoRenew,
          notes: req.body.notes,
          ...content,
        }, { confirmExtraVisits: true, acceptVisits: req.body.acceptVisits });
        await audit(trx, req, { action: "contract.created", entityType: "contract", entityId: created, changes: req.body });
        // Opens a filing with the site's authority when it requires contracts on file.
        await openContractFiling(trx, { organizationId, contractId: created, actorUserId: req.requireAuth().userId, at: now() });
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
      if (prev.serviceEndsOn) throw unprocessable(`This contract is ending: service stops after ${prev.serviceEndsOn}`);
      if (prev.renewedById) throw new HttpError(409, "already_renewed", "This contract has already been renewed");
      const terms: Terms = req.body.planId
        ? await activePlanTerms(organizationId, req.body.planId, req.body.priceCents)
        : {
            planId: prev.planId,
            planName: prev.planName,
            customerType: prev.customerType,
            termMonths: prev.termMonths,
            visitsPerTerm: prev.visitsPerTerm,
            priceCents: req.body.priceCents ?? prev.priceCents,
            billingFrequency: prev.billingFrequency,
            serviceType: prev.serviceType,
            planVersionId: prev.planVersionId,
          };
      const contractId = await db.transaction().execute(async (trx) => {
        const created = await insertContract(trx, organizationId, {
          siteId: prev.siteId,
          startOn: addDays(prev.endOn, 1),
          terms,
          autoRenew: prev.autoRenew,
          previousContractId: prev.id,
          ...(await planContent(trx, organizationId, terms.planVersionId, req.body.optionKeys)),
        }, { confirmExtraVisits: true, acceptVisits: req.body.acceptVisits });
        await audit(trx, req, {
          action: "contract.renewed",
          entityType: "contract",
          entityId: created,
          changes: { ...req.body, previousContractId: prev.id },
        });
        await openContractFiling(trx, { organizationId, contractId: created, actorUserId: req.requireAuth().userId, at: now() });
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
        summary: "Cancel a contract and its remaining open visits, now or after a last day of service",
        description:
          "With a last day of service today or later, the contract stays active through that day with the visits that can start by then; the rest are cancelled now and the contract ends the day after. Without one (or with a past one), it is cancelled at once.",
        params,
        body: cancelInput,
        response: { 200: contractDetail },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const asOf = await today(organizationId);
      const current = await db.selectFrom("contracts").select("startOn").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!current) throw notFound("Contract");
      // A last day before the term starts means no service at all: cancel now.
      const endsLater = req.body.serviceEndsOn !== undefined && req.body.serviceEndsOn >= asOf && req.body.serviceEndsOn >= current.startOn;
      if (endsLater) {
        // Service continues through the last day: the contract stays active with the visits
        // due before then, and the sweep ends it the day after. Visits that cannot start
        // before the last day are cancelled now.
        await db.transaction().execute(async (trx) => {
          const updated = await trx
            .updateTable("contracts")
            .set({ cancelReason: req.body.reason, discontinuedBy: req.body.discontinuedBy ?? null, serviceEndsOn: req.body.serviceEndsOn!, updatedAt: new Date() })
            .where("organizationId", "=", organizationId)
            .where("id", "=", req.params.id)
            .where("status", "=", "active")
            .where("serviceEndsOn", "is", null)
            .returning("id")
            .executeTakeFirst();
          if (!updated) {
            const exists = await trx.selectFrom("contracts").select(["status", "serviceEndsOn"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
            if (!exists) throw notFound("Contract");
            throw new HttpError(409, "already_cancelled", exists.status === "cancelled" ? "This contract is already cancelled" : `This contract already ends after ${exists.serviceEndsOn}`);
          }
          await cancelOpenVisits(trx, { organizationId, contractIds: [updated.id], windowStartAfter: req.body.serviceEndsOn!, reason: `Service ends after ${req.body.serviceEndsOn}`, at: new Date() });
          await audit(trx, req, { action: "contract.ending_scheduled", entityType: "contract", entityId: updated.id, changes: req.body });
        });
        return loadContractDetail(organizationId, req.params.id);
      }
      await db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("contracts")
          .set({ status: "cancelled", cancelledAt: new Date(), cancelReason: req.body.reason, discontinuedBy: req.body.discontinuedBy ?? null, serviceEndsOn: req.body.serviceEndsOn ?? null, updatedAt: new Date() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .where("status", "=", "active")
          // An ending contract keeps its recorded last day; the sweep closes it after that.
          .where("serviceEndsOn", "is", null)
          .returning("id")
          .executeTakeFirst();
        if (!updated) {
          const exists = await trx
            .selectFrom("contracts")
            .select(["status", "serviceEndsOn"])
            .where("organizationId", "=", organizationId)
            .where("id", "=", req.params.id)
            .executeTakeFirst();
          if (!exists) throw notFound("Contract");
          throw new HttpError(409, "already_cancelled", exists.status === "cancelled" ? "This contract is already cancelled" : `This contract already ends after ${exists.serviceEndsOn}`);
        }
        // Completed visits stay as history; unstarted jobs leave the route.
        await cancelOpenVisits(trx, { organizationId, contractIds: [updated.id], reason: "Contract cancelled", at: new Date() });
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
        summary: "Open visits due by a date, overdue first: aerobic inspections unless another kind is asked for",
        querystring: dueQuery,
        response: { 200: z.object({ items: z.array(dueObligation), total: z.number().int(), today: z.iso.date() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const asOf = await today(organizationId);
      const { through = addDays(asOf, 30), siteId, overdueOnly, unscheduledOnly, serviceType, limit, offset } = req.query;
      let base = obligationsFrom(db)
        .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "o.siteId").onRef("s.organizationId", "=", "o.organizationId"))
        .innerJoin("customers as cu", (j) => j.onRef("cu.id", "=", "s.customerId").onRef("cu.organizationId", "=", "s.organizationId"))
        .leftJoin("jobs as j", (join) =>
          join
            .onRef("j.obligationId", "=", "o.id")
            .onRef("j.organizationId", "=", "o.organizationId")
            .on("j.type", "=", "inspection")
            .on("j.status", "<>", "cancelled"),
        )
        .leftJoin("users as tu", "tu.id", "j.technicianUserId")
        .where("o.organizationId", "=", organizationId)
        // One kind at a time (SW-9): the inspection list never shows pumping or maintenance.
        .where("o.serviceType", "=", serviceType)
        .where("o.status", "=", "open")
        .where("o.dueOn", "<=", through);
      if (siteId) base = base.where("o.siteId", "=", siteId);
      if (overdueOnly) base = base.where("o.dueOn", "<", asOf);
      // Not yet booked: no live inspection job, or for pumping and maintenance no work order.
      if (unscheduledOnly) base = base.where("j.id", "is", null).where("wo.id", "is", null);
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
          ...obligation.parse(toObligation(o)),
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
