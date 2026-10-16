import type { DB } from "@aerowise/db";
import { workOrderLabel } from "@aerowise/domain";
import type { FastifyRequest } from "fastify";
import type { Transaction } from "kysely";
import { audit } from "./audit.ts";

/**
 * A work order is done: the inspection issue and the customer's request it was made for are
 * done too, in the completing transaction, so the inbox shrinks as the work gets finished.
 * A reportable request (an owner complaint) keeps its own response for the authority report;
 * only a person records that.
 */
export async function closeWorkSources(trx: Transaction<DB>, req: FastifyRequest, a: { organizationId: string; workOrderId: string; at: Date }) {
  const { userId } = req.requireAuth();
  const wo = await trx.selectFrom("workOrders").select("number").where("organizationId", "=", a.organizationId).where("id", "=", a.workOrderId).executeTakeFirstOrThrow();
  const resolution = `Done: ${workOrderLabel(wo.number)} completed`;
  const issues = await trx
    .updateTable("issues")
    .set({ status: "resolved", resolvedAt: a.at, resolvedBy: userId, resolution, updatedAt: a.at })
    .where("organizationId", "=", a.organizationId)
    .where("workOrderId", "=", a.workOrderId)
    .where("status", "=", "open")
    .returning("id")
    .execute();
  for (const i of issues) await audit(trx, req, { action: "issue.resolved", entityType: "issue", entityId: i.id, changes: { resolution, workOrderId: a.workOrderId } });
  const requests = await trx
    .updateTable("serviceRequests")
    .set({ status: "closed", resolution, closedAt: a.at, closedBy: userId, updatedAt: a.at })
    .where("organizationId", "=", a.organizationId)
    .where("workOrderId", "=", a.workOrderId)
    .where("status", "=", "open")
    .returning("id")
    .execute();
  for (const r of requests) await audit(trx, req, { action: "service_request.closed", entityType: "service_request", entityId: r.id, changes: { resolution, workOrderId: a.workOrderId } });
}
