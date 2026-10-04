import type { Database, DB } from "@aerowise/db";
import { nextSmsTime, SMS_MAX_ATTEMPTS, smsAllowedAt, smsKeyword, toE164, type SmsKeyword, type SmsKind, type SmsSkipReason } from "@aerowise/domain";
import { sql, type ExpressionBuilder, type Transaction } from "kysely";
import { SmsSendError, UNSUBSCRIBED_CODE, type SmsProvider } from "./provider.ts";

type Executor = Database | Transaction<DB>;

export interface SmsConfig {
  provider: SmsProvider;
  /** The public address the provider calls back: replies and delivery receipts go under it. */
  webhookBaseUrl: string;
}

export const smsWebhookUrls = (base: string) => ({
  inbound: `${base.replace(/\/$/, "")}/webhooks/sms/inbound`,
  status: `${base.replace(/\/$/, "")}/webhooks/sms/status`,
});

/** One text about one thing: which kind, to which customer, about which record. */
export interface SmsRequest {
  kind: SmsKind;
  customerId: string;
  /** The property it is about; its own contacts are tried first. */
  siteId: string | null;
  relatedType: "job" | "inspection" | "report" | "renewal" | "invoice";
  relatedId: string;
  /** The same key is the same text. */
  dedupeKey: string;
  /** Asked for by a person (not automatic): goes even when this kind is not switched on. */
  manual?: boolean;
}

export async function smsSettingsOf(db: Executor, organizationId: string) {
  return db
    .selectFrom("organizations")
    .select(["smsEnabled", "smsKinds", "smsFromNumber", "timezone", "name"])
    .where("id", "=", organizationId)
    .executeTakeFirstOrThrow();
}

/** Whether texts of this kind go for this organization right now. */
export function smsKindOn(s: { smsEnabled: boolean; smsKinds: SmsKind[]; smsFromNumber: string | null }, kind: SmsKind, manual = false) {
  return s.smsEnabled && s.smsFromNumber !== null && (manual || s.smsKinds.includes(kind));
}

/** Contacts whose number is this one, however the office typed it. */
export function samePhone(eb: ExpressionBuilder<DB, "contacts">, e164: string) {
  const digits = e164.replace(/\D/g, "");
  // US numbers are compared on their last ten digits: (512) 555-0123 and +1 512 555 0123 are one.
  return e164.startsWith("+1") && digits.length === 11
    ? eb(sql`right(regexp_replace(contacts.phone, '\\D', '', 'g'), 10)`, "=", digits.slice(1))
    : eb(sql`regexp_replace(contacts.phone, '\\D', '', 'g')`, "=", digits);
}

export type Recipient = { ok: true; contactId: string; phone: string } | { ok: false; reason: SmsSkipReason; contactId: string | null; phone: string | null };

/**
 * Who gets a customer's text: the property's own contact first, then the primary, the
 * billing and any other contact, among those with a usable mobile number who agreed to
 * texts and have not replied STOP. When nobody can, says why (the most hopeful reason).
 */
export async function resolveRecipient(db: Executor, organizationId: string, customerId: string, siteId: string | null): Promise<Recipient> {
  const contacts = await db
    .selectFrom("contacts")
    .select(["id", "siteId", "phone", "type", "consentSms"])
    .where("organizationId", "=", organizationId)
    .where("customerId", "=", customerId)
    .where("phone", "is not", null)
    .orderBy("createdAt")
    .execute();
  const rank = (c: (typeof contacts)[number]) => (siteId && c.siteId === siteId ? 0 : 10) + (c.type === "primary" ? 0 : c.type === "billing" ? 1 : c.type === "site" ? 2 : 3);
  const withPhone = contacts
    .map((c) => ({ ...c, e164: toE164(c.phone) }))
    .filter((c): c is typeof c & { e164: string } => c.e164 !== null)
    .sort((a, b) => rank(a) - rank(b));
  if (withPhone.length === 0) return { ok: false, reason: "no_phone", contactId: null, phone: null };
  const consenting = withPhone.filter((c) => c.consentSms);
  if (consenting.length === 0) return { ok: false, reason: "no_consent", contactId: withPhone[0]!.id, phone: withPhone[0]!.e164 };
  const optedOut = new Set(
    (
      await db
        .selectFrom("smsOptOuts")
        .select("phone")
        .where("organizationId", "=", organizationId)
        .where(
          "phone",
          "in",
          consenting.map((c) => c.e164),
        )
        .execute()
    ).map((o) => o.phone),
  );
  const reachable = consenting.find((c) => !optedOut.has(c.e164));
  if (!reachable) return { ok: false, reason: "opted_out", contactId: consenting[0]!.id, phone: consenting[0]!.e164 };
  return { ok: true, contactId: reachable.id, phone: reachable.e164 };
}

const SKIP_BODY: Record<SmsSkipReason, string> = {
  no_phone: "Not sent: no mobile number on file.",
  no_consent: "Not sent: no contact has agreed to texts.",
  opted_out: "Not sent: this number replied STOP.",
};

/** Notes a text that could not go, once, so the office can see why a customer heard nothing. */
export async function recordSkip(db: Executor, organizationId: string, req: SmsRequest, r: Extract<Recipient, { ok: false }>) {
  await db
    .insertInto("smsMessages")
    .values({
      organizationId,
      direction: "outbound",
      kind: req.kind,
      customerId: req.customerId,
      contactId: r.contactId,
      phone: r.phone,
      body: SKIP_BODY[r.reason],
      status: "skipped",
      skipReason: r.reason,
      errorCode: null,
      errorMessage: null,
      provider: null,
      providerMessageId: null,
      relatedType: req.relatedType,
      relatedId: req.relatedId,
      dedupeKey: req.dedupeKey,
      sentAt: null,
      deliveredAt: null,
      handledAt: null,
      handledBy: null,
    })
    .onConflict((oc) => oc.columns(["organizationId", "dedupeKey"]).doNothing())
    .execute();
}

/** A number stops getting texts from this organization, and its contacts no longer agree to them. */
export async function optOut(db: Executor, organizationId: string, phone: string, source: "reply" | "carrier", now: Date) {
  await db.insertInto("smsOptOuts").values({ organizationId, phone, source, optedOutAt: now }).onConflict((oc) => oc.columns(["organizationId", "phone"]).doNothing()).execute();
  return db
    .updateTable("contacts")
    .set({ consentSms: false, updatedAt: now })
    .where("organizationId", "=", organizationId)
    .where("consentSms", "=", true)
    .where((eb) => samePhone(eb, phone))
    .returning(["id"])
    .execute();
}

/** The text to send, and the copy to keep (without any link that opens an account). */
export interface ComposedSms {
  body: string;
  stored: string;
}

export type DeliverOutcome = { status: "sent" | "delivered" | "failed" | "skipped" | "done" | "off" } | { status: "later"; at: Date };

/**
 * Sends one text, once. Safe to run again: the dedupe key finds the earlier attempt, and
 * only a send that did not finish is tried again. `compose` is called only when the text
 * will really go, so links it makes are never wasted on a skipped text; it returns null
 * when the text is no longer wanted (the invoice was paid meanwhile).
 */
export async function deliverSms(
  ctx: { db: Database; sms: SmsConfig; now: () => Date },
  organizationId: string,
  req: SmsRequest,
  compose: () => Promise<ComposedSms | null>,
): Promise<DeliverOutcome> {
  const { db } = ctx;
  const s = await smsSettingsOf(db, organizationId);
  // Turned off after the text was queued.
  if (!smsKindOn(s, req.kind, req.manual)) return { status: "off" };
  const existing = await db
    .selectFrom("smsMessages")
    .select(["id", "status", "attempts", "phone"])
    .where("organizationId", "=", organizationId)
    .where("dedupeKey", "=", req.dedupeKey)
    .executeTakeFirst();
  if (existing && existing.status !== "sending") return { status: "done" };
  // Automatic texts wait for the morning; one a person asked for goes now.
  if (req.kind !== "on_the_way" && !req.manual && !smsAllowedAt(ctx.now(), s.timezone)) return { status: "later", at: nextSmsTime(ctx.now(), s.timezone) };

  // Asked again just before sending: a STOP or a change of contact may have come in.
  const to = await resolveRecipient(db, organizationId, req.customerId, req.siteId);
  if (!to.ok) {
    if (existing) {
      await db
        .updateTable("smsMessages")
        .set({ status: "skipped", skipReason: to.reason, body: SKIP_BODY[to.reason], updatedAt: ctx.now() })
        .where("id", "=", existing.id)
        .execute();
    } else await recordSkip(db, organizationId, req, to);
    return { status: "skipped" };
  }
  const msg = await compose();
  if (!msg) return { status: "off" };

  let id = existing?.id;
  if (!id) {
    const row = await db
      .insertInto("smsMessages")
      .values({
        organizationId,
        direction: "outbound",
        kind: req.kind,
        customerId: req.customerId,
        contactId: to.contactId,
        phone: to.phone,
        body: msg.stored,
        status: "sending",
        skipReason: null,
        errorCode: null,
        errorMessage: null,
        provider: ctx.sms.provider.kind,
        providerMessageId: null,
        relatedType: req.relatedType,
        relatedId: req.relatedId,
        dedupeKey: req.dedupeKey,
        sentAt: null,
        deliveredAt: null,
        handledAt: null,
        handledBy: null,
      })
      .onConflict((oc) => oc.columns(["organizationId", "dedupeKey"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!row) return { status: "done" };
    id = row.id;
  } else {
    await db.updateTable("smsMessages").set({ contactId: to.contactId, phone: to.phone, body: msg.stored, updatedAt: ctx.now() }).where("id", "=", id).execute();
  }

  try {
    const sent = await ctx.sms.provider.send({ from: s.smsFromNumber!, to: to.phone, body: msg.body, statusCallback: smsWebhookUrls(ctx.sms.webhookBaseUrl).status });
    const at = ctx.now();
    await db
      .updateTable("smsMessages")
      .set({
        status: sent.status,
        providerMessageId: sent.providerMessageId,
        attempts: sql`attempts + 1`,
        errorCode: null,
        errorMessage: null,
        sentAt: at,
        deliveredAt: sent.status === "delivered" ? at : null,
        updatedAt: at,
      })
      .where("id", "=", id)
      .execute();
    return { status: sent.status };
  } catch (err) {
    if (!(err instanceof SmsSendError)) throw err;
    const at = ctx.now();
    const row = await db
      .updateTable("smsMessages")
      .set({ attempts: sql`attempts + 1`, errorCode: err.code, errorMessage: err.message.slice(0, 500), updatedAt: at })
      .where("id", "=", id)
      .returning("attempts")
      .executeTakeFirstOrThrow();
    if (err.permanent || row.attempts >= SMS_MAX_ATTEMPTS) {
      await db.updateTable("smsMessages").set({ status: "failed" }).where("id", "=", id).execute();
      if (err.code === UNSUBSCRIBED_CODE) await optOut(db, organizationId, to.phone, "carrier", at);
      return { status: "failed" };
    }
    // Temporary: the task is retried with backoff, and this row is picked up again.
    throw err;
  }
}

/** A text that came in: a STOP, a START, or something the office should read. */
export async function receiveSms(
  db: Database,
  m: { organizationId: string; from: string; body: string; providerMessageId: string | null; now: Date },
): Promise<{ id: string; keyword: SmsKeyword | null; customerId: string | null }> {
  const phone = toE164(m.from) ?? m.from;
  const keyword = smsKeyword(m.body);
  return db.transaction().execute(async (trx) => {
    const match = await trx
      .selectFrom("contacts")
      .select(["id", "customerId"])
      .where("organizationId", "=", m.organizationId)
      .where((eb) => samePhone(eb, phone))
      .orderBy("createdAt")
      .limit(1)
      .executeTakeFirst();
    const row = await trx
      .insertInto("smsMessages")
      .values({
        organizationId: m.organizationId,
        direction: "inbound",
        kind: null,
        customerId: match?.customerId ?? null,
        contactId: match?.id ?? null,
        phone,
        body: m.body.slice(0, 1600),
        status: "received",
        skipReason: null,
        errorCode: null,
        errorMessage: null,
        provider: null,
        providerMessageId: m.providerMessageId,
        relatedType: null,
        relatedId: null,
        dedupeKey: null,
        sentAt: null,
        deliveredAt: null,
        // STOP, START and HELP are handled here; nobody needs to answer them.
        handledAt: keyword ? m.now : null,
        handledBy: null,
      })
      .onConflict((oc) => oc.column("providerMessageId").doNothing())
      .returning("id")
      .executeTakeFirst();
    // The provider sent this one before.
    if (!row) {
      const prior = await trx.selectFrom("smsMessages").select(["id", "customerId"]).where("providerMessageId", "=", m.providerMessageId).executeTakeFirstOrThrow();
      return { id: prior.id, keyword: null, customerId: prior.customerId };
    }
    if (keyword === "stop") {
      const contacts = await optOut(trx, m.organizationId, phone, "reply", m.now);
      await systemAudit(trx, m.organizationId, "sms.opted_out", row.id, { phone, contacts: contacts.map((c) => c.id) });
    } else if (keyword === "start") {
      await trx.deleteFrom("smsOptOuts").where("organizationId", "=", m.organizationId).where("phone", "=", phone).execute();
      // Texting START is the customer agreeing to texts again.
      const contacts = await trx
        .updateTable("contacts")
        .set({ consentSms: true, updatedAt: m.now })
        .where("organizationId", "=", m.organizationId)
        .where((eb) => samePhone(eb, phone))
        .returning("id")
        .execute();
      await systemAudit(trx, m.organizationId, "sms.opted_in", row.id, { phone, contacts: contacts.map((c) => c.id) });
    }
    return { id: row.id, keyword, customerId: match?.customerId ?? null };
  });
}

/** A delivery receipt: the carrier delivered the text, or could not. */
export async function applyDeliveryStatus(db: Database, r: { providerMessageId: string; status: string; errorCode: string | null; now: Date }) {
  const msg = await db.selectFrom("smsMessages").select(["id", "organizationId", "status", "phone"]).where("providerMessageId", "=", r.providerMessageId).executeTakeFirst();
  if (!msg || msg.status === "delivered") return null;
  if (r.status === "delivered") {
    await db.updateTable("smsMessages").set({ status: "delivered", deliveredAt: r.now, updatedAt: r.now }).where("id", "=", msg.id).execute();
    return "delivered";
  }
  if (r.status === "undelivered" || r.status === "failed") {
    await db
      .updateTable("smsMessages")
      .set({ status: "failed", errorCode: r.errorCode, errorMessage: r.errorCode ? `Carrier error ${r.errorCode}` : "The carrier could not deliver it", updatedAt: r.now })
      .where("id", "=", msg.id)
      .execute();
    if (r.errorCode === UNSUBSCRIBED_CODE && msg.phone) await optOut(db, msg.organizationId, msg.phone, "carrier", r.now);
    return "failed";
  }
  return null;
}

async function systemAudit(db: Executor, organizationId: string, action: string, entityId: string, changes: Record<string, unknown>) {
  await db
    .insertInto("auditEvents")
    .values({ organizationId, actorUserId: null, action, entityType: "sms_message", entityId, changes: JSON.stringify(changes), requestId: null })
    .execute();
}
