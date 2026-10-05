import type { Database, DB } from "@aerowise/db";
import type { FastifyRequest } from "fastify";
import type { Transaction } from "kysely";

type Executor = Database | Transaction<DB>;

/** Appends an event to the platform audit log for an action taken in /admin. */
export async function platformAudit(
  db: Executor,
  req: FastifyRequest,
  event: { adminId: string; action: string; entityType: string; entityId?: string; organizationId?: string; changes?: Record<string, unknown> },
) {
  await db
    .insertInto("platformAuditEvents")
    .values({
      adminId: event.adminId,
      organizationId: event.organizationId ?? null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      changes: JSON.stringify(event.changes ?? {}),
      requestId: req.id,
    })
    .execute();
}
