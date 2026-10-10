import type { Database, DB } from "@aerowise/db";
import { customerCopy } from "@aerowise/compliance";
import { addDays, amountDue, dateInZone, nextSmsTime, PAYMENT_REMINDER_DAYS, PAYMENT_REMINDER_GRACE_DAYS, SIGNABLE_STATUSES, type SmsQueueResult } from "@aerowise/domain";
import { dollars } from "@aerowise/payments";
import { deliverSms, recordSkip, resolveRecipient, smsKindOn, smsSettingsOf, type ComposedSms, type SmsConfig, type SmsRequest } from "@aerowise/sms";
import { sql, type Transaction } from "kysely";
import { payUrlFor, renewUrlFor } from "./links.ts";
import { createPortalLink, portalUrlFor } from "./portal-task.ts";
import { enqueue } from "./queue.ts";

export const SEND_SMS = "sms.send";
export const SMS_SWEEP = "sms.sweep";

type Executor = Database | Transaction<DB>;

/** Every text says who it is from and how to stop them, as carriers require. */
const FOOTER = "Reply STOP to opt out.";

const shortDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/**
 * Queues a text, in the caller's transaction, when the organization sends this kind. Says
 * what will happen: queued, off, or why it cannot go (which is also noted for the office).
 * Automatic texts due at night wait for the morning.
 */
export async function queueSms(db: Executor, organizationId: string, req: SmsRequest, now: Date): Promise<SmsQueueResult> {
  const s = await smsSettingsOf(db, organizationId);
  if (!smsKindOn(s, req.kind, req.manual)) return { outcome: "off", to: null };
  const to = await resolveRecipient(db, organizationId, req.customerId, req.siteId);
  if (!to.ok) {
    await recordSkip(db, organizationId, req, to);
    return { outcome: to.reason, to: to.phone };
  }
  const runAt = req.kind === "on_the_way" || req.manual ? now : nextSmsTime(now, s.timezone);
  await enqueue(db, { kind: SEND_SMS, organizationId, payload: { ...req }, dedupeKey: `sms:${organizationId}:${req.dedupeKey}`, runAt });
  return { outcome: "queued", to: to.phone };
}

/** Sends a queued text: writes it from the record it is about, as that record is now. */
export async function sendSms(ctx: { db: Database; sms: SmsConfig; now: () => Date; appUrl: string }, organizationId: string, req: SmsRequest) {
  const { db } = ctx;
  const org = await db.selectFrom("organizations").select(["name"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
  const from = org.name;
  const text = (body: string, stored = body): ComposedSms => ({ body: `${from}: ${body} ${FOOTER}`, stored: `${from}: ${stored} ${FOOTER}` });

  const siteLine = async (siteId: string) =>
    (await db.selectFrom("sites").select("addressLine1").where("organizationId", "=", organizationId).where("id", "=", siteId).executeTakeFirst())?.addressLine1 ?? "your property";

  const compose = async (): Promise<ComposedSms | null> => {
    switch (req.kind) {
      case "on_the_way": {
        const job = await db
          .selectFrom("jobs as j")
          .innerJoin("users as u", "u.id", "j.technicianUserId")
          .select(["j.status", "j.siteId", "u.name"])
          .where("j.organizationId", "=", organizationId)
          .where("j.type", "in", ["inspection", "work"])
          .where("j.id", "=", req.relatedId)
          .executeTakeFirst();
        if (!job || job.status === "cancelled" || job.status === "completed") return null;
        const first = job.name.trim().split(/\s+/)[0] || "Your technician";
        return text(`${first} is on the way to ${await siteLine(job.siteId)} for your septic service.`);
      }
      case "inspection_completed": {
        const insp = await db.selectFrom("inspections").select(["siteId"]).where("organizationId", "=", organizationId).where("id", "=", req.relatedId).executeTakeFirst();
        if (!insp) return null;
        return text(`we finished the inspection of your septic system at ${await siteLine(insp.siteId)}. Your report will follow.`);
      }
      case "report_ready": {
        const report = await db.selectFrom("reports").select(["siteId"]).where("organizationId", "=", organizationId).where("id", "=", req.relatedId).executeTakeFirst();
        if (!report) return null;
        // A report that needs the maintenance provider's signature is announced when it is
        // signed (that text's key ends in ":signed"), never before (30 TAC 285.7(b)(3)).
        const copy = (await customerCopy(db, organizationId, req.relatedId))!;
        if (copy.required && (!req.dedupeKey.endsWith(":signed") || !copy.signed)) return null;
        const to = await resolveRecipient(db, organizationId, req.customerId, req.siteId);
        // The link is made now, for this text only; the kept copy leaves it out.
        const link = await createPortalLink(db, { organizationId, customerId: req.customerId, source: "sms", sentTo: to.phone, createdBy: null, now: ctx.now() });
        const url = portalUrlFor(ctx.appUrl, link.token);
        const msg = `the inspection report for ${await siteLine(report.siteId)} is ready. See it in your account:`;
        return text(`${msg} ${url}`, `${msg} ${portalUrlFor(ctx.appUrl, "…")}`);
      }
      case "renewal_reminder": {
        const r = await db
          .selectFrom("renewals as r")
          .innerJoin("contracts as c", "c.id", "r.contractId")
          .select(["r.id", "r.status", "c.endOn"])
          .where("r.organizationId", "=", organizationId)
          .where("r.id", "=", req.relatedId)
          .executeTakeFirst();
        if (!r || !(SIGNABLE_STATUSES as readonly string[]).includes(r.status)) return null;
        return text(`your septic maintenance plan ends ${shortDay(r.endOn)}. Renew online in a couple of minutes: ${renewUrlFor(ctx.appUrl, r.id)}`);
      }
      case "payment_reminder": {
        const inv = await db
          .selectFrom("invoices")
          .select(["id", "status", "number", "dueOn", "totalCents", "paidCents", "pendingCents", "creditedCents"])
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.relatedId)
          .executeTakeFirst();
        if (!inv || inv.status !== "open" || !inv.dueOn || amountDue(inv) === 0) return null;
        const org = await db.selectFrom("organizations").select("timezone").where("id", "=", organizationId).executeTakeFirstOrThrow();
        const late = inv.dueOn < dateInZone(ctx.now(), org.timezone);
        return text(`invoice ${inv.number} for ${dollars(amountDue(inv))} ${late ? "was" : "is"} due ${shortDay(inv.dueOn)}. Pay online: ${payUrlFor(ctx.appUrl, inv.id)}`);
      }
    }
  };

  const outcome = await deliverSms(ctx, organizationId, req, compose);
  if (outcome.status === "later") {
    await enqueue(db, { kind: SEND_SMS, organizationId, payload: { ...req }, dedupeKey: `sms:${organizationId}:${req.dedupeKey}:at:${outcome.at.getTime()}`, runAt: outcome.at });
  }
  return outcome;
}

/**
 * Payment reminders: an open invoice gets a text 3 and 14 days after it was due. One that
 * was missed by more than a week (texting was off) is not sent late, so turning texting on
 * never texts the whole overdue book at once.
 */
export async function runSmsSweep(db: Database, organizationId: string, now: Date) {
  const s = await smsSettingsOf(db, organizationId);
  if (!smsKindOn(s, "payment_reminder")) return { queued: 0 };
  const today = dateInZone(now, s.timezone);
  let queued = 0;
  for (const days of PAYMENT_REMINDER_DAYS) {
    const invoices = await db
      .selectFrom("invoices as i")
      .select(["i.id", "i.customerId", "i.siteId"])
      .where("i.organizationId", "=", organizationId)
      .where("i.status", "=", "open")
      .where("i.paymentStatus", "in", ["unpaid", "partial"])
      .where("i.dueOn", "<=", addDays(today, -days))
      .where("i.dueOn", ">", addDays(today, -(days + PAYMENT_REMINDER_GRACE_DAYS)))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("smsMessages as m")
              .select("m.id")
              .whereRef("m.organizationId", "=", "i.organizationId")
              .where("m.dedupeKey", "=", sql<string>`'payment_reminder:' || i.id || ${`:${days}`}`),
          ),
        ),
      )
      .orderBy("i.dueOn")
      .limit(500)
      .execute();
    for (const inv of invoices) {
      const r = await queueSms(
        db,
        organizationId,
        { kind: "payment_reminder", customerId: inv.customerId, siteId: inv.siteId, relatedType: "invoice", relatedId: inv.id, dedupeKey: `payment_reminder:${inv.id}:${days}` },
        now,
      );
      if (r.outcome === "queued") queued++;
    }
  }
  return { queued };
}

/** The worker's regular sweep, for organizations that text. */
export async function scheduleSmsSweeps(db: Executor, now: Date, intervalMs: number) {
  const orgs = await db.selectFrom("organizations").select("id").where("smsEnabled", "=", true).execute();
  for (const { id } of orgs) {
    await enqueue(db, {
      kind: SMS_SWEEP,
      organizationId: id,
      payload: { organizationId: id },
      dedupeKey: `sms-sweep:${id}:${Math.floor(now.getTime() / intervalMs)}`,
      runAt: now,
      maxAttempts: 1,
    });
  }
}
