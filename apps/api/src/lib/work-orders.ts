import type { DB } from "@aerowise/db";
import { canTransitionWorkOrder, workOrderLabel, type WorkOrderStatus } from "@aerowise/domain";
import type { FastifyRequest } from "fastify";
import type { Transaction } from "kysely";
import { HttpError, notFound } from "./errors.ts";

// Work order lifecycle helpers shared by the work order routes and the schedule routes.
// Every change runs in the caller's transaction with the work order row locked, so the
// order's status and its visit's status always move together.

type Trx = Transaction<DB>;

export const featureOff = () => new HttpError(409, "feature_off", "Work orders are not switched on for this deployment");

/** Locks the work order row for this change. Another company's id is not found. */
export async function lockWorkOrder(trx: Trx, organizationId: string, workOrderId: string) {
  const wo = await trx
    .selectFrom("workOrders")
    .select(["id", "number", "status", "siteId", "customerId", "category"])
    .where("organizationId", "=", organizationId)
    .where("id", "=", workOrderId)
    .forUpdate()
    .executeTakeFirst();
  if (!wo) throw notFound("Work order");
  return wo;
}

/** Appends to the work order's timeline. */
export async function workOrderEvent(
  trx: Trx,
  req: FastifyRequest | null,
  e: { organizationId: string; workOrderId: string; eventType: string; summary: string; details?: Record<string, unknown>; homeownerVisible?: boolean; at: Date },
) {
  await trx
    .insertInto("workOrderEvents")
    .values({
      organizationId: e.organizationId,
      workOrderId: e.workOrderId,
      eventType: e.eventType,
      summary: e.summary,
      actorUserId: req?.auth?.userId ?? null,
      details: JSON.stringify(e.details ?? {}),
      homeownerVisible: e.homeownerVisible ?? false,
      occurredAt: e.at,
    })
    .execute();
}

/** Moves the work order to `to`, or refuses with 409 when the state machine does not allow it. */
export async function setWorkOrderStatus(trx: Trx, organizationId: string, wo: { id: string; status: string }, to: WorkOrderStatus, at: Date, extra: Partial<{ completedAt: Date; completedWithoutRecordReason: string; cancelledAt: Date; cancelReason: string }> = {}) {
  if (wo.status === to) return;
  if (!canTransitionWorkOrder(wo.status as WorkOrderStatus, to)) {
    throw new HttpError(409, "invalid_transition", `A ${wo.status.replace("_", " ")} work order cannot become ${to.replace("_", " ")}`);
  }
  await trx
    .updateTable("workOrders")
    .set({ status: to, updatedAt: at, ...extra })
    .where("organizationId", "=", organizationId)
    .where("id", "=", wo.id)
    .execute();
}

/** The next gapless number for the company (a rolled-back insert gives its number back). */
export async function nextWorkOrderNumber(trx: Trx, organizationId: string) {
  const r = await trx
    .updateTable("organizations")
    .set((eb) => ({ nextWorkOrderNumber: eb("nextWorkOrderNumber", "+", 1) }))
    .where("id", "=", organizationId)
    .returning("nextWorkOrderNumber")
    .executeTakeFirstOrThrow();
  return r.nextWorkOrderNumber - 1;
}

/**
 * A work visit was unscheduled (from the schedule, or because the order was cancelled or
 * completed). An order waiting on that visit goes back to ready to schedule.
 */
export async function afterWorkVisitCancelled(trx: Trx, req: FastifyRequest, args: { organizationId: string; workOrderId: string; scheduledDate: string; reason: string; at: Date }) {
  const wo = await lockWorkOrder(trx, args.organizationId, args.workOrderId);
  if (wo.status === "scheduled" || wo.status === "in_progress") await setWorkOrderStatus(trx, args.organizationId, wo, "open", args.at);
  await workOrderEvent(trx, req, {
    organizationId: args.organizationId,
    workOrderId: wo.id,
    eventType: "visit_cancelled",
    summary: `Visit on ${args.scheduledDate} unscheduled: ${args.reason}`,
    details: { reason: args.reason },
    homeownerVisible: true,
    at: args.at,
  });
}

export const label = workOrderLabel;
