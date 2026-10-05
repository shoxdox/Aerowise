import type { EmailTransport } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { demoRequest, demoRequestInput, demoRequestStatusInput, id, type DemoRequest } from "@aerowise/domain";
import type { FastifyBaseLogger } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound } from "../lib/errors.ts";
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

type Row = { id: string; name: string; email: string; company: string; phone: string | null; counties: string | null; message: string | null; status: "new" | "handled"; notifiedAt: Date | null; notifyError: string | null; createdAt: Date };

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
    for (const address of to) {
      try {
        await demoMail.mail.send({
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
      } catch (err) {
        log.warn({ err, demoRequestId: r.id }, "demo request email failed");
        errors.push(`${address}: ${(err as Error).message || String(err)}`.slice(0, 500));
      }
    }
    await db
      .updateTable("demoRequests")
      .set(errors.length === 0 ? { notifiedAt: now(), notifyError: null } : { notifyError: errors.join("; ") })
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
        description: "No sign-in. Lands in /admin and emails Aerowise. Rate-limited per client address.",
        body: demoRequestInput,
        response: { 202: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req, reply) => {
      const { website, ...input } = req.body;
      // The spam trap was filled: answer as usual so a bot learns nothing, and keep nothing.
      if (website?.trim()) return reply.status(202).send({ ok: true });
      const row = await db
        .insertInto("demoRequests")
        .values({ name: input.name, email: input.email, company: input.company, phone: input.phone ?? null, counties: input.counties ?? null, message: input.message ?? null, createdAt: now() })
        .returningAll()
        .executeTakeFirstOrThrow();
      await notify(row, req.log);
      return reply.status(202).send({ ok: true });
    },
  );

  app.get(
    "/admin/demo-requests",
    { config: { platformAdmin: true }, schema: { tags: ["admin"], summary: "Demo requests, newest first", response: { 200: z.object({ items: z.array(demoRequest) }) } } },
    async () => ({ items: (await db.selectFrom("demoRequests").selectAll().orderBy("createdAt", "desc").limit(500).execute()).map(toView) }),
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
