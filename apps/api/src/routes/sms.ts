import type { Database } from "@aerowise/db";
import {
  amountDue,
  id,
  MANUAL_REMINDER_HOURS,
  SMS_KINDS,
  SMS_MESSAGE_FILTERS,
  smsMessage,
  smsOptOut,
  smsQueueResult,
  smsSettings,
  smsSettingsPatch,
  smsTestInbound,
  toE164,
  type SmsKind,
  type SmsMessage,
  type SmsSettings,
} from "@aerowise/domain";
import { applyDeliveryStatus, receiveSms, samePhone, smsWebhookUrls, TestSmsProvider, type SmsConfig } from "@aerowise/sms";
import { DemoGatedSms, providerFor, queueSms } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";

const params = z.object({ id });
const iso = (d: Date | null) => d?.toISOString() ?? null;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export const smsRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; sms: SmsConfig | null }> = async (app, { db, now, sms }) => {
  // A demo company texts through the stand-in, so it is in test mode whatever is configured.
  const modeOf = async (organizationId: string) => (!sms ? "off" : (await providerFor(sms.provider, organizationId)).kind === "test" ? "test" : "live");

  async function settingsOf(organizationId: string): Promise<SmsSettings> {
    const mode = await modeOf(organizationId);
    const o = await db.selectFrom("organizations").select(["smsEnabled", "smsKinds", "smsFromNumber"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
    return {
      mode,
      enabled: o.smsEnabled && mode !== "off",
      kinds: SMS_KINDS.filter((k) => o.smsKinds.includes(k)),
      fromNumber: o.smsFromNumber,
      webhooks: sms && mode === "live" ? smsWebhookUrls(sms.webhookBaseUrl) : null,
    };
  }

  // ---- Settings ----

  app.get(
    "/sms/settings",
    { config: { permission: "sms:read" }, schema: { tags: ["sms"], summary: "Whether texts go, which kinds, and from which number", response: { 200: smsSettings } } },
    async (req) => settingsOf(req.requireAuth().organizationId),
  );

  app.patch(
    "/sms/settings",
    {
      config: { permission: "org:manage" },
      schema: {
        tags: ["sms"],
        summary: "Turn texting on or off, choose which texts go, set the sending number",
        description: "In test mode a made-up sending number is given when texting is turned on without one. With Twilio, the number must be one on the Twilio account.",
        body: smsSettingsPatch,
        response: { 200: smsSettings },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const mode = await modeOf(organizationId);
      const current = await db.selectFrom("organizations").select(["smsEnabled", "smsFromNumber"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
      const enabled = req.body.enabled ?? current.smsEnabled;
      let fromNumber = req.body.fromNumber !== undefined ? req.body.fromNumber : current.smsFromNumber;
      if (enabled && mode === "off") throw unprocessable("Texting is not set up on this server. Add the Twilio account (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN) first.");
      if (enabled && !fromNumber) {
        if (mode !== "test") throw unprocessable("Enter the Twilio number texts come from before turning texting on.");
        fromNumber = TestSmsProvider.fakeNumber();
      }
      const changes = { ...req.body, ...(fromNumber !== current.smsFromNumber ? { fromNumber } : {}) };
      await db
        .transaction()
        .execute(async (trx) => {
          await trx
            .updateTable("organizations")
            .set({ smsEnabled: enabled, smsFromNumber: fromNumber ?? null, ...(req.body.kinds ? { smsKinds: [...new Set(req.body.kinds)] as SmsKind[] } : {}) })
            .where("id", "=", organizationId)
            .execute();
          await audit(trx, req, { action: "sms.settings_changed", entityType: "organization", entityId: organizationId, changes });
        })
        .catch((err) => {
          if ((err as { code?: string }).code === "23505") throw new HttpError(409, "number_in_use", "Another organization already sends from this number.");
          throw err;
        });
      return settingsOf(organizationId);
    },
  );

  // ---- What was sent, and what came back ----

  app.get(
    "/sms/messages",
    {
      config: { permission: "sms:read" },
      schema: {
        tags: ["sms"],
        summary: "Recent texts, newest first",
        description: "`replies`: texts from customers. `problems`: texts that failed or could not go (no number, no consent, replied STOP).",
        querystring: z.object({ filter: z.enum(SMS_MESSAGE_FILTERS).default("all"), customerId: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
        response: { 200: z.object({ items: z.array(smsMessage) }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      let q = db
        .selectFrom("smsMessages as m")
        .leftJoin("customers as c", (j) => j.onRef("c.id", "=", "m.customerId").onRef("c.organizationId", "=", "m.organizationId"))
        .leftJoin("contacts as ct", (j) => j.onRef("ct.id", "=", "m.contactId").onRef("ct.organizationId", "=", "m.organizationId"))
        .select([
          "m.id",
          "m.direction",
          "m.kind",
          "m.status",
          "m.skipReason",
          "m.phone",
          "m.body",
          "m.errorMessage",
          "m.handledAt",
          "m.createdAt",
          "m.sentAt",
          "m.deliveredAt",
          "c.id as customerId",
          "c.displayName",
          "ct.name as contactName",
        ])
        .where("m.organizationId", "=", organizationId);
      if (req.query.filter === "replies") q = q.where("m.direction", "=", "inbound");
      if (req.query.filter === "problems") q = q.where("m.status", "in", ["failed", "skipped"]);
      if (req.query.customerId) q = q.where("m.customerId", "=", req.query.customerId);
      const rows = await q.orderBy("m.createdAt", "desc").limit(req.query.limit).execute();
      return {
        items: rows.map(
          (r): SmsMessage => ({
            id: r.id,
            direction: r.direction,
            kind: r.kind,
            status: r.status,
            skipReason: r.skipReason,
            phone: r.phone,
            body: r.body,
            error: r.errorMessage,
            customer: r.customerId && r.displayName ? { id: r.customerId, displayName: r.displayName } : null,
            contactName: r.contactName,
            handledAt: iso(r.handledAt),
            createdAt: r.createdAt.toISOString(),
            sentAt: iso(r.sentAt),
            deliveredAt: iso(r.deliveredAt),
          }),
        ),
      };
    },
  );

  app.post(
    "/sms/messages/:id/handled",
    {
      config: { permission: "sms:write" },
      schema: { tags: ["sms"], summary: "Mark a customer's reply as dealt with; it leaves the inbox", params, body: z.object({}).optional(), response: { 204: z.null() } },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const msg = await db.selectFrom("smsMessages").select(["id", "direction", "handledAt"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).executeTakeFirst();
      if (!msg || msg.direction !== "inbound") throw notFound("Reply");
      if (!msg.handledAt) {
        await db.transaction().execute(async (trx) => {
          await trx.updateTable("smsMessages").set({ handledAt: now(), handledBy: userId, updatedAt: now() }).where("id", "=", msg.id).execute();
          await audit(trx, req, { action: "sms.reply_handled", entityType: "sms_message", entityId: msg.id });
        });
      }
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/sms/opt-outs",
    {
      config: { permission: "sms:read" },
      schema: { tags: ["sms"], summary: "Numbers that replied STOP; only the customer can undo it, by texting START", response: { 200: z.object({ items: z.array(smsOptOut) }) } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const rows = await db.selectFrom("smsOptOuts").selectAll().where("organizationId", "=", organizationId).orderBy("optedOutAt", "desc").limit(500).execute();
      const items = [];
      for (const r of rows) {
        const customers = await db
          .selectFrom("contacts")
          .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "contacts.customerId").onRef("c.organizationId", "=", "contacts.organizationId"))
          .select(["c.id", "c.displayName"])
          .distinct()
          .where("contacts.organizationId", "=", organizationId)
          .where((eb) => samePhone(eb, r.phone))
          .execute();
        items.push({ phone: r.phone, source: r.source, optedOutAt: r.optedOutAt.toISOString(), customers });
      }
      return { items };
    },
  );

  // ---- Asking for a text ----

  app.post(
    "/jobs/:id/on-the-way",
    {
      config: { permission: "inspections:write" },
      schema: {
        tags: ["sms"],
        summary: "The technician is heading to this stop: text the customer",
        description: "Texts once per visit, to a contact who agreed to texts. Says what happened: queued, off, or why it cannot go.",
        params,
        body: z.object({}).optional(),
        response: { 200: smsQueueResult.extend({ onTheWayAt: z.iso.datetime({ offset: true }) }) },
      },
    },
    async (req) => {
      const { organizationId, userId, role } = req.requireAuth();
      const job = await db
        .selectFrom("jobs as j")
        .innerJoin("sites as s", (j) => j.onRef("s.id", "=", "j.siteId").onRef("s.organizationId", "=", "j.organizationId"))
        .select(["j.id", "j.status", "j.siteId", "j.technicianUserId", "j.onTheWayAt", "s.customerId"])
        .where("j.organizationId", "=", organizationId)
        .where("j.id", "=", req.params.id)
        .executeTakeFirst();
      if (!job || (role === "technician" && job.technicianUserId !== userId)) throw notFound("Job");
      if (job.status !== "scheduled" && job.status !== "in_progress") throw new HttpError(409, "not_open", `This visit is ${job.status.replace("_", " ")}`);
      const at = now();
      return db.transaction().execute(async (trx) => {
        const onTheWayAt = job.onTheWayAt ?? at;
        if (!job.onTheWayAt) {
          await trx.updateTable("jobs").set({ onTheWayAt, updatedAt: at }).where("organizationId", "=", organizationId).where("id", "=", job.id).execute();
          await audit(trx, req, { action: "job.on_the_way", entityType: "job", entityId: job.id });
        }
        const r = await queueSms(trx, organizationId, { kind: "on_the_way", customerId: job.customerId, siteId: job.siteId, relatedType: "job", relatedId: job.id, dedupeKey: `on_the_way:${job.id}` }, at);
        return { ...r, onTheWayAt: onTheWayAt.toISOString() };
      });
    },
  );

  app.post(
    "/invoices/:id/text-reminder",
    {
      config: { permission: "invoices:write" },
      schema: {
        tags: ["sms"],
        summary: "Text the customer a reminder to pay this invoice, with its pay link",
        description: `Goes whenever texting is on, even if automatic payment reminders are not. At most one every ${MANUAL_REMINDER_HOURS} hours per invoice.`,
        params,
        body: z.object({}).optional(),
        response: { 200: smsQueueResult },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const inv = await db
        .selectFrom("invoices")
        .select(["id", "status", "customerId", "siteId", "totalCents", "paidCents", "pendingCents", "creditedCents"])
        .where("organizationId", "=", organizationId)
        .where("id", "=", req.params.id)
        .executeTakeFirst();
      if (!inv) throw notFound("Invoice");
      if (inv.status !== "open" || amountDue(inv) === 0) throw unprocessable("Only an issued invoice with something still owed can be reminded");
      const at = now();
      const recent = await db
        .selectFrom("smsMessages")
        .select("id")
        .where("organizationId", "=", organizationId)
        .where("relatedType", "=", "invoice")
        .where("relatedId", "=", inv.id)
        .where("kind", "=", "payment_reminder")
        .where("status", "in", ["sending", "sent", "delivered"])
        .where("createdAt", ">", new Date(at.getTime() - MANUAL_REMINDER_HOURS * 3600_000))
        .executeTakeFirst();
      if (recent) throw new HttpError(409, "recently_reminded", `This customer was texted about this invoice in the last ${MANUAL_REMINDER_HOURS} hours.`);
      return db.transaction().execute(async (trx) => {
        const r = await queueSms(
          trx,
          organizationId,
          { kind: "payment_reminder", customerId: inv.customerId, siteId: inv.siteId, relatedType: "invoice", relatedId: inv.id, dedupeKey: `payment_reminder:${inv.id}:manual:${at.getTime()}`, manual: true },
          at,
        );
        if (r.outcome === "queued") await audit(trx, req, { action: "invoice.text_reminder", entityType: "invoice", entityId: inv.id, changes: { to: r.to } });
        return r;
      });
    },
  );

  // ---- Test mode: play a customer's reply ----

  // Also for demo companies where Twilio is configured: they text through the stand-in.
  if (sms?.provider instanceof TestSmsProvider || sms?.provider instanceof DemoGatedSms) {
    app.post(
      "/sms/test/inbound",
      {
        config: { permission: "sms:write" },
        schema: {
          tags: ["sms"],
          summary: "Pretend a customer texted the organization (test mode only)",
          description: "Goes through the same handling as a real reply: STOP and START change who gets texts; anything else lands in the inbox.",
          body: smsTestInbound,
          response: { 200: z.object({ keyword: z.enum(["stop", "start", "help"]).nullable() }) },
        },
      },
      async (req) => {
        const { organizationId } = req.requireAuth();
        if ((await modeOf(organizationId)) !== "test") throw notFound("Route");
        const from = toE164(req.body.from);
        if (!from) throw unprocessable("Enter a full mobile number, like (512) 555-0123");
        const r = await receiveSms(db, { organizationId, from, body: req.body.body, providerMessageId: null, now: now() });
        return { keyword: r.keyword };
      },
    );
  }

  // ---- Twilio webhooks (replies and delivery receipts) ----

  if (sms) {
    const urls = smsWebhookUrls(sms.webhookBaseUrl);
    await app.register(async (hook) => {
      hook.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 64 * 1024 }, (_req, body, done) =>
        done(null, Object.fromEntries(new URLSearchParams(body as string))),
      );
      const verified = (url: string, body: unknown, signature: unknown) => {
        const params = (body && typeof body === "object" ? body : {}) as Record<string, string>;
        if (typeof signature !== "string" || !sms.provider.verifyWebhook(url, params, signature)) throw new HttpError(403, "bad_signature", "Signature did not verify");
        return params;
      };

      hook.post("/webhooks/sms/inbound", { config: { public: true, signedForm: true }, schema: { hide: true } }, async (req, reply) => {
        const p = verified(urls.inbound, req.body, req.headers["x-twilio-signature"]);
        const to = toE164(p.To ?? "");
        const org = to ? await db.selectFrom("organizations").select("id").where("smsFromNumber", "=", to).executeTakeFirst() : undefined;
        if (org && p.From && typeof p.Body === "string") {
          const r = await receiveSms(db, { organizationId: org.id, from: p.From, body: p.Body, providerMessageId: p.MessageSid ?? null, now: now() });
          req.log.info({ sms: r.id, keyword: r.keyword }, "sms received");
        } else {
          req.log.warn({ to: p.To }, "sms to a number no organization uses");
        }
        // Twilio answers STOP, START and HELP itself; nothing to say back.
        return reply.header("content-type", "text/xml").send(EMPTY_TWIML);
      });

      hook.post("/webhooks/sms/status", { config: { public: true, signedForm: true }, schema: { hide: true } }, async (req, reply) => {
        const p = verified(urls.status, req.body, req.headers["x-twilio-signature"]);
        if (p.MessageSid && p.MessageStatus) {
          await applyDeliveryStatus(db, { providerMessageId: p.MessageSid, status: p.MessageStatus, errorCode: p.ErrorCode || null, now: now() });
        }
        return reply.status(204).send();
      });
    });
  }
};
