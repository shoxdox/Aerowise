import type { QuickbooksLinksTable } from "@aerowise/db";
import { matchCustomer, normalizeName, PAYMENT_METHOD_LABELS, QUICKBOOKS_RETRY_MINUTES, type MatchReason, type QuickBooksConflictKind } from "@aerowise/domain";
import { sql, type Selectable } from "kysely";
import { openCompany, type QuickBooksContext } from "./connection.ts";
import { customerPayloads, payloadHash } from "./records.ts";
import { QuickBooksError, type CustomerPayload, type QboCustomer, type QboItem, type QuickBooksCompany } from "./types.ts";

export type Link = Selectable<QuickbooksLinksTable>;

/** Records sent per type in one run; a run that hits it asks for another straight away. */
const BATCH = 100;
/** A run holds the company this long at most; a crashed run's lock lapses after it. */
const LOCK_MS = 10 * 60_000;

const formatAddress = (a: QboCustomer["address"]) => (a ? [a.line1, a.line2, [a.city, [a.state, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", ") || null : null);

/** A QuickBooks customer as offered to a person, with what is needed to link to it. */
export function candidateOf(c: QboCustomer, score = 1, reasons: MatchReason[] = []) {
  return { id: c.id, name: c.name, email: c.email, phone: c.phone, address: formatAddress(c.address), score, reasons, syncToken: c.syncToken, updatedAt: c.updatedAt };
}
export type StoredCandidate = ReturnType<typeof candidateOf>;

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const dateIn = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Writes a link's outcome. Every outcome clears what the previous one left. */
export class LinkWriter {
  constructor(private readonly ctx: QuickBooksContext) {}

  private async set(link: Pick<Link, "id">, patch: Partial<Omit<Link, "id" | "conflict">> & { conflict?: string | null }) {
    await this.ctx.db
      .updateTable("quickbooksLinks")
      .set({ ...patch, updatedAt: this.ctx.now() })
      .where("id", "=", link.id)
      .execute();
  }

  synced(link: Pick<Link, "id">, patch: Partial<Pick<Link, "externalId" | "syncToken" | "pushedHash" | "remoteUpdatedAt" | "remoteState">> = {}) {
    const now = this.ctx.now();
    return this.set(link, { status: "synced", conflictKind: null, conflict: null, syncError: null, retryCount: 0, nextAttemptAt: null, force: false, lastSyncedAt: now, ...patch });
  }

  conflict(link: Pick<Link, "id">, kind: QuickBooksConflictKind, details: Record<string, unknown>) {
    return this.set(link, { status: "conflict", conflictKind: kind, conflict: JSON.stringify(details), syncError: null, nextAttemptAt: null, force: false });
  }

  /** Waiting on another record (its customer or invoice) to reach QuickBooks first. */
  waiting(link: Pick<Link, "id">, why: string) {
    return this.set(link, { status: "queued", conflictKind: null, conflict: null, syncError: why });
  }

  ignored(link: Pick<Link, "id">, why: string | null) {
    return this.set(link, { status: "ignored", conflictKind: null, conflict: null, syncError: why, nextAttemptAt: null, force: false });
  }

  /** Temporary trouble is retried on a schedule; anything else waits for a person. */
  failed(link: Pick<Link, "id" | "retryCount">, err: unknown) {
    const transient = err instanceof QuickBooksError && err.kind === "transient";
    const delay = transient ? QUICKBOOKS_RETRY_MINUTES[link.retryCount] : undefined;
    const message = err instanceof QuickBooksError ? err.message : `Unexpected error: ${(err as Error).message ?? String(err)}`;
    return this.set(link, {
      status: "failed",
      conflictKind: null,
      conflict: null,
      syncError: message.slice(0, 1000),
      retryCount: link.retryCount + 1,
      nextAttemptAt: delay === undefined ? null : new Date(this.ctx.now().getTime() + delay * 60_000),
    });
  }
}

/**
 * One sync run for one organization: read what changed in QuickBooks, find what Aerowise
 * has that QuickBooks should have, and send it (customers, then invoices, then payments).
 * Returns whether there is more to send than one run takes.
 */
export async function syncOrganization(ctx: QuickBooksContext, organizationId: string): Promise<{ ran: boolean; more: boolean; error: string | null }> {
  const now = ctx.now();
  const conn = await ctx.db
    .updateTable("quickbooksConnections")
    .set({ syncLockUntil: new Date(now.getTime() + LOCK_MS), lastSyncStartedAt: now, updatedAt: now })
    .where("organizationId", "=", organizationId)
    .where("status", "=", "connected")
    .where("setupState", "=", "active")
    .where((eb) => eb.or([eb("syncLockUntil", "is", null), eb("syncLockUntil", "<", now)]))
    .returningAll()
    .executeTakeFirst();
  if (!conn) return { ran: false, more: false, error: null };
  let more = false;
  let error: string | null = null;
  try {
    const company = await openCompany(ctx, organizationId);
    const org = await ctx.db.selectFrom("organizations").select("timezone").where("id", "=", organizationId).executeTakeFirstOrThrow();
    const run = new SyncRun(ctx, company, organizationId, org.timezone, conn.defaultItemId);
    await run.readChanges(conn.changesSince ?? conn.connectedAt);
    await run.discover(conn.syncFrom);
    more = await run.push();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await ctx.db
      .updateTable("quickbooksConnections")
      .set({ syncLockUntil: null, lastSyncFinishedAt: ctx.now(), lastSyncError: error, updatedAt: ctx.now() })
      .where("organizationId", "=", organizationId)
      .execute();
  }
  return { ran: true, more, error };
}

class SyncRun {
  private readonly write: LinkWriter;
  private readonly items = new Map<string, QboItem | null>();

  constructor(
    private readonly ctx: QuickBooksContext,
    private readonly company: QuickBooksCompany,
    private readonly org: string,
    private readonly timezone: string,
    private readonly defaultItemId: string | null,
  ) {
    this.write = new LinkWriter(ctx);
  }

  private link(type: Link["entityType"], entityId: string) {
    return this.ctx.db.selectFrom("quickbooksLinks").selectAll().where("organizationId", "=", this.org).where("entityType", "=", type).where("entityId", "=", entityId).executeTakeFirst();
  }

  /** Edits and deletions made in QuickBooks since the last run (QuickBooks change data capture). */
  async readChanges(since: Date) {
    const started = this.ctx.now();
    const changes = await this.company.changes(since);
    for (const c of changes.customers) {
      const link = await this.ctx.db.selectFrom("quickbooksLinks").selectAll().where("organizationId", "=", this.org).where("entityType", "=", "customer").where("externalId", "=", c.id).executeTakeFirst();
      if (!link || !["synced", "queued", "failed"].includes(link.status)) continue;
      if (!c.active) {
        await this.write.conflict(link, "deleted_in_quickbooks", { name: c.name });
        continue;
      }
      if (c.syncToken === link.syncToken || link.status !== "synced") continue;
      const local = (await customerPayloads(this.ctx.db, this.org, [link.entityId])).get(link.entityId);
      if (local && payloadHash(local) !== link.pushedHash) {
        await this.write.conflict(link, "changed_in_both", changedInBoth(local, c));
      } else {
        // Changed only in QuickBooks: nothing to send, so take it as the new starting point.
        await this.write.synced(link, { syncToken: c.syncToken, remoteUpdatedAt: c.updatedAt });
      }
    }
    for (const i of changes.invoices) {
      if (!i.deleted) continue;
      const link = await this.ctx.db.selectFrom("quickbooksLinks").selectAll().where("organizationId", "=", this.org).where("entityType", "=", "invoice").where("externalId", "=", i.id).executeTakeFirst();
      if (!link || link.status !== "synced") continue;
      const inv = await this.ctx.db.selectFrom("invoices").select("status").where("id", "=", link.entityId).executeTakeFirstOrThrow();
      if (inv.status === "void") await this.write.synced(link, { remoteState: "deleted" });
      else await this.write.conflict(link, "deleted_in_quickbooks", {});
    }
    await this.ctx.db.updateTable("quickbooksConnections").set({ changesSince: started }).where("organizationId", "=", this.org).execute();
  }

  /** Queues what QuickBooks does not have yet, and what changed in Aerowise since it was sent. */
  async discover(syncFrom: string) {
    const { db } = this.ctx;
    const org = this.org;
    // Issued invoices from the sync start date on.
    await sql`
      insert into quickbooks_links (organization_id, entity_type, entity_id, status)
      select i.organization_id, 'invoice', i.id, 'queued' from invoices i
      where i.organization_id = ${org} and i.status = 'open' and i.issued_on >= ${syncFrom}
        and not exists (select 1 from quickbooks_links l where l.organization_id = i.organization_id and l.entity_type = 'invoice' and l.entity_id = i.id)
      on conflict do nothing`.execute(db);
    // Their customers, matched or created as they are needed.
    await sql`
      insert into quickbooks_links (organization_id, entity_type, entity_id, status)
      select distinct i.organization_id, 'customer', i.customer_id, 'queued' from invoices i
      join quickbooks_links il on il.organization_id = i.organization_id and il.entity_type = 'invoice' and il.entity_id = i.id and il.status <> 'ignored'
      where i.organization_id = ${org}
        and not exists (select 1 from quickbooks_links l where l.organization_id = i.organization_id and l.entity_type = 'customer' and l.entity_id = i.customer_id)
      on conflict do nothing`.execute(db);
    // Cleared payments on invoices that go to QuickBooks.
    await sql`
      insert into quickbooks_links (organization_id, entity_type, entity_id, status)
      select p.organization_id, 'payment', p.id, 'queued' from payments p
      join quickbooks_links il on il.organization_id = p.organization_id and il.entity_type = 'invoice' and il.entity_id = p.invoice_id and il.status <> 'ignored'
      where p.organization_id = ${org} and p.status = 'succeeded'
        and not exists (select 1 from quickbooks_links l where l.organization_id = p.organization_id and l.entity_type = 'payment' and l.entity_id = p.id)
      on conflict do nothing`.execute(db);
    // Payments refunded in Aerowise after they were sent (links from before this check hold the full amount).
    await sql`
      update quickbooks_links l set status = 'queued', updated_at = ${this.ctx.now()}
      from payments p
      where l.organization_id = ${org} and l.entity_type = 'payment' and l.status = 'synced' and l.external_id is not null
        and p.organization_id = l.organization_id and p.id = l.entity_id
        and coalesce(l.pushed_hash, p.amount_cents::text) <> (p.amount_cents - p.refunded_cents)::text`.execute(db);
    // Invoices voided in Aerowise after they were sent.
    await sql`
      update quickbooks_links l set status = 'queued', updated_at = ${this.ctx.now()}
      from invoices i
      where l.organization_id = ${org} and l.entity_type = 'invoice' and l.status = 'synced' and l.remote_state = 'open'
        and i.organization_id = l.organization_id and i.id = l.entity_id and i.status = 'void'`.execute(db);
    // Customers edited in Aerowise since they were sent.
    const synced = await db.selectFrom("quickbooksLinks").select(["id", "entityId", "pushedHash"]).where("organizationId", "=", org).where("entityType", "=", "customer").where("status", "=", "synced").execute();
    for (let i = 0; i < synced.length; i += 500) {
      const chunk = synced.slice(i, i + 500);
      const payloads = await customerPayloads(db, org, chunk.map((l) => l.entityId));
      const changed = chunk.filter((l) => {
        const p = payloads.get(l.entityId);
        return p && payloadHash(p) !== l.pushedHash;
      });
      if (changed.length) {
        await db
          .updateTable("quickbooksLinks")
          .set({ status: "queued", lastSourceModifiedAt: this.ctx.now(), updatedAt: this.ctx.now() })
          .where("id", "in", changed.map((l) => l.id))
          .execute();
      }
    }
  }

  private due(type: Link["entityType"]) {
    const now = this.ctx.now();
    return this.ctx.db
      .selectFrom("quickbooksLinks")
      .selectAll()
      .where("organizationId", "=", this.org)
      .where("entityType", "=", type)
      .where((eb) =>
        eb.or([
          eb("status", "=", "queued"),
          eb.and([eb("status", "=", "failed"), eb("nextAttemptAt", "<=", now)]),
          // A run that died mid-send.
          eb.and([eb("status", "=", "syncing"), eb("updatedAt", "<", new Date(now.getTime() - LOCK_MS))]),
        ]),
      )
      .orderBy("createdAt")
      .limit(BATCH)
      .execute();
  }

  /** Sends due records in dependency order. Auth trouble stops the run; anything else stops one record. */
  async push(): Promise<boolean> {
    let more = false;
    for (const [type, send] of [
      ["customer", (l: Link) => this.pushCustomer(l)],
      ["invoice", (l: Link) => this.pushInvoice(l)],
      ["payment", (l: Link) => this.pushPayment(l)],
    ] as const) {
      const links = await this.due(type);
      if (links.length === BATCH) more = true;
      for (const link of links) {
        await this.ctx.db.updateTable("quickbooksLinks").set({ status: "syncing", updatedAt: this.ctx.now() }).where("id", "=", link.id).execute();
        try {
          await send(link);
        } catch (err) {
          if (err instanceof QuickBooksError && err.kind === "auth") {
            await this.ctx.db.updateTable("quickbooksLinks").set({ status: "queued", updatedAt: this.ctx.now() }).where("id", "=", link.id).execute();
            throw err;
          }
          await this.write.failed(link, err);
        }
      }
    }
    return more;
  }

  private async takenExternalIds(ids: string[], exceptLinkId: string) {
    if (!ids.length) return new Set<string>();
    const rows = await this.ctx.db
      .selectFrom("quickbooksLinks")
      .select("externalId")
      .where("organizationId", "=", this.org)
      .where("entityType", "=", "customer")
      .where("externalId", "in", ids)
      .where("id", "<>", exceptLinkId)
      .execute();
    return new Set(rows.map((r) => r.externalId!));
  }

  async pushCustomer(link: Link) {
    const p = (await customerPayloads(this.ctx.db, this.org, [link.entityId])).get(link.entityId);
    if (!p) return this.write.ignored(link, "The customer no longer exists");
    const hash = payloadHash(p);
    const requestId = `aw-${link.id}-${link.generation}`;

    if (!link.externalId) {
      let found: QboCustomer[] = [];
      if (link.decision !== "create") {
        // Never add a customer QuickBooks may already have: match first, ask when unsure.
        found = await this.company.findCustomers(p.displayName, p.email);
        const taken = await this.takenExternalIds(found.map((c) => c.id), link.id);
        const m = matchCustomer({ name: p.displayName, email: p.email, phone: p.phone }, found.filter((c) => !taken.has(c.id)));
        if (m.kind === "exact") {
          return this.write.synced(link, { externalId: m.match.customer.id, syncToken: m.match.customer.syncToken, remoteUpdatedAt: m.match.customer.updatedAt, pushedHash: hash });
        }
        if (m.kind === "review") {
          return this.write.conflict(link, "ambiguous_match", { candidates: m.candidates.map((c) => candidateOf(c.customer, c.score, c.reasons)) });
        }
      }
      // QuickBooks wants display names unique; a customer created on purpose gets a suffix if needed.
      for (let n = 1; ; n++) {
        const named = n === 1 ? p : { ...p, displayName: `${p.displayName} (${n})` };
        try {
          const created = await this.company.createCustomer(named, n === 1 ? requestId : `${requestId}-${n}`);
          return this.write.synced(link, { externalId: created.id, syncToken: created.syncToken, remoteUpdatedAt: created.updatedAt, pushedHash: hash });
        } catch (err) {
          if (!(err instanceof QuickBooksError && err.kind === "duplicate_name")) throw err;
          if (link.decision === "create" && n < 5) continue;
          if (!found.length) found = await this.company.findCustomers(p.displayName, p.email);
          const same = found.filter((c) => normalizeName(c.name) === normalizeName(p.displayName));
          if (!same.length) throw err;
          return this.write.conflict(link, "ambiguous_match", { candidates: same.map((c) => candidateOf(c, 1, ["same_name"])) });
        }
      }
    }

    if (hash === link.pushedHash && !link.force) return this.write.synced(link);
    const remote = await this.company.getCustomer(link.externalId);
    if (!remote || !remote.active) return this.write.conflict(link, "deleted_in_quickbooks", { name: remote?.name ?? null });
    if (remote.syncToken !== link.syncToken && !link.force) return this.write.conflict(link, "changed_in_both", changedInBoth(p, remote));
    try {
      const updated = await this.company.updateCustomer(link.externalId, remote.syncToken, p);
      return this.write.synced(link, { syncToken: updated.syncToken, remoteUpdatedAt: updated.updatedAt, pushedHash: hash });
    } catch (err) {
      if (err instanceof QuickBooksError && err.kind === "stale") {
        const now = await this.company.getCustomer(link.externalId);
        if (now) return this.write.conflict(link, "changed_in_both", changedInBoth(p, now));
      }
      throw err;
    }
  }

  private async item(id: string) {
    if (!this.items.has(id)) this.items.set(id, await this.company.getItem(id));
    return this.items.get(id)!;
  }

  async pushInvoice(link: Link) {
    const { db } = this.ctx;
    const inv = await db
      .selectFrom("invoices")
      .select(["id", "status", "customerId", "siteId", "number", "snapshot", "taxCents", "discountCents", "totalCents", "issuedOn", "dueOn", "memo"])
      .where("organizationId", "=", this.org)
      .where("id", "=", link.entityId)
      .executeTakeFirst();
    if (!inv) return this.write.ignored(link, "The invoice no longer exists");

    if (inv.status === "void") {
      if (!link.externalId) return this.write.ignored(link, "Voided before it was sent to QuickBooks");
      const remote = await this.company.getInvoice(link.externalId);
      if (!remote) return this.write.synced(link, { remoteState: "deleted" });
      if (remote.voided) return this.write.synced(link, { remoteState: "void", syncToken: remote.syncToken });
      const voided = await this.company.voidInvoice(link.externalId, remote.syncToken);
      return this.write.synced(link, { remoteState: "void", syncToken: voided.syncToken });
    }
    if (inv.status !== "open") return this.write.ignored(link, "Drafts are not sent to QuickBooks");
    if (link.externalId) return this.write.synced(link);

    const customer = await this.link("customer", inv.customerId);
    if (customer?.status === "ignored") return this.write.ignored(link, "The customer is set not to sync to QuickBooks");
    if (customer?.status !== "synced" || !customer.externalId) return this.write.waiting(link, "Waiting for the customer to reach QuickBooks");

    if (inv.taxCents > 0) return this.write.conflict(link, "tax_mapping_missing", { taxCents: inv.taxCents });

    const lines = await db
      .selectFrom("invoiceLines as l")
      .leftJoin("contracts as c", (j) => j.onRef("c.id", "=", "l.contractId").onRef("c.organizationId", "=", "l.organizationId"))
      .leftJoin("plans as p", (j) => j.onRef("p.id", "=", "c.planId").onRef("p.organizationId", "=", "c.organizationId"))
      .select(["l.description", "l.quantity", "l.unitPriceCents", "l.amountCents", "c.planId", "p.name as planName"])
      .where("l.organizationId", "=", this.org)
      .where("l.invoiceId", "=", inv.id)
      .orderBy("l.position")
      .execute();
    const planIds = [...new Set(lines.map((l) => l.planId).filter((x): x is string => !!x))];
    const planItems = new Map<string, string>();
    if (planIds.length) {
      const rows = await db
        .selectFrom("quickbooksLinks")
        .select(["entityId", "externalId"])
        .where("organizationId", "=", this.org)
        .where("entityType", "=", "plan")
        .where("entityId", "in", planIds)
        .where("status", "=", "synced")
        .execute();
      for (const r of rows) if (r.externalId) planItems.set(r.entityId, r.externalId);
    }
    const mapped = lines.map((l) => ({ ...l, itemId: (l.planId && planItems.get(l.planId)) || this.defaultItemId }));
    const unmapped = mapped.filter((l) => !l.itemId);
    if (unmapped.length) {
      return this.write.conflict(link, "item_missing", { reason: "unmapped", lines: unmapped.map((l) => ({ description: l.description, plan: l.planName })) });
    }
    for (const id of new Set(mapped.map((l) => l.itemId!))) {
      const item = await this.item(id);
      if (!item || !item.active) {
        return this.write.conflict(link, "item_missing", { reason: item ? "inactive" : "deleted", itemId: id, itemName: item?.name ?? null, plans: [...new Set(mapped.filter((l) => l.itemId === id).map((l) => l.planName ?? "Other charges"))] });
      }
    }

    const snapshot = inv.snapshot as { number: string; billTo: { email: string | null } };
    const docNumber = snapshot.number;
    const existing = await this.company.findInvoiceByNumber(docNumber);
    if (existing) {
      if (existing.customerId === customer.externalId && existing.totalCents === inv.totalCents) {
        return this.write.synced(link, { externalId: existing.id, syncToken: existing.syncToken, remoteState: existing.voided ? "void" : "open", remoteUpdatedAt: existing.updatedAt });
      }
      return this.write.conflict(link, "duplicate_number", { docNumber, existing: { id: existing.id, syncToken: existing.syncToken, customerName: existing.customerName, totalCents: existing.totalCents } });
    }
    const site = inv.siteId
      ? await db.selectFrom("sites").select(["addressLine1", "addressLine2", "city", "state", "postalCode"]).where("organizationId", "=", this.org).where("id", "=", inv.siteId).executeTakeFirst()
      : undefined;
    const created = await this.company.createInvoice(
      {
        customerId: customer.externalId,
        docNumber,
        txnDate: inv.issuedOn!,
        dueDate: inv.dueOn!,
        lines: mapped.map((l) => ({ itemId: l.itemId!, description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, amountCents: l.amountCents })),
        discountCents: inv.discountCents,
        memo: inv.memo,
        privateNote: `Aerowise invoice ${docNumber}`,
        billEmail: snapshot.billTo.email,
        shipAddress: site ? { line1: site.addressLine1, line2: site.addressLine2, city: site.city, state: site.state, postalCode: site.postalCode } : null,
      },
      `aw-${link.id}-${link.generation}`,
    );
    return this.write.synced(link, { externalId: created.id, syncToken: created.syncToken, remoteState: "open", remoteUpdatedAt: created.updatedAt });
  }

  async pushPayment(link: Link) {
    const { db } = this.ctx;
    const p = await db
      .selectFrom("payments as p")
      .innerJoin("invoices as i", (j) => j.onRef("i.id", "=", "p.invoiceId").onRef("i.organizationId", "=", "p.organizationId"))
      .select(["p.id", "p.status", "p.amountCents", "p.refundedCents", "p.method", "p.reference", "p.providerPaymentId", "p.receivedOn", "p.succeededAt", "p.invoiceId", "i.customerId", "i.number"])
      .where("p.organizationId", "=", this.org)
      .where("p.id", "=", link.entityId)
      .executeTakeFirst();
    if (!p || p.status !== "succeeded") return this.write.ignored(link, "Only cleared payments are sent to QuickBooks");
    // What the customer kept paying: refunds come off the payment, so QuickBooks shows the balance Aerowise does.
    const net = p.amountCents - p.refundedCents;
    const label = PAYMENT_METHOD_LABELS[p.method];
    const refunded = p.refundedCents > 0 ? `; ${usd(p.refundedCents)} refunded, ${usd(net)} kept` : "";
    const privateNote = `Aerowise ${label.toLowerCase()} payment on INV-${p.number}${p.providerPaymentId ? ` (Stripe ${p.providerPaymentId})` : ""}${refunded}`;
    if (link.externalId) return this.refundPayment(link, { invoiceId: p.invoiceId, number: p.number, amountCents: p.amountCents, refundedCents: p.refundedCents }, privateNote);
    if (net === 0) return this.write.ignored(link, "Refunded in full before it reached QuickBooks");
    const invLink = await this.link("invoice", p.invoiceId);
    if (invLink?.status === "ignored") return this.write.ignored(link, "The invoice is not synced to QuickBooks");
    if (invLink?.status !== "synced" || !invLink.externalId) return this.write.waiting(link, "Waiting for the invoice to reach QuickBooks");
    const custLink = await this.link("customer", p.customerId);
    if (custLink?.status !== "synced" || !custLink.externalId) return this.write.waiting(link, "Waiting for the customer to reach QuickBooks");

    const remote = await this.company.getInvoice(invLink.externalId);
    if (!remote) {
      await this.write.conflict(invLink, "deleted_in_quickbooks", {});
      return this.write.waiting(link, "The invoice was deleted in QuickBooks");
    }
    if (net > remote.balanceCents && !link.force) {
      return this.write.conflict(link, "payment_mismatch", { paymentCents: net, balanceCents: remote.balanceCents, docNumber: remote.docNumber });
    }
    const created = await this.company.createPayment(
      {
        customerId: custLink.externalId,
        invoiceId: invLink.externalId,
        amountCents: net,
        txnDate: p.receivedOn ?? dateIn(p.succeededAt ?? this.ctx.now(), this.timezone),
        reference: p.reference ?? (p.providerPaymentId ? p.providerPaymentId.slice(-21) : null),
        privateNote,
      },
      `aw-${link.id}-${link.generation}`,
    );
    return this.write.synced(link, { externalId: created.id, syncToken: created.syncToken, pushedHash: String(net) });
  }

  /**
   * A payment already in QuickBooks that was refunded since: lower it to what was kept, or
   * delete it when nothing was. A payment someone changed in QuickBooks is never overwritten
   * without a person choosing to.
   */
  private async refundPayment(link: Link, p: { invoiceId: string; number: number | null; amountCents: number; refundedCents: number }, privateNote: string) {
    const net = p.amountCents - p.refundedCents;
    const remote = await this.company.getPayment(link.externalId!);
    if (!remote) return this.write.conflict(link, "deleted_in_quickbooks", {});
    const invLink = await this.link("invoice", p.invoiceId);
    if (!invLink?.externalId) return this.write.waiting(link, "Waiting for the invoice to reach QuickBooks");
    // What Aerowise last left there. Links from before refunds were synced hold the full amount.
    const sent = link.pushedHash === null ? p.amountCents : Number(link.pushedHash);
    const asSent =
      remote.syncToken === link.syncToken &&
      remote.amountCents === sent &&
      remote.applied.length === 1 &&
      remote.applied[0]!.invoiceId === invLink.externalId &&
      remote.applied[0]!.amountCents === sent;
    if (!asSent && !link.force) {
      const applied = remote.applied.map((a) => `${usd(a.amountCents)} to ${a.invoiceId === invLink.externalId ? `INV-${p.number}` : `another invoice (QuickBooks id ${a.invoiceId})`}`).join(", ");
      return this.write.conflict(link, "changed_in_both", {
        fields: [
          { field: "Amount", aerowise: `${usd(net)} (${usd(p.amountCents)} less ${usd(p.refundedCents)} refunded)`, quickbooks: usd(remote.amountCents) },
          { field: "Applied to", aerowise: `${usd(net)} to INV-${p.number}`, quickbooks: applied || "No invoice" },
        ],
        remoteSyncToken: remote.syncToken,
        remoteUpdatedAt: null,
        netCents: net,
      });
    }
    if (net === 0) {
      await this.company.deletePayment(remote.id, remote.syncToken);
      return this.write.synced(link, { pushedHash: "0", remoteState: "deleted" });
    }
    if (asSent && remote.amountCents === net) return this.write.synced(link, { syncToken: remote.syncToken, pushedHash: String(net) });
    const updated = await this.company.updatePayment(remote.id, remote.syncToken, { invoiceId: invLink.externalId, amountCents: net, privateNote });
    return this.write.synced(link, { syncToken: updated.syncToken, pushedHash: String(net) });
  }

}

/** Both versions of what differs, for the person deciding. */
export function changedInBoth(local: CustomerPayload, remote: QboCustomer) {
  const fields: { field: string; aerowise: string | null; quickbooks: string | null }[] = [];
  const add = (field: string, a: string | null, q: string | null) => {
    if ((a ?? "") !== (q ?? "")) fields.push({ field, aerowise: a, quickbooks: q });
  };
  add("Name", local.displayName, remote.name);
  add("Email", local.email, remote.email);
  add("Phone", local.phone, remote.phone);
  add("Billing address", formatAddress(local.address), formatAddress(remote.address));
  return { fields, remoteSyncToken: remote.syncToken, remoteUpdatedAt: remote.updatedAt };
}
