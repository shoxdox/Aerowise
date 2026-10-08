import type { Database } from "@aerowise/db";
import { providerFor } from "@aerowise/tasks";
import {
  id,
  QUICKBOOKS_ENTITY_TYPES,
  QUICKBOOKS_SYNC_STATUSES,
  quickbooksAccount,
  quickbooksItem,
  quickbooksMapping,
  quickbooksMappingInput,
  quickbooksRecord,
  quickbooksResolveInput,
  quickbooksReview,
  quickbooksReviewDecision,
  quickbooksStatus,
  quickbooksTaxCode,
  type QuickBooksStatus,
} from "@aerowise/domain";
import {
  commitReview,
  customerPayloads,
  decide,
  disconnect,
  openCompany,
  QuickBooksError,
  recheckInvoice,
  refreshReview,
  resolveLink,
  ResolveError,
  ReviewError,
  reviewCounts,
  saveConnection,
  TestCompanies,
  type QuickBooksContext,
  type ReviewState,
} from "@aerowise/quickbooks";
import { queueQuickBooksSync } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { listQuickBooksRecords, type QuickBooksConfig } from "../lib/quickbooks.ts";
import { organizationToday } from "../lib/today.ts";

const empty = z.object({}).optional();

/** QuickBooks' own errors, said plainly. */
function asHttp(err: unknown): never {
  if (err instanceof QuickBooksError) {
    if (err.kind === "auth") throw new HttpError(409, "quickbooks_reconnect", `${err.message}`);
    if (err.kind === "transient") throw new HttpError(503, "quickbooks_unavailable", err.message);
    throw new HttpError(502, "quickbooks_error", err.message);
  }
  if (err instanceof ReviewError) throw unprocessable(err.message);
  if (err instanceof ResolveError) throw err.message === "not_found" ? notFound("Sync record") : unprocessable(err.message);
  throw err;
}

/**
 * QuickBooks Online: connecting (OAuth), the first-sync review, item mapping, sync health
 * and the conflict center. Sending happens in the worker; these routes set up what it does.
 */
export const quickbooksRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; quickbooks: QuickBooksConfig | null; appUrl: string }> = async (
  app,
  { db, now, quickbooks, appUrl },
) => {
  const base = appUrl.replace(/\/$/, "");
  const redirectUri = `${base}/api/quickbooks/callback`;
  const ctx = (): QuickBooksContext => {
    if (!quickbooks) throw unprocessable("QuickBooks is not configured on this server (QUICKBOOKS_CLIENT_ID)");
    return { db, now, ...quickbooks };
  };

  async function status(organizationId: string): Promise<QuickBooksStatus> {
    const c = await db.selectFrom("quickbooksConnections").selectAll().where("organizationId", "=", organizationId).executeTakeFirst();
    const rows = await db
      .selectFrom("quickbooksLinks")
      .select(["entityType", "status", sql<number>`count(*)::int`.as("n"), sql<number>`count(*) filter (where status in ('conflict', 'quarantined') or (status = 'failed' and next_attempt_at is null))::int`.as("attention")])
      .where("organizationId", "=", organizationId)
      .where("status", "<>", "new")
      .groupBy(["entityType", "status"])
      .execute();
    const counts: QuickBooksStatus["counts"] = { customer: {}, plan: {}, invoice: {}, payment: {}, refund: {}, service_item: {} };
    let attention = 0;
    for (const r of rows) {
      counts[r.entityType][r.status] = Number(r.n);
      attention += Number(r.attention);
    }
    return {
      provider: quickbooks ? (await providerFor(quickbooks.provider, organizationId)).kind : "none",
      connection: c
        ? {
            environment: c.environment,
            companyName: c.companyName,
            status: c.status,
            setupState: c.setupState,
            syncFrom: c.syncFrom,
            defaultItem: c.defaultItemId ? { id: c.defaultItemId, name: c.defaultItemName ?? c.defaultItemId } : null,
            connectedAt: c.connectedAt.toISOString(),
            lastSyncStartedAt: c.lastSyncStartedAt?.toISOString() ?? null,
            lastSyncFinishedAt: c.lastSyncFinishedAt?.toISOString() ?? null,
            lastSyncError: c.lastSyncError,
          }
        : null,
      counts,
      attention,
    };
  }

  app.get(
    "/quickbooks",
    { config: { permission: "quickbooks:read" }, schema: { tags: ["quickbooks"], summary: "Whether QuickBooks is connected, and how the sync stands", response: { 200: quickbooksStatus } } },
    async (req) => status(req.requireAuth().organizationId),
  );

  app.post(
    "/quickbooks/connect",
    {
      config: { permission: "billing:manage" },
      schema: {
        tags: ["quickbooks"],
        summary: "Start connecting a QuickBooks Online company",
        description: "Returns Intuit's consent page to open. QuickBooks sends the browser back to /quickbooks/callback.",
        body: empty,
        response: { 200: z.object({ url: z.string() }) },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const c = ctx();
      return { url: (await providerFor(c.provider, organizationId)).authorizeUrl({ state: c.cipher.signState({ organizationId, userId }, now()), redirectUri, organizationId }) };
    },
  );

  app.get(
    "/quickbooks/callback",
    {
      config: { permission: "billing:manage", changesState: true },
      schema: {
        tags: ["quickbooks"],
        summary: "Where QuickBooks sends the browser after the owner approves (or declines) the connection",
        querystring: z.object({ code: z.string().max(512).optional(), realmId: z.string().max(64).optional(), state: z.string().max(1024).optional(), error: z.string().max(200).optional() }),
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const back = (q: string) => reply.redirect(`${base}/quickbooks?${q}`);
      const c = ctx();
      const state = req.query.state ? c.cipher.verifyState(req.query.state, now()) : null;
      // Only the person who started connecting, in the same organization, can finish.
      if (!state || state.organizationId !== organizationId || state.userId !== userId) return back("error=state");
      if (req.query.error || !req.query.code || !req.query.realmId) return back("error=declined");
      const realmId = req.query.realmId;
      try {
        // A demo company always connects to the stand-in company, whatever QuickBooks is configured.
        const provider = await providerFor(c.provider, organizationId);
        if (provider.kind === "test") {
          // The stand-in company starts with near-copies of a few customers, so the review has something to decide.
          const sample = await db.selectFrom("customers").select("id").where("organizationId", "=", organizationId).orderBy("createdAt").limit(4).execute();
          const payloads = await customerPayloads(db, organizationId, sample.map((s) => s.id));
          const org = await db.selectFrom("organizations").select("name").where("id", "=", organizationId).executeTakeFirstOrThrow();
          await new TestCompanies(db, now).seed(
            realmId,
            `${org.name} (test company)`,
            sample.map((s) => payloads.get(s.id)!).map((p) => ({ name: p.displayName, email: p.email, phone: p.phone })),
          );
        }
        const tokens = await c.provider.exchangeCode({ code: req.query.code, realmId, redirectUri, organizationId });
        const companyName = await c.provider.company(realmId, tokens.accessToken, organizationId).companyName().catch(() => null);
        await saveConnection(c, { organizationId, userId, realmId, companyName, tokens, syncFrom: await organizationToday(db, organizationId, now()) });
        await audit(db, req, { action: "quickbooks.connected", entityType: "organization", entityId: organizationId, changes: { realmId, companyName, environment: provider.environment } });
      } catch (err) {
        req.log.warn({ err }, "quickbooks connect failed");
        return back("error=connect");
      }
      return back("connected=1");
    },
  );

  app.post(
    "/quickbooks/disconnect",
    { config: { permission: "billing:manage" }, schema: { tags: ["quickbooks"], summary: "Stop syncing and give up the QuickBooks connection", body: empty, response: { 200: quickbooksStatus } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await disconnect(ctx(), organizationId);
      await audit(db, req, { action: "quickbooks.disconnected", entityType: "organization", entityId: organizationId, changes: {} });
      return status(organizationId);
    },
  );

  app.get(
    "/quickbooks/items",
    { config: { permission: "quickbooks:read" }, schema: { tags: ["quickbooks"], summary: "Products and services in QuickBooks", response: { 200: z.array(quickbooksItem) } } },
    async (req) => {
      try {
        const items = await (await openCompany(ctx(), req.requireAuth().organizationId)).listItems();
        return items.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
      } catch (err) {
        asHttp(err);
      }
    },
  );

  app.get(
    "/quickbooks/accounts",
    { config: { permission: "quickbooks:read" }, schema: { tags: ["quickbooks"], summary: "Bank and clearing accounts in QuickBooks that refunds can be paid from", response: { 200: z.array(quickbooksAccount) } } },
    async (req) => {
      try {
        const accounts = await (await openCompany(ctx(), req.requireAuth().organizationId)).listAccounts();
        return accounts.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
      } catch (err) {
        asHttp(err);
      }
    },
  );

  app.get(
    "/quickbooks/tax-codes",
    { config: { permission: "quickbooks:read" }, schema: { tags: ["quickbooks"], summary: "Sales tax codes in QuickBooks: TAX and NON for lines, and the codes invoices are taxed at", response: { 200: z.array(quickbooksTaxCode) } } },
    async (req) => {
      try {
        const codes = await (await openCompany(ctx(), req.requireAuth().organizationId)).listTaxCodes();
        return codes.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
      } catch (err) {
        asHttp(err);
      }
    },
  );

  async function mapping(organizationId: string) {
    const c = await db
      .selectFrom("quickbooksConnections")
      .select([
        "environment",
        "syncFrom",
        "defaultItemId",
        "defaultItemName",
        "refundItemId",
        "refundItemName",
        "stripeRefundAccountId",
        "stripeRefundAccountName",
        "manualRefundAccountId",
        "manualRefundAccountName",
        "taxMode",
        "taxableCodeRef",
        "taxableCodeName",
        "nontaxableCodeRef",
        "nontaxableCodeName",
        "taxRateRef",
        "taxRateName",
      ])
      .where("organizationId", "=", organizationId)
      .executeTakeFirst();
    if (!c) throw unprocessable("QuickBooks is not connected");
    const plans = await db
      .selectFrom("plans as p")
      .leftJoin("quickbooksLinks as l", (j) => j.onRef("l.entityId", "=", "p.id").onRef("l.organizationId", "=", "p.organizationId").on("l.entityType", "=", "plan"))
      .select(["p.id", "p.name", "p.active", "l.externalId", "l.status", "l.conflict"])
      .where("p.organizationId", "=", organizationId)
      .orderBy("p.active", "desc")
      .orderBy("p.name")
      .execute();
    const serviceItems = await db
      .selectFrom("serviceItems as s")
      .leftJoin("quickbooksLinks as l", (j) => j.onRef("l.entityId", "=", "s.id").onRef("l.organizationId", "=", "s.organizationId").on("l.entityType", "=", "service_item"))
      .select(["s.id", "s.name", "s.active", "l.externalId", "l.conflict"])
      .where("s.organizationId", "=", organizationId)
      .orderBy("s.active", "desc")
      .orderBy("s.name")
      .execute();
    const chosen = (externalId: string | null, conflict: unknown) => (externalId ? { id: externalId, name: (conflict as { itemName?: string } | null)?.itemName ?? externalId } : null);
    return {
      syncFrom: c.syncFrom,
      defaultItem: c.defaultItemId ? { id: c.defaultItemId, name: c.defaultItemName ?? c.defaultItemId } : null,
      refundItem: c.refundItemId ? { id: c.refundItemId, name: c.refundItemName ?? c.refundItemId } : null,
      stripeRefundAccount: c.stripeRefundAccountId ? { id: c.stripeRefundAccountId, name: c.stripeRefundAccountName ?? c.stripeRefundAccountId } : null,
      manualRefundAccount: c.manualRefundAccountId ? { id: c.manualRefundAccountId, name: c.manualRefundAccountName ?? c.manualRefundAccountId } : null,
      tax: {
        mode: c.taxMode,
        taxableCode: c.taxableCodeRef ? { id: c.taxableCodeRef, name: c.taxableCodeName ?? c.taxableCodeRef } : null,
        nontaxableCode: c.nontaxableCodeRef ? { id: c.nontaxableCodeRef, name: c.nontaxableCodeName ?? c.nontaxableCodeRef } : null,
        taxRate: c.taxRateRef ? { id: c.taxRateRef, name: c.taxRateName ?? c.taxRateRef } : null,
        allowed: taxModeAllowed(c.environment),
      },
      plans: plans.map((p) => ({
        planId: p.id,
        planName: p.name,
        active: p.active,
        item: p.externalId ? { id: p.externalId, name: ((p.conflict as { itemName?: string } | null)?.itemName ?? p.externalId) as string } : null,
        status: p.status,
      })),
      serviceItems: serviceItems.map((i) => ({ serviceItemId: i.id, name: i.name, active: i.active, item: chosen(i.externalId, i.conflict) })),
    };
  }

  app.get(
    "/quickbooks/mapping",
    { config: { permission: "quickbooks:read" }, schema: { tags: ["quickbooks"], summary: "Which QuickBooks item each plan's and service item's invoice lines use, and from when invoices are sent", response: { 200: quickbooksMapping } } },
    async (req) => mapping(req.requireAuth().organizationId),
  );

  app.put(
    "/quickbooks/mapping",
    {
      config: { permission: "billing:manage" },
      schema: { tags: ["quickbooks"], summary: "Choose QuickBooks items for plans, service items and other charges, and the date invoices start syncing from", body: quickbooksMappingInput, response: { 200: quickbooksMapping } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const body = req.body;
      const wanted = [...new Set([body.defaultItemId, body.refundItemId, ...(body.plans ?? []).map((p) => p.itemId), ...(body.serviceItems ?? []).map((i) => i.itemId)].filter((x): x is string => !!x))];
      let names = new Map<string, string>();
      if (wanted.length) {
        try {
          const items = await (await openCompany(ctx(), organizationId)).listItems();
          names = new Map(items.filter((i) => i.active).map((i) => [i.id, i.name]));
        } catch (err) {
          asHttp(err);
        }
        const missing = wanted.filter((w) => !names.has(w));
        if (missing.length) throw unprocessable("Pick active QuickBooks items only");
      }
      const wantedAccounts = [...new Set([body.stripeRefundAccountId, body.manualRefundAccountId].filter((x): x is string => !!x))];
      let accountNames = new Map<string, string>();
      if (wantedAccounts.length) {
        try {
          const accounts = await (await openCompany(ctx(), organizationId)).listAccounts();
          accountNames = new Map(accounts.filter((a) => a.active).map((a) => [a.id, a.name]));
        } catch (err) {
          asHttp(err);
        }
        if (wantedAccounts.some((w) => !accountNames.has(w))) throw unprocessable("Pick active QuickBooks accounts only");
      }
      // Sales tax codes: each must be an active QuickBooks code of the right kind.
      const taxRefs = { taxableCodeRef: true, nontaxableCodeRef: false, taxRateRef: true } as const;
      const codeNames = new Map<string, string>();
      if ((Object.keys(taxRefs) as (keyof typeof taxRefs)[]).some((k) => body[k])) {
        let codes;
        try {
          codes = await (await openCompany(ctx(), organizationId)).listTaxCodes();
        } catch (err) {
          asHttp(err);
        }
        for (const [k, taxable] of Object.entries(taxRefs) as [keyof typeof taxRefs, boolean][]) {
          const chosen = body[k];
          if (!chosen) continue;
          const code = codes.find((x) => x.id === chosen && x.active);
          if (!code) throw unprocessable("Pick active QuickBooks tax codes only");
          if (code.taxable !== taxable) throw unprocessable(taxable ? "Pick a taxable code for taxable lines and the invoice's tax" : "Pick a non-taxable code for untaxed lines");
          codeNames.set(chosen, code.name);
        }
      }
      const current = await db
        .selectFrom("quickbooksConnections")
        .select(["environment", "taxMode", "taxableCodeRef", "nontaxableCodeRef", "taxRateRef"])
        .where("organizationId", "=", organizationId)
        .executeTakeFirst();
      if (!current) throw unprocessable("QuickBooks is not connected");
      const nextTax = {
        mode: body.taxMode ?? current.taxMode,
        taxableCodeRef: body.taxableCodeRef !== undefined ? body.taxableCodeRef : current.taxableCodeRef,
        nontaxableCodeRef: body.nontaxableCodeRef !== undefined ? body.nontaxableCodeRef : current.nontaxableCodeRef,
        taxRateRef: body.taxRateRef !== undefined ? body.taxRateRef : current.taxRateRef,
      };
      if (nextTax.mode === "taxcode") {
        if (current.taxMode !== "taxcode" && !taxModeAllowed(current.environment)) {
          throw unprocessable("Sales tax sync stays off for live QuickBooks companies until it has been checked against a QuickBooks sandbox");
        }
        if (!nextTax.taxableCodeRef || !nextTax.nontaxableCodeRef || !nextTax.taxRateRef) throw unprocessable("Choose all three sales tax codes before turning on sales tax sync");
      }
      const turnedOn = current.taxMode !== "taxcode" && nextTax.mode === "taxcode";
      if (body.plans?.length) {
        const known = await db.selectFrom("plans").select("id").where("organizationId", "=", organizationId).where("id", "in", body.plans.map((p) => p.planId)).execute();
        if (known.length !== new Set(body.plans.map((p) => p.planId)).size) throw notFound("Plan");
      }
      if (body.serviceItems?.length) {
        const ids = body.serviceItems.map((i) => i.serviceItemId);
        const known = await db.selectFrom("serviceItems").select("id").where("organizationId", "=", organizationId).where("id", "in", ids).execute();
        if (known.length !== new Set(ids).size) throw notFound("Service item");
      }
      await db.transaction().execute(async (trx) => {
        const at = now();
        const conn: Record<string, unknown> = { updatedAt: at };
        if (body.syncFrom) conn.syncFrom = body.syncFrom;
        if (body.defaultItemId !== undefined) {
          conn.defaultItemId = body.defaultItemId;
          conn.defaultItemName = body.defaultItemId ? names.get(body.defaultItemId)! : null;
        }
        if (body.refundItemId !== undefined) {
          conn.refundItemId = body.refundItemId;
          conn.refundItemName = body.refundItemId ? names.get(body.refundItemId)! : null;
        }
        for (const key of ["stripeRefundAccount", "manualRefundAccount"] as const) {
          const chosen = body[`${key}Id`];
          if (chosen === undefined) continue;
          conn[`${key}Id`] = chosen;
          conn[`${key}Name`] = chosen ? accountNames.get(chosen)! : null;
        }
        if (body.taxMode !== undefined) conn.taxMode = body.taxMode;
        for (const key of ["taxableCode", "nontaxableCode", "taxRate"] as const) {
          const chosen = body[`${key}Ref`];
          if (chosen === undefined) continue;
          conn[`${key}Ref`] = chosen;
          conn[`${key}Name`] = chosen ? codeNames.get(chosen)! : null;
        }
        await trx.updateTable("quickbooksConnections").set(conn).where("organizationId", "=", organizationId).execute();
        // A plan or service item link is a choice of item, not a sent record; several may share one item.
        const choices = [
          ...(body.plans ?? []).map((p) => ({ entityType: "plan" as const, entityId: p.planId, itemId: p.itemId })),
          ...(body.serviceItems ?? []).map((i) => ({ entityType: "service_item" as const, entityId: i.serviceItemId, itemId: i.itemId })),
        ];
        for (const { entityType, entityId, itemId } of choices) {
          if (!itemId) {
            await trx.deleteFrom("quickbooksLinks").where("organizationId", "=", organizationId).where("entityType", "=", entityType).where("entityId", "=", entityId).execute();
            continue;
          }
          const values = { status: "synced" as const, externalId: itemId, conflict: JSON.stringify({ itemName: names.get(itemId) }), lastSyncedAt: at, updatedAt: at };
          await trx
            .insertInto("quickbooksLinks")
            .values({ organizationId, entityType, entityId, ...values, createdAt: at })
            .onConflict((oc) => oc.columns(["organizationId", "entityType", "entityId"]).doUpdateSet(values))
            .execute();
        }
        // Invoices waiting on an item can go now.
        await trx
          .updateTable("quickbooksLinks")
          .set({ status: "queued", conflictKind: null, conflict: null, updatedAt: at })
          .where("organizationId", "=", organizationId)
          .where("entityType", "=", "invoice")
          .where("conflictKind", "=", "item_missing")
          .execute();
        // Turning sales tax on sends the taxed invoices that waited for it. One already entered
        // in QuickBooks by hand under the same number is found there, not created again.
        if (turnedOn) {
          await trx
            .updateTable("quickbooksLinks")
            .set({ status: "queued", conflictKind: null, conflict: null, updatedAt: at })
            .where("organizationId", "=", organizationId)
            .where("entityType", "=", "invoice")
            .where("status", "=", "conflict")
            .where("conflictKind", "=", "tax_mapping_missing")
            .execute();
        }
        await audit(trx, req, { action: "quickbooks.mapping_changed", entityType: "organization", entityId: organizationId, changes: body });
        await queueQuickBooksSync(trx, organizationId, at);
      });
      return mapping(organizationId);
    },
  );

  // ---- First sync: review the matches, then commit ----

  async function review(organizationId: string) {
    const conn = await db.selectFrom("quickbooksConnections").select(["reviewFetchedAt", "reviewRemoteCount"]).where("organizationId", "=", organizationId).executeTakeFirst();
    if (!conn) throw unprocessable("QuickBooks is not connected");
    const links = await db
      .selectFrom("quickbooksLinks as l")
      .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "l.entityId").onRef("c.organizationId", "=", "l.organizationId"))
      .select(["l.entityId", "l.decision", "l.externalId", "l.conflict", "c.displayName"])
      .where("l.organizationId", "=", organizationId)
      .where("l.entityType", "=", "customer")
      .where("l.status", "=", "new")
      .orderBy("c.displayName")
      .execute();
    const payloads = await customerPayloads(db, organizationId, links.map((l) => l.entityId));
    const order = { review: 0, exact: 1, none: 2 } as const;
    const rows = links.map((l) => {
      const s = (l.conflict ?? { found: "none", candidates: [] }) as ReviewState;
      const p = payloads.get(l.entityId);
      return {
        customer: { id: l.entityId, displayName: l.displayName, email: p?.email ?? null, phone: p?.phone ?? null },
        found: s.found,
        decision: l.decision,
        match: s.candidates.find((c) => c.id === l.externalId) ?? null,
        candidates: s.candidates,
      };
    });
    // Possible matches first, then the exact ones to glance over, then the new customers. The
    // order does not depend on the choices, so rows stay put while someone works down the list.
    rows.sort((a, b) => order[a.found] - order[b.found] || a.customer.displayName.localeCompare(b.customer.displayName));
    return {
      fetchedAt: conn.reviewFetchedAt?.toISOString() ?? null,
      remoteCustomers: conn.reviewRemoteCount ?? 0,
      counts: await reviewCounts(ctx(), organizationId),
      rows,
    };
  }

  app.get(
    "/quickbooks/review",
    { config: { permission: "quickbooks:read" }, schema: { tags: ["quickbooks"], summary: "First sync: each customer's proposed QuickBooks match", response: { 200: quickbooksReview } } },
    async (req) => review(req.requireAuth().organizationId),
  );

  app.post(
    "/quickbooks/review/refresh",
    { config: { permission: "quickbooks:write" }, schema: { tags: ["quickbooks"], summary: "First sync: read QuickBooks' customers and propose matches", body: empty, response: { 200: quickbooksReview } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      try {
        await refreshReview(ctx(), organizationId);
      } catch (err) {
        asHttp(err);
      }
      return review(organizationId);
    },
  );

  app.put(
    "/quickbooks/review/:customerId",
    {
      config: { permission: "quickbooks:write" },
      schema: { tags: ["quickbooks"], summary: "First sync: link a customer to a QuickBooks customer, create it, or skip it", params: z.object({ customerId: id }), body: quickbooksReviewDecision, response: { 204: z.null() } },
    },
    async (req, reply) => {
      try {
        await decide(ctx(), req.requireAuth().organizationId, req.params.customerId, req.body);
      } catch (err) {
        asHttp(err);
      }
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/quickbooks/review/commit",
    {
      config: { permission: "quickbooks:write" },
      schema: {
        tags: ["quickbooks"],
        summary: "First sync: accept the review and start syncing",
        description: "Matched customers are linked as they are, the rest are created, skipped ones never sync, and undecided ones go to the conflict center.",
        body: empty,
        response: { 200: z.object({ matched: z.number().int(), create: z.number().int(), skipped: z.number().int(), undecided: z.number().int() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      let counts;
      try {
        counts = await commitReview(ctx(), organizationId);
      } catch (err) {
        asHttp(err);
      }
      await audit(db, req, { action: "quickbooks.first_sync_committed", entityType: "organization", entityId: organizationId, changes: counts });
      await queueQuickBooksSync(db, organizationId, now());
      return counts;
    },
  );

  // ---- Sync health and the conflict center ----

  app.get(
    "/quickbooks/records",
    {
      config: { permission: "quickbooks:read" },
      schema: {
        tags: ["quickbooks"],
        summary: "Synced records: by default only what needs a person (conflicts, and failures with no retry left)",
        querystring: z.object({
          view: z.enum(["attention", "all"]).default("attention"),
          status: z.enum(QUICKBOOKS_SYNC_STATUSES).optional(),
          entityType: z.enum(QUICKBOOKS_ENTITY_TYPES).optional(),
          entityId: id.optional(),
        }),
        response: { 200: z.array(quickbooksRecord) },
      },
    },
    async (req) => {
      const q = req.query;
      return listQuickBooksRecords(db, req.requireAuth().organizationId, { attention: q.view === "attention" && !q.entityId, status: q.status, entityType: q.entityType, entityId: q.entityId });
    },
  );

  app.post(
    "/quickbooks/records/:id/resolve",
    {
      config: { permission: "quickbooks:write" },
      schema: { tags: ["quickbooks"], summary: "Decide a conflict, retry a failure, or stop syncing a record", params: z.object({ id }), body: quickbooksResolveInput, response: { 200: quickbooksRecord } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      try {
        if (req.body.action === "recheck") await recheckInvoice(ctx(), organizationId, req.params.id);
        else await resolveLink(ctx(), organizationId, req.params.id, req.body);
      } catch (err) {
        asHttp(err);
      }
      await audit(db, req, { action: "quickbooks.record_resolved", entityType: "quickbooks_link", entityId: req.params.id, changes: req.body });
      await queueQuickBooksSync(db, organizationId, now());
      const [r] = await listQuickBooksRecordById(db, organizationId, req.params.id);
      return r!;
    },
  );

  app.post(
    "/quickbooks/sync",
    { config: { permission: "quickbooks:write" }, schema: { tags: ["quickbooks"], summary: "Sync now instead of waiting for the next run", body: empty, response: { 200: quickbooksStatus } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const conn = await db.selectFrom("quickbooksConnections").select(["status", "setupState"]).where("organizationId", "=", organizationId).executeTakeFirst();
      if (conn?.status !== "connected") throw unprocessable("QuickBooks is not connected");
      if (conn.setupState !== "active") throw unprocessable("Finish the first-sync review first");
      await queueQuickBooksSync(db, organizationId, now());
      return status(organizationId);
    },
  );
};

/**
 * Sales tax sync is off for live QuickBooks companies until gate G-QBO-TAX: a sandbox round
 * trip, including automated sales tax, recorded by Codex. Lifting this is a reviewed code change.
 */
const taxModeAllowed = (environment: "test" | "sandbox" | "production") => environment !== "production";

async function listQuickBooksRecordById(db: Database, organizationId: string, linkId: string) {
  const link = await db.selectFrom("quickbooksLinks").select(["entityType", "entityId"]).where("organizationId", "=", organizationId).where("id", "=", linkId).executeTakeFirstOrThrow();
  return listQuickBooksRecords(db, organizationId, { entityType: link.entityType, entityId: link.entityId, limit: 1 });
}
