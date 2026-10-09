import type { DB } from "@aerowise/db";
import type { FastifyRequest } from "fastify";
import type { Transaction } from "kysely";
import { platformAudit } from "./platform-audit.ts";

/**
 * Ends an admin's open support sessions, auditing each one in the platform log and in the
 * company's own log. Called when the admin ends support, opens another company, or signs
 * out of /admin: a support cookie never outlives the admin sign-in it came from.
 */
export async function endOpenSupportSessions(trx: Transaction<DB>, req: FastifyRequest, adminId: string, why: "ended" | "replaced" | "signed_out") {
  const ended = await trx
    .updateTable("supportSessions")
    .set({ endedAt: new Date() })
    .where("adminId", "=", adminId)
    .where("endedAt", "is", null)
    .where("expiresAt", ">", new Date())
    .returning(["id", "organizationId"])
    .execute();
  for (const s of ended) {
    await platformAudit(trx, req, { adminId, action: "support.ended", entityType: "support_session", entityId: s.id, organizationId: s.organizationId, changes: { why } });
    await trx
      .insertInto("auditEvents")
      .values({ organizationId: s.organizationId, actorUserId: null, action: "support.ended", entityType: "support_session", entityId: s.id, changes: JSON.stringify({ why }), requestId: req.id })
      .execute();
  }
  return ended.length;
}
