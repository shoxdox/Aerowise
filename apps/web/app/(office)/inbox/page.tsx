"use client";

import type { Inbox, InboxException, OnboardingChecklist as OnboardingChecklistData, Technician } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { IntroCard } from "@/components/Intro";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { LoadState } from "@/components/LoadState";
import { StatusBadge } from "@/components/StatusBadge";
import { SubmitButton } from "@/components/SubmitButton";
import { useDemoVisitor, DemoJourney } from "@/lib/demo";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { day, money, plural } from "@/lib/format";
import { useFeature } from "@/lib/features";
import { canEdit, useSession } from "@/lib/session";

/** Where to deal with an exception, when it is not handled right here. */
function href(e: InboxException): string | null {
  if (e.kind === "disposal_overdue") return "/disposal";
  switch (e.target.type) {
    case "filing":
      return `/filings/${e.target.id}`;
    case "obligation":
      return `/schedule?obligationId=${e.target.id}${e.site ? `&siteId=${e.site.id}` : ""}`;
    case "contract":
    case "site":
      return e.site ? `/sites/${e.site.id}` : null;
    case "invoice":
      return `/invoices/${e.target.id}`;
    case "quickbooks":
      return "/quickbooks";
    case "renewal":
      return `/renewals/${e.target.id}`;
    case "sms_message":
      return "/sms?filter=replies";
    default:
      return null;
  }
}

const ACTION_LABEL: Partial<Record<InboxException["kind"], string>> = {
  quickbooks_conflict: "Decide",
  quickbooks_failed: "Open QuickBooks",
  inspection_overdue: "Schedule",
  next_visit_late: "Schedule",
  filing_failed: "Open filing",
  filing_rejected: "Open filing",
  filing_needs_review: "Open filing",
  filing_deadline: "Open filing",
  filing_unconfirmed: "Record confirmation",
  filing_bounced: "Open filing",
  contract_expiring: "Renew",
  contract_expired: "Renew",
  renewal_needs_review: "Review",
  invoice_overdue: "Open invoice",
  payment_failed: "Open invoice",
  invoice_overpaid: "Refund",
  deposit_refund_failed: "Open invoice",
  deposit_refund_pending: "Open invoice",
  deposit_unapplied: "Refund or keep",
  deposit_disposition: "Refund or keep",
  deposit_shortfall: "Resolve",
  sms_reply: "All texts",
  complaint_unresolved: "Record response",
  report_unsigned: "Sign report",
  discontinuation_notice_due: "Record notice",
  visit_after_service_end: "Reschedule",
  disposal_overdue: "Record disposal",
  service_visit_overdue: "Book work",
  cycle_work_contract_ended: "Open contract",
};

/** A customer's text needs no written resolution: someone read it and acted. */
function HandledButton({ e, onDone }: { e: InboxException; onDone: () => void }) {
  const done = useSubmit(
    async () => {
      await api(`/sms/messages/${e.target.id}/handled`, { method: "POST", body: {} });
      onDone();
    },
    { fallback: "Could not save." },
  );
  return (
    <>
      <SubmitButton type="button" className="secondary" busy={done.busy} onClick={() => void done.run()}>
        Mark handled
      </SubmitButton>
      {done.error && <span className="error">{done.error}</span>}
    </>
  );
}

/**
 * Turn an inspection issue or a customer's request into a work order, or open the one it
 * already became. The API makes one per issue or request however often this is pressed.
 */
function WorkOrderAction({ e, canCreate }: { e: InboxException; canCreate: boolean }) {
  const router = useRouter();
  const convert = useSubmit(
    async () => {
      const path = e.target.type === "issue" ? `/issues/${e.target.id}/work-order` : `/service-requests/${e.target.id}/work-order`;
      const wo = await api<{ id: string }>(path, { method: "POST", body: {} });
      router.push(`/work/${wo.id}`);
    },
    { fallback: "Could not make the work order.", leaves: true },
  );
  if (e.workOrder) {
    return (
      <Link href={`/work/${e.workOrder.id}`} className="button secondary">
        {e.workOrder.label}
      </Link>
    );
  }
  if (!canCreate) return null;
  return (
    <>
      <SubmitButton type="button" className="secondary" busy={convert.busy} busyLabel="Making it…" onClick={() => void convert.run()}>
        Turn into work order
      </SubmitButton>
      {convert.error && <span className="error">{convert.error}</span>}
    </>
  );
}

/** Draft an estimate for an issue or request, or open the one already drafted for it. */
function EstimateAction({ e }: { e: InboxException }) {
  const router = useRouter();
  const draft = useSubmit(
    async () => {
      const path = e.target.type === "issue" ? `/issues/${e.target.id}/estimate` : `/service-requests/${e.target.id}/estimate`;
      const est = await api<{ id: string }>(path, { method: "POST", body: {} });
      router.push(`/estimates/${est.id}`);
    },
    { fallback: "Could not draft the estimate.", leaves: true },
  );
  return (
    <>
      <SubmitButton type="button" className="secondary" busy={draft.busy} busyLabel="Drafting…" onClick={() => void draft.run()}>
        Estimate
      </SubmitButton>
      {draft.error && <span className="error">{draft.error}</span>}
    </>
  );
}

/** Book the extra retest visit a corrective report needs; it uses none of the contract's visits. */
function RetestAction({ e, today, onDone }: { e: InboxException; today: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const techs = useLoad<{ items: Technician[] }>(open ? "/technicians" : null);
  const book = useSubmit(
    async (v: Record<string, string | undefined>) => {
      await api("/jobs", { method: "POST", body: { retestOfInspectionId: e.target.id, technicianId: v.technicianId, scheduledDate: v.scheduledDate } });
      onDone();
    },
    { fallback: "Could not book the retest." },
  );
  if (!open) {
    return (
      <button className="secondary" onClick={() => setOpen(true)}>
        Book retest
      </button>
    );
  }
  return (
    <form className="row" onSubmit={book.form}>
      <select name="technicianId" required aria-label="Technician">
        {techs.data?.items.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <input name="scheduledDate" type="date" required defaultValue={today} min={today} aria-label="Retest date" />
      <SubmitButton busy={book.busy}>Book</SubmitButton>
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {book.error && <span className="error">{book.error}</span>}
    </form>
  );
}

/** A held inspection: accept it as the visit's inspection, or set it aside with a reason. */
function HeldInspectionAction({ e, onDone }: { e: InboxException; onDone: () => void }) {
  const [aside, setAside] = useState(false);
  const accepting = useSubmit(
    async () => {
      await api(`/inspections/conflicts/${e.target.id}/attach`, { method: "POST", body: {} });
      onDone();
    },
    { fallback: "Could not accept it." },
  );
  const dismissing = useSubmit(
    async (v: Record<string, string | undefined>) => {
      await api(`/inspections/conflicts/${e.target.id}/dismiss`, { method: "POST", body: { reason: v.text } });
      onDone();
    },
    { fallback: "Could not set it aside." },
  );
  const error = accepting.error ?? dismissing.error;
  if (aside) {
    return (
      <form className="row" onSubmit={dismissing.form}>
        <input name="text" required placeholder="Why it is set aside (kept on record)" aria-label="Reason" />
        <SubmitButton busy={dismissing.busy}>Set aside</SubmitButton>
        <button type="button" className="link" onClick={() => setAside(false)}>
          Cancel
        </button>
        {error && <span className="error">{error}</span>}
      </form>
    );
  }
  return (
    <span className="row">
      {e.canAccept !== false && (
        <SubmitButton type="button" busy={accepting.busy} busyLabel="Accepting…" onClick={() => void accepting.run()}>
          Accept as the inspection
        </SubmitButton>
      )}
      <button className="secondary" onClick={() => setAside(true)}>
        Set aside
      </button>
      {error && <span className="error">{error}</span>}
    </span>
  );
}

/** Accept an unfinished inspection, or close an issue or a service request, without leaving the inbox. */
function InlineAction({ e, onDone }: { e: InboxException; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const isInspection = e.target.type === "inspection";
  const saving = useSubmit(
    async ({ text }: Record<string, string | undefined>) => {
      if (isInspection) await api(`/inspections/${e.target.id}/override`, { method: "POST", body: { reason: text } });
      else if (e.target.type === "service_request") await api(`/service-requests/${e.target.id}/resolve`, { method: "POST", body: { resolution: text } });
      else await api(`/issues/${e.target.id}/resolve`, { method: "POST", body: { resolution: text } });
      onDone();
    },
    { fallback: "Could not save." },
  );
  if (!open) {
    return (
      <button className="secondary" onClick={() => setOpen(true)}>
        {isInspection ? "Accept anyway" : "Resolve"}
      </button>
    );
  }
  return (
    <form className="row" onSubmit={saving.form}>
      <input name="text" required placeholder={isInspection ? "Why it is acceptable (kept on record)" : "How it was handled"} aria-label={isInspection ? "Reason" : "Resolution"} />
      <SubmitButton busy={saving.busy}>Save</SubmitButton>
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {saving.error && <span className="error">{saving.error}</span>}
    </form>
  );
}

export default function InboxPage() {
  const me = useSession();
  const router = useRouter();
  const technician = me.role === "technician";
  useEffect(() => {
    if (technician) router.replace("/tech");
  }, [technician, router]);
  const visitor = useDemoVisitor();
  const load = useLoad<Inbox>(technician ? null : "/inbox");
  const { data, reload } = load;
  const setup = me.role === "owner" || me.role === "office";
  const checklist = useLoad<OnboardingChecklistData>(setup ? "/onboarding" : null);
  const editable = canEdit(me);
  const workOrders = useFeature("work_orders");
  const estimates = useFeature("estimates");

  if (technician) return null;
  if (!data) return <LoadState load={load} label="inbox" />;

  const tiles = [
    { label: "Due this week", value: data.counts.dueThisWeek, href: "/due?range=7&upcomingOnly=true" },
    { label: "Overdue", value: data.counts.overdue, href: "/due?overdueOnly=true", alert: data.counts.overdue > 0 },
    { label: "Filings at risk", value: data.counts.filingsAtRisk, href: "/filings", alert: data.counts.filingsAtRisk > 0 },
    { label: "Sites with expiring contracts", value: data.counts.contractsExpiring, href: "/sites?contractsExpiring=true" },
    { label: `Unpaid invoices · ${money(data.counts.unpaidCents)}`, value: data.counts.unpaidInvoices, href: "/invoices" },
    ...(data.quickbooks
      ? [
          {
            label: data.quickbooks.status === "needs_reauth" ? "QuickBooks needs reconnecting" : data.quickbooks.setupState === "review" ? "QuickBooks: review matches" : "QuickBooks to decide",
            value: data.quickbooks.attention,
            href: data.quickbooks.setupState === "review" ? "/quickbooks/review" : "/quickbooks",
            alert: data.quickbooks.status === "needs_reauth" || data.quickbooks.attention > 0,
          },
        ]
      : []),
  ];

  return (
    <div className="stack">
      <div className="row">
        <h1>Inbox</h1>
        <span className="spacer" />
        <span className="muted">{day(data.today, { weekday: "long", month: "long", day: "numeric" })}</span>
      </div>

      <LoadState load={load} label="inbox" />
      {visitor ? <DemoJourney /> : <>{me.role !== "technician" && <IntroCard intro="office" me={me} />}{setup && <><LoadState load={checklist} label="setup checklist" /><OnboardingChecklist data={checklist.data} /></>}</>}

      <div className="tiles">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} className={`card tile${t.alert ? " alert" : ""}`}>
            <strong>{t.value}</strong>
            <span className="muted small">{t.label}</span>
          </Link>
        ))}
      </div>

      <section className="stack">
        <h2>Needs attention</h2>
        {data.limited && <p className="notice" role="status">This inbox shows up to 200 alerts per kind. The headline counts cover their full datasets. Use Due, Filings, Sites, Renewals and Invoices to page through all records.</p>}
        {data.items.length === 0 && <p className="card muted">No current alerts were found. Review Due and Filings for the full records; a submitted report only shows acknowledgment when evidence is recorded.</p>}
        {data.items.length > 0 && (
          <ul className="exceptions">
            {data.items.map((e) => {
              const link = href(e);
              const retest = editable && e.kind === "corrective_report_due" && !e.detail?.includes("Retest booked");
              const inline = editable && e.kind !== "corrective_report_due" && (e.target.type === "inspection" || e.target.type === "issue" || e.target.type === "service_request");
              return (
                <li key={e.key} className="card">
                  <div className="row">
                    <StatusBadge of="severity" value={e.severity} />
                    <strong>{e.title}</strong>
                    {e.dueOn && <span className="muted small">{day(e.dueOn)}</span>}
                    <span className="spacer" />
                    {(e.kind === "issue_open" || e.kind === "service_request") && (e.workOrder || editable) && <WorkOrderAction e={e} canCreate={editable && workOrders} />}
                    {(e.kind === "issue_open" || e.kind === "service_request") && !e.workOrder && editable && estimates && <EstimateAction e={e} />}
                    {inline && <InlineAction e={e} onDone={() => void reload()} />}
                    {editable && e.kind === "inspection_held" && <HeldInspectionAction e={e} onDone={() => void reload()} />}
                    {retest && <RetestAction e={e} today={data.today} onDone={() => void reload()} />}
                    {editable && e.target.type === "sms_message" && <HandledButton e={e} onDone={() => void reload()} />}
                    {link && (
                      <Link href={link} className="button secondary">
                        {ACTION_LABEL[e.kind] ?? "Open"}
                      </Link>
                    )}
                  </div>
                  <div className="small">
                    {e.site ? (
                      <>
                        <Link href={`/sites/${e.site.id}`}>
                          {e.site.addressLine1}, {e.site.city}
                        </Link>{" "}
                        <span className="muted">· {e.customer.displayName}</span>
                      </>
                    ) : (
                      <Link href={`/customers/${e.customer.id}`}>{e.customer.displayName}</Link>
                    )}
                  </div>
                  {e.detail && <div className="muted small">{e.detail}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="stack">
        <h2>Today&apos;s routes</h2>
        {data.routes.length === 0 && <p className="muted">No one is on a route today.</p>}
        {data.routes.map((r) => (
          <p key={r.technicianId}>
            <Link href="/schedule">{r.name}</Link>: {r.done} of {plural(r.stops, "stop")} done
          </p>
        ))}
      </section>
    </div>
  );
}
