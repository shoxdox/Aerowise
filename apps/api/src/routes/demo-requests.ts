import { deliveryOf, type EmailDelivery, type EmailTransport } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { demoRequest, demoRequestInput, demoRequestReceipt, demoRequestStatusInput, id, type DemoRequest, type DemoRequestReceipt } from "@aerowise/domain";
import type { FastifyBaseLogger } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { HttpError, notFound } from "../lib/errors.ts";
import { platformAudit } from "../lib/platform-audit.ts";

/**
 * Per client address. A person asks once or twice; a script that loops is cut off quickly.
 * Keyed by address only, so it can run at onRequest (no body needed; see DECISIONS W3.3).
 */
const submitLimit = { max: 5, timeWindow: "1 hour" };

export interface DemoRequestMail {
  mail: EmailTransport;
  from: string;
  /** Who hears about a new request. Empty means every active platform admin. */
  notifyTo: string[];
  appUrl: string;
}

type Row = { id: string; name: string; email: string; company: string; phone: string | null; counties: string | null; message: string | null; status: "new" | "handled"; notifiedAt: Date | null; notifyError: string | null; notifyDelivery: "outbox" | "provider" | null; createdAt: Date };

const toView = (r: Row): DemoRequest => ({ ...r, notifiedAt: r.notifiedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() });

export const demoRequestRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; demoMail: DemoRequestMail }> = async (app, { db, now, demoMail }) => {
  /** Emails Aerowise about a new request. Never throws: the request is saved either way, and /admin shows whether the email went. */
  async function notify(r: Row, log: FastifyBaseLogger) {
    let to = demoMail.notifyTo;
    if (to.length === 0) {
      to = (await db.selectFrom("platformAdmins").select("email").where("active", "=", true).orderBy("createdAt").execute()).map((a) => a.email);
    }
    if (to.length === 0) {
      await db.updateTable("demoRequests").set({ notifyError: "No one to notify: set DEMO_REQUEST_NOTIFY_TO or add a platform admin" }).where("id", "=", r.id).execute();
      return;
    }
    const errors: string[] = [];
    const deliveries = new Set<EmailDelivery>();
    for (const address of to) {
      try {
        const sent = await demoMail.mail.send({
          organizationId: null,
          idempotencyKey: `demo-request-${r.id}-${address}`,
          from: `"Aerowise" <${demoMail.from}>`,
          to: address,
          subject: `Demo request: ${r.company}`,
          text: [
            `${r.name} at ${r.company} asked for a demo.`,
            "",
            `Email: ${r.email}`,
            `Phone: ${r.phone ?? "not given"}`,
            `Counties: ${r.counties ?? "not given"}`,
            "",
            r.message ?? "(no message)",
            "",
            `See every request in the admin console: ${demoMail.appUrl.replace(/\/$/, "")}/admin/demo-requests`,
          ].join("\n"),
          attachments: [],
        });
        deliveries.add(deliveryOf(sent));
      } catch (err) {
        log.warn({ err, demoRequestId: r.id }, "demo request email failed");
        errors.push(`${address}: ${(err as Error).message || String(err)}`.slice(0, 500));
      }
    }
    await db
      .updateTable("demoRequests")
      // Any alert a provider took counts as emailed; only all-outbox is "recorded in test outbox".
      .set(errors.length === 0 ? { notifiedAt: now(), notifyError: null, notifyDelivery: deliveries.has("provider") ? "provider" : "outbox" } : { notifyError: errors.join("; ") })
      .where("id", "=", r.id)
      .execute();
  }

  app.post(
    "/public/demo-requests",
    {
      config: { public: true, rateLimit: submitLimit },
      schema: {
        tags: ["public"],
        summary: "Ask for a demo",
        description: "No sign-in. Saves to /admin, reuses a submission key on retries, and reports notification status truthfully. Rate-limited per client address.",
        body: demoRequestInput,
        response: { 202: demoRequestReceipt },
      },
    },
    async (req, reply) => {
      const { website, submissionKey, ...input } = req.body;
      // The spam trap was filled: answer as usual so a bot learns nothing, and keep nothing.
      if (website?.trim()) return reply.status(202).send({ ok: true, saved: true, duplicate: false, notification: "pending" });
      const row = await db
        .insertInto("demoRequests")
        .values({ submissionKey: submissionKey ?? null, name: input.name, email: input.email, company: input.company, phone: input.phone ?? null, counties: input.counties ?? null, message: input.message ?? null, createdAt: now() })
        .onConflict((oc) => oc.column("submissionKey").doNothing())
        .returningAll()
        .executeTakeFirst();
      const saved = row ?? await db.selectFrom("demoRequests").selectAll().where("submissionKey", "=", submissionKey!).executeTakeFirstOrThrow();
      if (!row && ["name", "email", "company", "phone", "counties", "message"].some((field) => saved[field as keyof Row] !== (input[field as keyof typeof input] ?? null))) {
        throw new HttpError(409, "submission_changed", "This request was already saved with different details. Start a new request or contact Justin directly.");
      }
      // Only the inserting request sends an alert. Concurrent/retried submissions never send twice.
      if (row) await notify(row, req.log);
      const current = await db.selectFrom("demoRequests").selectAll().where("id", "=", saved.id).executeTakeFirstOrThrow();
      const notification: DemoRequestReceipt["notification"] = current.notifyError ? "failed" : current.notifyDelivery === "outbox" ? "simulated" : current.notifyDelivery === "provider" ? "provider_accepted" : "pending";
      return reply.status(202).send({ ok: true, saved: true, duplicate: !row, notification });
    },
  );

  app.get(
    "/admin/demo-requests",
    { config: { platformAdmin: true }, schema: { tags: ["admin"], summary: "Demo requests, newest first", response: { 200: z.object({ items: z.array(demoRequest) }) } } },
    async () => {
      const rows = await db.selectFrom("demoRequests").selectAll().orderBy("createdAt", "desc").limit(500).execute();
      return { items: rows.map(toView) };
    },
  );

  app.put(
    "/admin/demo-requests/:id/status",
    {
      config: { platformAdmin: true },
      schema: { tags: ["admin"], summary: "Mark a demo request handled, or new again", params: z.object({ id }), body: demoRequestStatusInput, response: { 200: demoRequest } },
    },
    async (req) => {
      const { adminId } = req.requireAdmin();
      const row = await db.updateTable("demoRequests").set({ status: req.body.status }).where("id", "=", req.params.id).returningAll().executeTakeFirst();
      if (!row) throw notFound("Demo request");
      await platformAudit(db, req, { adminId, action: "demo_request.status_changed", entityType: "demo_request", entityId: row.id, changes: { status: row.status } });
      return toView(row);
    },
  );
};
