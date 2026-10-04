import type { Database } from "@aerowise/db";
import {
  addDays,
  CONTRACT_EXPIRED_WINDOW_DAYS,
  CONTRACT_EXPIRING_DAYS,
  FILING_OPEN_STATUSES,
  id,
  inbox,
  INVOICE_LATE_DAYS,
  invoiceNumberLabel,
  PAYMENT_FAILED_WINDOW_DAYS,
  ISSUE_LABELS,
  issueResolveInput,
  sortExceptions,
  UNCONFIRMED_AFTER_DAYS,
  type ExceptionSeverity,
  type InboxException,
  type ValidationProblem,
  RENEWAL_STATUS_LABELS,
  SERVICE_REQUEST_LABELS,
} from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { sql } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { HttpError, notFound } from "../lib/errors.ts";
import { dollars } from "@aerowise/payments";
import { listQuickBooksRecords } from "../lib/quickbooks.ts";
import { organizationToday } from "../lib/today.ts";

const params = z.object({ id });

/** Each kind is capped so one flood (say, a hundred overdue visits) cannot hide the rest. */
const PER_KIND = 200;

const site = (r: { siteId: string; addressLine1: string; city: string }) => ({ id: r.siteId, addressLine1: r.addressLine1, city: r.city });
const customer = (r: { customerId: string; displayName: string }) => ({ id: r.customerId, displayName: r.displayName });

/**
 * Exceptions are derived from the records themselves every time, not stored: one goes
 * away as soon as its cause is fixed (the visit is done, the filing is confirmed, the
 * issue is resolved), so the inbox can never disagree with the data.
 */
export const inboxRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  const sites = (organizationId: string) =>
    db
      .selectFrom("sites as s")
      .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "s.customerId").onRef("c.organizationId", "=", "s.organizationId"))
      .where("s.organizationId", "=", organizationId);

  async function overdueVisits(organizationId: string, today: string): Promise<InboxException[]> {
    const rows = await sites(organizationId)
      .innerJoin("serviceObligations as o", (j) => j.onRef("o.siteId", "=", "s.id").onRef("o.organizationId", "=", "s.organizationId"))
      .leftJoin("jobs as j", (k) => k.onRef("j.obligationId", "=", "o.id").onRef("j.organizationId", "=", "o.organizationId").on("j.status", "<>", "cancelled"))
      .leftJoin("users as u", "u.id", "j.technicianUserId")
      .select(["o.id", "o.dueOn", "o.sequence", "j.scheduledDate", "u.name as technicianName", "s.id as siteId", "s.addressLine1", "s.city", "c.id as customerId", "c.displayName"])
      .where("o.status", "=", "open")
      .where("o.dueOn", "<", today)
      .orderBy("o.dueOn")
      .limit(PER_KIND)
      .execute();
    return rows.map((r) => ({
      key: `inspection_overdue:${r.id}`,
      kind: "inspection_overdue",
      severity: "high",
      title: "Inspection overdue",
      detail: r.scheduledDate ? `Scheduled for ${r.scheduledDate} with ${r.technicianName}` : "Not scheduled",
      dueOn: r.dueOn,
      site: site(r),
      customer: customer(r),
      target: { type: "obligation", id: r.id },
    }));
  }

  async function incompleteInspections(organizationId: string): Promise<InboxException[]> {
    const rows = await sites(organizationId)
      .innerJoin("inspections as i", (j) => j.onRef("i.siteId", "=", "s.id").onRef("i.organizationId", "=", "s.organizationId"))
      .innerJoin("users as u", "u.id", "i.technicianUserId")
      .select(["i.id", "i.validationProblems", "i.updatedAt", "u.name as technicianName", "s.id as siteId", "s.addressLine1", "s.city", "c.id as customerId", "c.displayName"])
      .where("i.status", "=", "draft")
      .where("i.validationStatus", "=", "invalid")
      .orderBy("i.updatedAt")
      .limit(PER_KIND)
      .execute();
    return rows.map((r) => ({
      key: `inspection_incomplete:${r.id}`,
      kind: "inspection_incomplete",
      severity: "high",
      title: "Missing required readings",
      detail: `${r.technicianName} could not finish: ${(r.validationProblems as ValidationProblem[]).map((p) => p.message).join("; ")}`,
      dueOn: null,
      site: site(r),
      customer: customer(r),
      target: { type: "inspection", id: r.id },
    }));
  }

  async function filingExceptions(organizationId: string, today: string): Promise<InboxException[]> {
    const unconfirmedBefore = new Date(now().getTime() - UNCONFIRMED_AFTER_DAYS * 86_400_000);
    const rows = await sites(organizationId)
      .innerJoin("filings as f", (j) => j.onRef("f.siteId", "=", "s.id").onRef("f.organizationId", "=", "s.organizationId"))
      .leftJoin("jurisdictions as jr", "jr.id", "f.jurisdictionId")
      .select([
        "f.id",
        "f.status",
        "f.deadlineOn",
        "f.warningDays",
        "f.sentAt",
        "f.lastError",
        "f.reviewReason",
        "f.rejectionReason",
        "jr.authorityName",
        "s.id as siteId",
        "s.addressLine1",
        "s.city",
        "c.id as customerId",
        "c.displayName",
      ])
      .where((eb) =>
        eb.or([
          eb("f.status", "in", ["failed", "rejected", "needs_review"]),
          eb.and([eb("f.status", "in", [...FILING_OPEN_STATUSES]), eb(sql`f.deadline_on - f.warning_days`, "<=", sql`${today}::date`)]),
          eb.and([eb("f.status", "=", "sent"), eb("f.sentAt", "<", unconfirmedBefore)]),
        ]),
      )
      .orderBy(sql`f.deadline_on nulls last`)
      .limit(PER_KIND)
      .execute();
    const authority = (name: string | null) => name ?? "the authority";
    return rows.map((r) => {
      const overdue = r.deadlineOn !== null && r.deadlineOn < today;
      const base = { site: site(r), customer: customer(r), target: { type: "filing" as const, id: r.id }, dueOn: r.deadlineOn };
      switch (r.status) {
        case "failed":
          return { ...base, key: `filing_failed:${r.id}`, kind: "filing_failed", severity: "high", title: `Filing with ${authority(r.authorityName)} failed`, detail: r.lastError };
        case "rejected":
          return { ...base, key: `filing_rejected:${r.id}`, kind: "filing_rejected", severity: "high", title: `${authority(r.authorityName)} rejected a filing`, detail: r.rejectionReason };
        case "needs_review":
          return { ...base, key: `filing_needs_review:${r.id}`, kind: "filing_needs_review", severity: "high", title: "Filing needs review", detail: r.reviewReason };
        case "sent":
          return {
            ...base,
            key: `filing_unconfirmed:${r.id}`,
            kind: "filing_unconfirmed",
            severity: "medium",
            title: `No confirmation from ${authority(r.authorityName)}`,
            detail: `Sent ${r.sentAt!.toISOString().slice(0, 10)}, ${UNCONFIRMED_AFTER_DAYS}+ days without a confirmation`,
            dueOn: null,
          };
        default:
          return {
            ...base,
            key: `filing_deadline:${r.id}`,
            kind: "filing_deadline",
            severity: overdue ? "high" : "medium",
            title: overdue ? "Filing deadline passed" : "Filing deadline approaching",
            detail: `Not sent to ${authority(r.authorityName)} yet`,
          };
      }
    }) satisfies InboxException[];
  }

  /**
   * The authority requires the next inspection by the date on the site's latest filing.
   * Flag a site when no open visit can meet that date: there is none, its window opens
   * too late, or the date is within 30 days and the visit is not on a route by then.
   */
  async function lateNextVisits(organizationId: string, today: string): Promise<InboxException[]> {
    const soon = addDays(today, 30);
    const rows = await sql<{
      nextDueOn: string;
      visitId: string | null;
      windowStart: string | null;
      scheduledDate: string | null;
      siteId: string;
      addressLine1: string;
      city: string;
      customerId: string;
      displayName: string;
    }>`
      select latest.next_due_on::text as "nextDueOn",
             nv.id as "visitId", nv.window_start::text as "windowStart", nv.scheduled_date::text as "scheduledDate",
             s.id as "siteId", s.address_line1 as "addressLine1", s.city,
             c.id as "customerId", c.display_name as "displayName"
      from (
        select distinct on (site_id) site_id, next_due_on
        from filings
        where organization_id = ${organizationId} and next_due_on is not null and status <> 'needs_review'
        order by site_id, created_at desc
      ) latest
      join sites s on s.id = latest.site_id and s.organization_id = ${organizationId}
      join customers c on c.id = s.customer_id and c.organization_id = s.organization_id
      left join lateral (
        select o.id, o.window_start, j.scheduled_date
        from service_obligations o
        left join jobs j on j.obligation_id = o.id and j.organization_id = o.organization_id and j.status <> 'cancelled'
        where o.organization_id = ${organizationId} and o.site_id = s.id and o.status = 'open'
        order by o.due_on limit 1
      ) nv on true
      where s.active and (
        nv.id is null
        or nv.window_start > latest.next_due_on
        or (latest.next_due_on <= ${soon}::date and (nv.scheduled_date is null or nv.scheduled_date > latest.next_due_on))
      )
      order by latest.next_due_on
      limit ${PER_KIND}`.execute(db);
    return rows.rows.map((r) => {
      const [title, detail] = !r.visitId
        ? ["No visit before the authority's next due date", `The authority requires the next inspection by ${r.nextDueOn}, and the site has no open visit`]
        : r.windowStart! > r.nextDueOn
          ? ["Next visit starts later than the authority allows", `The next visit window opens ${r.windowStart}; the authority requires an inspection by ${r.nextDueOn}`]
          : [`Schedule the next visit by ${r.nextDueOn}`, r.scheduledDate ? `It is on the route for ${r.scheduledDate}, after the authority's date` : "The authority's date is close and the visit is not scheduled"];
      return {
        key: `next_visit_late:${r.siteId}`,
        kind: "next_visit_late" as const,
        severity: r.nextDueOn < today || !r.visitId ? "high" : "medium",
        title,
        detail,
        dueOn: r.nextDueOn,
        site: site(r),
        customer: customer(r),
        target: r.visitId ? { type: "obligation" as const, id: r.visitId } : { type: "site" as const, id: r.siteId },
      };
    });
  }

  async function openIssues(organizationId: string): Promise<InboxException[]> {
    const rows = await sites(organizationId)
      .innerJoin("issues as x", (j) => j.onRef("x.siteId", "=", "s.id").onRef("x.organizationId", "=", "s.organizationId"))
      .innerJoin("inspections as i", (j) => j.onRef("i.id", "=", "x.inspectionId").onRef("i.organizationId", "=", "x.organizationId"))
      .select(["x.id", "x.type", "x.severity", "x.description", "i.completedAt", "s.id as siteId", "s.addressLine1", "s.city", "c.id as customerId", "c.displayName"])
      .where("x.status", "=", "open")
      // Issues on an inspection still in progress can change; they count once it is done.
      .where("i.status", "=", "completed")
      .orderBy("x.createdAt")
      .limit(PER_KIND)
      .execute();
    return rows.map((r) => ({
      key: `issue_open:${r.id}`,
      kind: "issue_open",
      severity: r.severity as ExceptionSeverity,
      title: ISSUE_LABELS[r.type as keyof typeof ISSUE_LABELS] ?? r.type,
      detail: [r.description || null, r.completedAt ? `found ${r.completedAt.toISOString().slice(0, 10)}` : null].filter(Boolean).join(" · ") || null,
      dueOn: null,
      site: site(r),
      customer: customer(r),
      target: { type: "issue", id: r.id },
    }));
  }

  async function contractEnds(organizationId: string, today: string): Promise<InboxException[]> {
    const rows = await sites(organizationId)
      .innerJoin("contracts as k", (j) => j.onRef("k.siteId", "=", "s.id").onRef("k.organizationId", "=", "s.organizationId"))
      .select(["k.id", "k.endOn", "k.planName", "s.id as siteId", "s.addressLine1", "s.city", "c.id as customerId", "c.displayName"])
      .select((eb) => eb.selectFrom("renewals as rn").select("rn.id").whereRef("rn.contractId", "=", "k.id").orderBy("rn.createdAt", "desc").limit(1).as("renewalId"))
      .select((eb) => eb.selectFrom("renewals as rn").select("rn.status").whereRef("rn.contractId", "=", "k.id").orderBy("rn.createdAt", "desc").limit(1).as("renewalStatus"))
      .where("k.status", "=", "active")
      .where("s.active", "=", true)
      .where("k.endOn", ">=", addDays(today, -CONTRACT_EXPIRED_WINDOW_DAYS))
      .where("k.endOn", "<=", addDays(today, CONTRACT_EXPIRING_DAYS))
      // Not renewed, and no other contract covers the site after this one ends.
      .where((eb) => eb.not(eb.exists(eb.selectFrom("contracts as n").select("n.id").whereRef("n.previousContractId", "=", "k.id"))))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("contracts as o")
              .select("o.id")
              .whereRef("o.siteId", "=", "k.siteId")
              .whereRef("o.organizationId", "=", "k.organizationId")
              .where("o.status", "=", "active")
              .whereRef("o.startOn", ">", "k.endOn"),
          ),
        ),
      )
      .orderBy("k.endOn")
      .limit(PER_KIND)
      .execute();
    return rows.map((r) => {
      const expired = r.endOn < today;
      return {
        key: `${expired ? "contract_expired" : "contract_expiring"}:${r.id}`,
        kind: expired ? "contract_expired" : "contract_expiring",
        severity: expired ? "medium" : "low",
        title: expired ? "Contract expired without renewal" : "Contract ending, not renewed",
        detail: `${r.planName} ${expired ? "ended" : "ends"} ${r.endOn}${r.renewalStatus ? ` · renewal: ${RENEWAL_STATUS_LABELS[r.renewalStatus].toLowerCase()}` : ""}`,
        dueOn: r.endOn,
        site: site(r),
        customer: customer(r),
        target: r.renewalId ? { type: "renewal", id: r.renewalId } : { type: "contract", id: r.id },
      };
    });
  }

  /** Renewals the system could not finish on its own. */
  async function renewalExceptions(organizationId: string): Promise<InboxException[]> {
    const rows = await db
      .selectFrom("renewals as r")
      .innerJoin("sites as s", "s.id", "r.siteId")
      .innerJoin("customers as c", "c.id", "r.customerId")
      .select(["r.id", "r.reviewReason", "r.startOn", "s.id as siteId", "s.addressLine1", "s.city", "c.id as customerId", "c.displayName"])
      .where("r.organizationId", "=", organizationId)
      .where("r.status", "=", "needs_review")
      .orderBy("r.startOn")
      .limit(PER_KIND)
      .execute();
    return rows.map((r) => ({
      key: `renewal_needs_review:${r.id}`,
      kind: "renewal_needs_review",
      severity: "medium",
      title: "Renewal needs review",
      detail: r.reviewReason,
      dueOn: r.startOn,
      site: site(r),
      customer: customer(r),
      target: { type: "renewal", id: r.id },
    }));
  }

  /** What customers asked for from the portal and nobody has closed yet. */
  async function serviceRequests(organizationId: string): Promise<InboxException[]> {
    const rows = await db
      .selectFrom("serviceRequests as r")
      .innerJoin("sites as s", "s.id", "r.siteId")
      .innerJoin("customers as c", "c.id", "r.customerId")
      .select(["r.id", "r.kind", "r.description", "r.contactPhone", "r.createdAt", "s.id as siteId", "s.addressLine1", "s.city", "c.id as customerId", "c.displayName"])
      .where("r.organizationId", "=", organizationId)
      .where("r.status", "=", "open")
      .orderBy("r.createdAt")
      .limit(PER_KIND)
      .execute();
    return rows.map((r) => ({
      key: `service_request:${r.id}`,
      kind: "service_request",
      // An alarm or a smell can mean the system is failing; everything else can wait a little.
      severity: r.kind === "alarm" || r.kind === "odor" ? "high" : "medium",
      title: `Customer asked for service: ${SERVICE_REQUEST_LABELS[r.kind].toLowerCase()}`,
      detail: [r.description, r.contactPhone ? `call ${r.contactPhone}` : null, `sent ${r.createdAt.toISOString().slice(0, 10)}`].filter(Boolean).join(" · "),
      dueOn: null,
      site: site(r),
      customer: customer(r),
      target: { type: "service_request", id: r.id },
    }));
  }

  /** Overdue invoices, failed bank payments still owed, and money to give back. */
  async function invoiceExceptions(organizationId: string, today: string): Promise<InboxException[]> {
    const base = () =>
      db
        .selectFrom("invoices as i")
        .innerJoin("customers as c", (j) => j.onRef("c.id", "=", "i.customerId").onRef("c.organizationId", "=", "i.organizationId"))
        .leftJoin("sites as s", (j) => j.onRef("s.id", "=", "i.siteId").onRef("s.organizationId", "=", "i.organizationId"))
        .select(["i.id", "i.number", "i.status", "i.dueOn", "i.totalCents", "i.paidCents", "i.pendingCents", "s.id as siteId", "s.addressLine1", "s.city", "c.id as customerId", "c.displayName"])
        .where("i.organizationId", "=", organizationId);
    type Row = Awaited<ReturnType<ReturnType<typeof base>["execute"]>>[number];
    const where = (r: Row) => ({
      site: r.siteId && r.addressLine1 && r.city ? { id: r.siteId, addressLine1: r.addressLine1, city: r.city } : null,
      customer: customer(r),
      target: { type: "invoice" as const, id: r.id },
    });
    const owed = (r: Row) => dollars(Math.max(0, r.totalCents - r.paidCents - r.pendingCents));
    const failedSince = new Date(now().getTime() - PAYMENT_FAILED_WINDOW_DAYS * 86_400_000);
    const [overdue, failed, overpaid] = await Promise.all([
      base().where("i.status", "=", "open").where("i.paymentStatus", "in", ["unpaid", "partial"]).where("i.dueOn", "<", today).orderBy("i.dueOn").limit(PER_KIND).execute(),
      base()
        .where("i.status", "=", "open")
        .where("i.paymentStatus", "in", ["unpaid", "partial"])
        .where((eb) => eb.exists(eb.selectFrom("payments as p").select("p.id").whereRef("p.invoiceId", "=", "i.id").where("p.status", "=", "failed").where("p.failedAt", ">=", failedSince)))
        .orderBy("i.dueOn")
        .limit(PER_KIND)
        .execute(),
      base().where("i.paymentStatus", "=", "overpaid").orderBy("i.updatedAt").limit(PER_KIND).execute(),
    ]);
    const failedIds = new Set(failed.map((r) => r.id));
    return [
      ...failed.map((r) => ({
        ...where(r),
        key: `payment_failed:${r.id}`,
        kind: "payment_failed" as const,
        severity: "high" as const,
        title: "Bank payment failed",
        detail: `${invoiceNumberLabel(r.number)}: ${owed(r)} still owed. The customer can pay again from the same link.`,
        dueOn: r.dueOn,
      })),
      // A failed payment already says the invoice is owed.
      ...overdue
        .filter((r) => !failedIds.has(r.id))
        .map((r) => ({
          ...where(r),
          key: `invoice_overdue:${r.id}`,
          kind: "invoice_overdue" as const,
          severity: (r.dueOn! < addDays(today, -INVOICE_LATE_DAYS) ? "medium" : "low") as ExceptionSeverity,
          title: "Invoice overdue",
          detail: `${invoiceNumberLabel(r.number)}: ${owed(r)} unpaid`,
          dueOn: r.dueOn,
        })),
      ...overpaid.map((r) => ({
        ...where(r),
        key: `invoice_overpaid:${r.id}`,
        kind: "invoice_overpaid" as const,
        severity: "medium" as const,
        title: "Paid more than owed: refund the difference",
        detail: r.status === "void" ? `${invoiceNumberLabel(r.number)} is void but ${dollars(r.paidCents)} was paid on it` : `${invoiceNumberLabel(r.number)}: ${dollars(r.paidCents - r.totalCents)} over`,
        dueOn: null,
      })),
    ];
  }

  /** QuickBooks records waiting on a person, per customer. */
  async function quickbooksExceptions(organizationId: string): Promise<InboxException[]> {
    const records = await listQuickBooksRecords(db, organizationId, { attention: true, limit: PER_KIND });
    return records
      .filter((r) => r.customer)
      .map((r) => ({
        key: `quickbooks:${r.id}`,
        kind: r.status === "conflict" ? ("quickbooks_conflict" as const) : ("quickbooks_failed" as const),
        severity: "medium" as const,
        title: `QuickBooks: ${r.title ?? "needs attention"}`,
        detail: r.status === "failed" ? `${r.label}: ${r.syncError ?? "could not be sent"}` : r.label,
        dueOn: null,
        site: null,
        customer: r.customer!,
        target: { type: "quickbooks" as const, id: r.id },
      }));
  }

  app.get(
    "/inbox",
    {
      config: { permission: "filings:read" },
      schema: {
        tags: ["inbox"],
        summary: "The office home screen: exceptions that need a person, headline counts and today's routes",
        response: { 200: inbox },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const today = await organizationToday(db, organizationId, now());
      const [groups, due, routes, unpaid] = await Promise.all([
        Promise.all([
          overdueVisits(organizationId, today),
          incompleteInspections(organizationId),
          filingExceptions(organizationId, today),
          lateNextVisits(organizationId, today),
          openIssues(organizationId),
          contractEnds(organizationId, today),
          renewalExceptions(organizationId),
          serviceRequests(organizationId),
          invoiceExceptions(organizationId, today),
          quickbooksExceptions(organizationId),
        ]),
        db
          .selectFrom("serviceObligations")
          .select([
            sql<number>`count(*) filter (where due_on >= ${today}::date and due_on <= ${addDays(today, 7)}::date)::int`.as("dueThisWeek"),
            sql<number>`count(*) filter (where due_on < ${today}::date)::int`.as("overdue"),
          ])
          .where("organizationId", "=", organizationId)
          .where("status", "=", "open")
          .executeTakeFirstOrThrow(),
        db
          .selectFrom("jobs as j")
          .innerJoin("users as u", "u.id", "j.technicianUserId")
          .select(["j.technicianUserId as technicianId", "u.name", sql<number>`count(*)::int`.as("stops"), sql<number>`count(*) filter (where j.status = 'completed')::int`.as("done")])
          .where("j.organizationId", "=", organizationId)
          .where("j.scheduledDate", "=", today)
          .where("j.status", "<>", "cancelled")
          .groupBy(["j.technicianUserId", "u.name"])
          .orderBy("u.name")
          .execute(),
        db
          .selectFrom("invoices")
          .select([sql<number>`count(*)::int`.as("n"), sql<number>`coalesce(sum(greatest(total_cents - paid_cents, 0)), 0)::int`.as("cents")])
          .where("organizationId", "=", organizationId)
          .where("status", "=", "open")
          .where("paymentStatus", "in", ["unpaid", "processing", "partial"])
          .executeTakeFirstOrThrow(),
      ]);
      const items = sortExceptions(groups.flat());
      const qb = await db.selectFrom("quickbooksConnections").select(["status", "setupState"]).where("organizationId", "=", organizationId).executeTakeFirst();
      return {
        today,
        counts: {
          dueThisWeek: Number(due.dueThisWeek),
          overdue: Number(due.overdue),
          filingsAtRisk: items.filter((e) => e.kind.startsWith("filing_")).length,
          contractsExpiring: items.filter((e) => e.kind === "contract_expiring").length,
          unpaidInvoices: Number(unpaid.n),
          unpaidCents: Number(unpaid.cents),
        },
        items,
        quickbooks: qb ? { status: qb.status, setupState: qb.setupState, attention: items.filter((e) => e.kind.startsWith("quickbooks_")).length } : null,
        routes: routes.map((r) => ({ ...r, stops: Number(r.stops), done: Number(r.done) })),
      };
    },
  );

  app.post(
    "/issues/:id/resolve",
    {
      config: { permission: "inspections:review" },
      schema: {
        tags: ["inbox"],
        summary: "Close an issue found on an inspection, saying how it was handled",
        params,
        body: issueResolveInput,
        response: { 200: z.object({ id, status: z.literal("resolved"), resolution: z.string() }) },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      return db.transaction().execute(async (trx) => {
        const issue = await trx.selectFrom("issues").select(["id", "status"]).where("organizationId", "=", organizationId).where("id", "=", req.params.id).forUpdate().executeTakeFirst();
        if (!issue) throw notFound("Issue");
        if (issue.status !== "open") throw new HttpError(409, "already_resolved", "This issue is already resolved");
        await trx
          .updateTable("issues")
          .set({ status: "resolved", resolvedAt: at, resolvedBy: userId, resolution: req.body.resolution, updatedAt: at })
          .where("organizationId", "=", organizationId)
          .where("id", "=", issue.id)
          .execute();
        await audit(trx, req, { action: "issue.resolved", entityType: "issue", entityId: issue.id, changes: { resolution: req.body.resolution } });
        return { id: issue.id, status: "resolved" as const, resolution: req.body.resolution };
      });
    },
  );
};
