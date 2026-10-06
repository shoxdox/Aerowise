import { QUICKBOOKS_CONFLICT_GUIDE, type QuickBooksAction, type QuickBooksResolveInput } from "@aerowise/domain";
import type { QuickBooksContext } from "./connection.ts";
import { customerPayloads, payloadHash } from "./records.ts";
import type { Link, StoredCandidate } from "./sync.ts";

export class ResolveError extends Error {}

/** The choices a record offers now. */
export function actionsFor(link: Pick<Link, "status" | "conflictKind">): QuickBooksAction[] {
  if (link.status === "conflict" && link.conflictKind) return QUICKBOOKS_CONFLICT_GUIDE[link.conflictKind].actions;
  if (link.status === "failed") return QUICKBOOKS_CONFLICT_GUIDE.failed.actions;
  // Start syncing a record again after it was set aside.
  if (link.status === "ignored") return ["retry"];
  return [];
}

/**
 * Carries out a person's decision on a record in the conflict center. Nothing is sent to
 * QuickBooks here: the record is set up so the next sync run does what was chosen.
 */
export async function resolveLink(ctx: QuickBooksContext, organizationId: string, linkId: string, input: QuickBooksResolveInput): Promise<Link> {
  const { db } = ctx;
  return db.transaction().execute(async (trx) => {
    const link = await trx.selectFrom("quickbooksLinks").selectAll().where("organizationId", "=", organizationId).where("id", "=", linkId).forUpdate().executeTakeFirst();
    if (!link) throw new ResolveError("not_found");
    if (!actionsFor(link).includes(input.action)) throw new ResolveError("That choice does not apply to this record any more");
    const now = ctx.now();
    const details = (link.conflict ?? {}) as Record<string, unknown>;
    const clear = { conflictKind: null, conflict: null, syncError: null, retryCount: 0, nextAttemptAt: null, updatedAt: now };
    const set = (patch: Record<string, unknown>) => trx.updateTable("quickbooksLinks").set({ ...clear, ...patch }).where("id", "=", link.id).execute();
    const localHash = async () => {
      if (link.entityType !== "customer") return link.pushedHash;
      return payloadHash((await customerPayloads(trx, organizationId, [link.entityId])).get(link.entityId));
    };

    switch (input.action) {
      case "match": {
        if (link.conflictKind === "duplicate_number") {
          const existing = details.existing as { id: string; syncToken: string };
          await set({ status: "synced", externalId: existing.id, syncToken: existing.syncToken, remoteState: "open", lastSyncedAt: now, force: false });
          break;
        }
        const candidates = (details.candidates ?? []) as StoredCandidate[];
        const picked = candidates.find((c) => c.id === input.externalId);
        if (!picked) throw new ResolveError("Pick one of the QuickBooks customers offered");
        const taken = await trx
          .selectFrom("quickbooksLinks")
          .select("id")
          .where("organizationId", "=", organizationId)
          .where("entityType", "=", link.entityType)
          .where("externalId", "=", picked.id)
          .where("id", "<>", link.id)
          .executeTakeFirst();
        if (taken) throw new ResolveError("That QuickBooks customer is already linked to another customer");
        // Linked as it is: QuickBooks keeps its details until this customer next changes here.
        await set({ status: "synced", externalId: picked.id, syncToken: picked.syncToken, remoteUpdatedAt: picked.updatedAt, pushedHash: await localHash(), lastSyncedAt: now, decision: "match", force: false });
        break;
      }
      case "create":
        await set({ status: "queued", decision: "create", externalId: null, force: false });
        break;
      case "use_aerowise":
        await set({ status: "queued", force: true });
        break;
      case "keep_quickbooks":
        // For a refunded payment, the person handles the refund in QuickBooks; the next refund asks again.
        await set({
          status: "synced",
          syncToken: details.remoteSyncToken as string,
          remoteUpdatedAt: (details.remoteUpdatedAt as string | null) ?? null,
          pushedHash: link.entityType === "payment" ? String(details.netCents) : await localHash(),
          lastSyncedAt: now,
          force: false,
        });
        break;
      case "recreate":
        await set({
          status: "queued",
          externalId: null,
          syncToken: null,
          remoteState: null,
          remoteUpdatedAt: null,
          pushedHash: null,
          generation: link.generation + 1,
          decision: link.entityType === "customer" ? "create" : link.decision,
          force: false,
        });
        break;
      case "send_anyway":
        await set({ status: "queued", force: true });
        break;
      case "retry":
        await set({ status: "queued", force: false });
        break;
      case "ignore":
        await set({ status: "ignored", force: false });
        break;
    }
    return trx.selectFrom("quickbooksLinks").selectAll().where("id", "=", link.id).executeTakeFirstOrThrow();
  });
}
