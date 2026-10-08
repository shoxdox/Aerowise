import type { Database } from "@aerowise/db";
import { coverageReasonInput, id, workOrderCoverage, type Feature } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { declineCoverage, reserveCoverage, restoreCoverage, workOrderCoverage as loadCoverage } from "../lib/coverage.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { lockWorkOrder } from "../lib/work-orders.ts";

// Plan coverage on work orders (SW-8, service workflows plan §4.3): what the contract at the
// site covers, applying it (a reservation against each rule's limit), declining it before
// billing and restoring a billed benefit. Office only: technicians see "covered" or not on
// the work order, never prices.

const params = z.object({ id });

export const coverageRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; features: ReadonlySet<Feature> }> = async (app, { db, now, features }) => {
  const planBuilder = features.has("plan_builder");

  app.get(
    "/work-orders/:id/coverage",
    {
      config: { permission: "work:write" },
      schema: { tags: ["work"], summary: "What the site's contract covers for this work order, and what it has used", params, response: { 200: workOrderCoverage } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      // Another company's work order is not found.
      const wo = await db.selectFrom("workOrders").select("id").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!wo) throw notFound("Work order");
      return loadCoverage(db, organizationId, req.params.id, { canApply: planBuilder });
    },
  );

  app.post(
    "/work-orders/:id/coverage/apply",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["work"],
        summary: "Apply the contract's coverage: reserve one use of each rule that fits and has room left",
        description: "A rule already at its limit is not reserved; the work it would cover is billed as usual. Needs the plan builder (409 `feature_off` otherwise).",
        params,
        body: z.object({}).optional(),
        response: { 200: workOrderCoverage },
      },
    },
    async (req) => {
      if (!planBuilder) throw new HttpError(409, "feature_off", "The plan builder is not switched on for this deployment");
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const wo = await lockWorkOrder(trx, organizationId, req.params.id);
        const r = await reserveCoverage(trx, req, organizationId, wo.id, now());
        await audit(trx, req, { action: "work_order.coverage_applied", entityType: "work_order", entityId: wo.id, changes: r });
      });
      return loadCoverage(db, organizationId, req.params.id, { canApply: planBuilder });
    },
  );

  app.post(
    "/work-orders/:id/coverage/decline",
    {
      config: { permission: "work:write" },
      schema: { tags: ["work"], summary: "Don't apply coverage to this work after all (before it is billed)", params, body: coverageReasonInput, response: { 200: workOrderCoverage } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const wo = await lockWorkOrder(trx, organizationId, req.params.id);
        await declineCoverage(trx, req, organizationId, wo.id, req.body.reason, now());
        await audit(trx, req, { action: "work_order.coverage_declined", entityType: "work_order", entityId: wo.id, changes: req.body });
      });
      return loadCoverage(db, organizationId, req.params.id, { canApply: planBuilder });
    },
  );

  app.post(
    "/work-orders/:id/coverage/restore",
    {
      config: { permission: "work:write" },
      schema: {
        tags: ["work"],
        summary: "Restore a billed benefit, for example after a refund",
        description: "Refunds never give a use back by themselves: the service was performed. This gives it back, with a reason.",
        params,
        body: coverageReasonInput,
        response: { 200: workOrderCoverage },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const wo = await lockWorkOrder(trx, organizationId, req.params.id);
        await restoreCoverage(trx, req, organizationId, wo.id, req.body.reason, now());
        await audit(trx, req, { action: "work_order.coverage_restored", entityType: "work_order", entityId: wo.id, changes: req.body });
      });
      return loadCoverage(db, organizationId, req.params.id, { canApply: planBuilder });
    },
  );
};
