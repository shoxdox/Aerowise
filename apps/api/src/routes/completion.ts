import type { Database } from "@aerowise/db";
import { id, workOrderLabel } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { completionSummaryPdf } from "../lib/completion.ts";

// SW-7: the office's copy of a work order's "Work completion summary". The homeowner's copy is
// in the portal (routes/portal.ts); both are made by lib/completion.ts.

export const completionRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  app.get(
    "/work-orders/:id/completion-summary.pdf",
    {
      config: { permission: "work:read" },
      schema: {
        tags: ["work"],
        summary: "The customer-facing work completion summary of a completed work order (PDF)",
        description: "Made from the work order's completed field records. It is not an inspection report and is never filed. 409 `not_completed` until the work is done.",
        params: z.object({ id }),
      },
    },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const pdf = await completionSummaryPdf(db, organizationId, req.params.id, now());
      const wo = await db.selectFrom("workOrders").select("number").where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirstOrThrow();
      return reply
        .type("application/pdf")
        .header("content-disposition", `inline; filename="work-completion-${workOrderLabel(wo.number)}.pdf"`)
        .header("x-content-type-options", "nosniff")
        .send(pdf);
    },
  );
};
