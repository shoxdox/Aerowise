import { matchCustomer } from "@aerowise/domain";
import { sql } from "kysely";
import { openCompany, type QuickBooksContext } from "./connection.ts";
import { customerPayloads, payloadHash } from "./records.ts";
import { candidateOf, type StoredCandidate } from "./sync.ts";

/** What a customer's review row keeps in `conflict` while the first sync is being reviewed. */
export interface ReviewState {
  found: "exact" | "review" | "none";
  candidates: StoredCandidate[];
  /** True while the decision is Aerowise's suggestion; a person's choice survives a refresh. */
  auto: boolean;
}

export class ReviewError extends Error {}

/**
 * First sync, step 2 and 3: read every active QuickBooks customer and propose a match for
 * every Aerowise customer. Exact matches are linked, customers with no likely match are
 * created, and the rest wait for a person. Nothing is sent until the review is committed.
 */
export async function refreshReview(ctx: QuickBooksContext, organizationId: string) {
  const conn = await ctx.db.selectFrom("quickbooksConnections").select(["setupState", "status"]).where("organizationId", "=", organizationId).executeTakeFirst();
  if (!conn || conn.status !== "connected") throw new ReviewError("QuickBooks is not connected");
  if (conn.setupState !== "review") throw new ReviewError("The first sync has already been committed");
  const company = await openCompany(ctx, organizationId);
  const remote = await company.listCustomers();

  const customers = await ctx.db.selectFrom("customers").select("id").where("organizationId", "=", organizationId).orderBy("displayName").execute();
  const payloads = await customerPayloads(ctx.db, organizationId, customers.map((c) => c.id));
  const existing = new Map(
    (await ctx.db.selectFrom("quickbooksLinks").selectAll().where("organizationId", "=", organizationId).where("entityType", "=", "customer").execute()).map((l) => [l.entityId, l]),
  );
  const remoteIds = new Set(remote.map((r) => r.id));

  type Row = { customerId: string; externalId: string | null; decision: "match" | "create" | "skip" | null; state: ReviewState };
  const rows: Row[] = [];
  for (const c of customers) {
    const prev = existing.get(c.id);
    if (prev && prev.status !== "new") continue;
    const p = payloads.get(c.id)!;
    const m = matchCustomer({ name: p.displayName, email: p.email, phone: p.phone }, remote);
    const candidates = m.kind === "exact" ? [candidateOf(m.match.customer, m.match.score, m.match.reasons)] : m.kind === "review" ? m.candidates.map((x) => candidateOf(x.customer, x.score, x.reasons)) : [];
    const state: ReviewState = { found: m.kind, candidates, auto: true };
    const prevState = prev?.conflict as ReviewState | null | undefined;
    // Keep a person's choice, unless the QuickBooks customer they picked is gone.
    if (prev && prevState && !prevState.auto && prev.decision && (prev.decision !== "match" || (prev.externalId && remoteIds.has(prev.externalId)))) {
      const picked = prev.decision === "match" ? remote.find((r) => r.id === prev.externalId) : undefined;
      if (picked && !candidates.some((x) => x.id === picked.id)) candidates.push(candidateOf(picked));
      rows.push({ customerId: c.id, externalId: prev.decision === "match" ? prev.externalId : null, decision: prev.decision, state: { ...state, auto: false } });
      continue;
    }
    rows.push({ customerId: c.id, externalId: m.kind === "exact" ? m.match.customer.id : null, decision: m.kind === "exact" ? "match" : m.kind === "none" ? "create" : null, state });
  }
  // One QuickBooks customer can be one Aerowise customer at most: if two claim it, ask.
  const claims = new Map<string, Row[]>();
  for (const r of rows) if (r.externalId) claims.set(r.externalId, [...(claims.get(r.externalId) ?? []), r]);
  for (const [, claimants] of claims) {
    if (claimants.length < 2) continue;
    for (const r of claimants.filter((x) => x.state.auto)) {
      r.externalId = null;
      r.decision = null;
      r.state.found = "review";
    }
  }
  const linked = new Set(
    [...existing.values()].filter((l) => l.status !== "new" && l.externalId).map((l) => l.externalId!),
  );
  for (const r of rows) {
    if (r.externalId && linked.has(r.externalId)) {
      r.externalId = null;
      r.decision = null;
    }
  }

  await ctx.db.transaction().execute(async (trx) => {
    await trx.updateTable("quickbooksLinks").set({ externalId: null }).where("organizationId", "=", organizationId).where("entityType", "=", "customer").where("status", "=", "new").execute();
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await trx
        .insertInto("quickbooksLinks")
        .values(
          chunk.map((r) => ({
            organizationId,
            entityType: "customer" as const,
            entityId: r.customerId,
            status: "new" as const,
            externalId: r.externalId,
            decision: r.decision,
            conflict: JSON.stringify(r.state),
            createdAt: ctx.now(),
            updatedAt: ctx.now(),
          })),
        )
        .onConflict((oc) =>
          oc.columns(["organizationId", "entityType", "entityId"]).doUpdateSet((eb) => ({
            externalId: eb.ref("excluded.externalId"),
            decision: eb.ref("excluded.decision"),
            conflict: eb.ref("excluded.conflict"),
            updatedAt: eb.ref("excluded.updatedAt"),
          })),
        )
        .execute();
    }
    await trx.updateTable("quickbooksConnections").set({ reviewFetchedAt: ctx.now(), reviewRemoteCount: remote.length, updatedAt: ctx.now() }).where("organizationId", "=", organizationId).execute();
  });
  return { remote: remote.length, rows: rows.length };
}

/** A person's choice for one customer in the review. */
export async function decide(ctx: QuickBooksContext, organizationId: string, customerId: string, d: { decision: "match"; externalId: string } | { decision: "create" } | { decision: "skip" }) {
  const link = await ctx.db.selectFrom("quickbooksLinks").selectAll().where("organizationId", "=", organizationId).where("entityType", "=", "customer").where("entityId", "=", customerId).executeTakeFirst();
  if (!link || link.status !== "new") throw new ReviewError("This customer is not in the review");
  const state = (link.conflict ?? { found: "none", candidates: [], auto: true }) as ReviewState;
  let externalId: string | null = null;
  if (d.decision === "match") {
    if (!state.candidates.some((c) => c.id === d.externalId)) throw new ReviewError("Pick one of the QuickBooks customers offered");
    const taken = await ctx.db
      .selectFrom("quickbooksLinks as l")
      .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "l.entityId").onRef("c.organizationId", "=", "l.organizationId"))
      .select("c.displayName")
      .where("l.organizationId", "=", organizationId)
      .where("l.entityType", "=", "customer")
      .where("l.externalId", "=", d.externalId)
      .where("l.id", "<>", link.id)
      .executeTakeFirst();
    if (taken) throw new ReviewError(`That QuickBooks customer is already matched to ${taken.displayName}`);
    externalId = d.externalId;
  }
  await ctx.db
    .updateTable("quickbooksLinks")
    .set({ decision: d.decision, externalId, conflict: JSON.stringify({ ...state, auto: false }), updatedAt: ctx.now() })
    .where("id", "=", link.id)
    .execute();
}

/**
 * First sync, step 7: matched customers are linked as they are (QuickBooks keeps its
 * details), the rest are queued to be created, skipped ones are never synced, and any
 * left undecided go to the conflict center. Syncing starts after this.
 */
export async function commitReview(ctx: QuickBooksContext, organizationId: string) {
  return ctx.db.transaction().execute(async (trx) => {
    const conn = await trx.selectFrom("quickbooksConnections").select(["setupState", "status"]).where("organizationId", "=", organizationId).forUpdate().executeTakeFirst();
    if (!conn || conn.status !== "connected") throw new ReviewError("QuickBooks is not connected");
    if (conn.setupState !== "review") throw new ReviewError("The first sync has already been committed");
    const links = await trx.selectFrom("quickbooksLinks").selectAll().where("organizationId", "=", organizationId).where("entityType", "=", "customer").where("status", "=", "new").execute();
    const payloads = await customerPayloads(trx, organizationId, links.filter((l) => l.decision === "match").map((l) => l.entityId));
    const counts = { matched: 0, create: 0, skipped: 0, undecided: 0 };
    const now = ctx.now();
    for (const l of links) {
      const state = (l.conflict ?? { candidates: [] }) as ReviewState;
      if (l.decision === "match" && l.externalId) {
        const c = state.candidates.find((x) => x.id === l.externalId);
        await trx
          .updateTable("quickbooksLinks")
          .set({ status: "synced", syncToken: c?.syncToken ?? null, remoteUpdatedAt: c?.updatedAt ?? null, pushedHash: payloadHash(payloads.get(l.entityId)), lastSyncedAt: now, conflict: null, updatedAt: now })
          .where("id", "=", l.id)
          .execute();
        counts.matched++;
      } else if (l.decision === "create") {
        await trx.updateTable("quickbooksLinks").set({ status: "queued", conflict: null, updatedAt: now }).where("id", "=", l.id).execute();
        counts.create++;
      } else if (l.decision === "skip") {
        await trx.updateTable("quickbooksLinks").set({ status: "ignored", conflict: null, updatedAt: now }).where("id", "=", l.id).execute();
        counts.skipped++;
      } else {
        await trx
          .updateTable("quickbooksLinks")
          .set({ status: "conflict", conflictKind: "ambiguous_match", conflict: JSON.stringify({ candidates: state.candidates }), updatedAt: now })
          .where("id", "=", l.id)
          .execute();
        counts.undecided++;
      }
    }
    await trx.updateTable("quickbooksConnections").set({ setupState: "active", changesSince: now, updatedAt: now }).where("organizationId", "=", organizationId).execute();
    return counts;
  });
}

/** Counts for the review header. */
export async function reviewCounts(ctx: QuickBooksContext, organizationId: string) {
  const r = await sql<{ found: string; decided: boolean; n: string }>`
    select conflict->>'found' as found, decision is not null as decided, count(*) as n
    from quickbooks_links where organization_id = ${organizationId} and entity_type = 'customer' and status = 'new'
    group by 1, 2`.execute(ctx.db);
  const counts = { exact: 0, review: 0, none: 0, undecided: 0 };
  for (const row of r.rows) {
    const n = Number(row.n);
    if (row.found === "exact" || row.found === "review" || row.found === "none") counts[row.found] += n;
    if (!row.decided) counts.undecided += n;
  }
  return counts;
}
