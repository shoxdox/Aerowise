import type { Database } from "@aerowise/db";
import type { Transaction } from "kysely";
import type { DB } from "@aerowise/db";
import type { FastifyRequest } from "fastify";

type Executor = Database | Transaction<DB>;

/** Appends a structured audit event for a change made by the signed-in user. */
export async function audit(
  db: Executor,
  req: FastifyRequest,
  event: { action: string; entityType: string; entityId: string; changes?: Record<string, unknown> },
) {
  const auth = req.requireAuth();
  await db
    .insertInto("auditEvents")
    .values({
      organizationId: auth.organizationId,
      actorUserId: auth.userId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      changes: JSON.stringify(event.changes ?? {}),
      requestId: req.id,
    })
    .execute();
}
