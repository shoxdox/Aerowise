"use client";

import type { Inbox, InboxException, OnboardingChecklist as OnboardingChecklistData, Technician } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { IntroCard } from "@/components/Intro";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money } from "@/lib/format";
import { useFeature } from "@/lib/features";
import { canEdit, useSession } from "@/lib/session";

const SEVERITY_CLASS: Record<InboxException["severity"], string> = { high: "danger", medium: "warn", low: "" };

/** Where to deal with an exception, when it is not handled right here. */
function href(e: InboxException): string | null {
  switch (e.target.type) {
    case "filing":
      return `/filings/${e.target.id}`;
    case "obligation":
      return "/schedule";
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
  sms_reply: "All texts",
  complaint_unresolved: "Record response",
  report_unsigned: "Sign report",
  discontinuation_notice_due: "Record notice",
  visit_after_service_end: "Reschedule",
};

/** A customer's text needs no written resolution: someone read it and acted. */
function HandledButton({ e, onDone }: { e: InboxException; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  async function done() {
    setError(null);
    try {
      await api(`/sms/messages/${e.target.id}/handled`, { method: "POST", body: {} });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }
  return (
    <>
      <button className="secondary" onClick={() => void done()}>
        Mark handled
      </button>
      {error && <span className="error">{error}</span>}
    </>
  );
}

/**
 * Turn an inspection issue or a customer's request into a work order, or open the one it
 * already became. The API makes one per issue or request however often this is pressed.
 */
function WorkOrderAction({ e, canCreate }: { e: InboxException; canCreate: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (e.workOrder) {
    return (
      <Link href={`/work/${e.workOrder.id}`} className="button secondary">
        {e.workOrder.label}
      </Link>
    );
  }
  if (!canCreate) return null;
  async function convert() {
    setBusy(true);
    setError(null);
    try {
      const path = e.target.type === "issue" ? `/issues/${e.target.id}/work-order` : `/service-requests/${e.target.id}/work-order`;
      const wo = await api<{ id: string }>(path, { method: "POST", body: {} });
      router.push(`/work/${wo.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not make the work order");
      setBusy(false);
    }
  }
  return (
    <>
      <button className="secondary" disabled={busy} onClick={() => void convert()}>
        Turn into work order
      </button>
      {error && <span className="error">{error}</span>}
    </>
  );
}

/** Book the extra retest visit a corrective report needs; it uses none of the contract's visits. */
function RetestAction({ e, today, onDone }: { e: InboxException; today: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const techs = useLoad<{ items: Technician[] }>(open ? "/technicians" : null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    setError(null);
    try {
      await api("/jobs", { method: "POST", body: { retestOfInspectionId: e.target.id, technicianId: v.technicianId, scheduledDate: v.scheduledDate } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not book the retest");
    }
  }
  if (!open) {
    return (
      <button className="secondary" onClick={() => setOpen(true)}>
        Book retest
      </button>
    );
  }
  return (
    <form className="row" onSubmit={submit}>
      <select name="technicianId" required aria-label="Technician">
        {techs.data?.items.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <input name="scheduledDate" type="date" required defaultValue={today} min={today} aria-label="Retest date" />
      <button type="submit">Book</button>
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

/** Accept an unfinished inspection, or close an issue or a service request, without leaving the inbox. */
function InlineAction({ e, onDone }: { e: InboxException; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isInspection = e.target.type === "inspection";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = formValues(event.currentTarget).text;
    setError(null);
    try {
      if (isInspection) await api(`/inspections/${e.target.id}/override`, { method: "POST", body: { reason: text } });
      else if (e.target.type === "service_request") await api(`/service-requests/${e.target.id}/resolve`, { method: "POST", body: { resolution: text } });
      else await api(`/issues/${e.target.id}/resolve`, { method: "POST", body: { resolution: text } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }
  if (!open) {
    return (
      <button className="secondary" onClick={() => setOpen(true)}>
        {isInspection ? "Accept anyway" : "Resolve"}
      </button>
    );
  }
  return (
    <form className="row" onSubmit={submit}>
      <input name="text" required placeholder={isInspection ? "Why it is acceptable (kept on record)" : "How it was handled"} aria-label={isInspection ? "Reason" : "Resolution"} />
      <button type="submit">Save</button>
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <span className="error">{error}</span>}
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
  const { data, error, reload } = useLoad<Inbox>(technician ? null : "/inbox");
  const setup = me.role === "owner" || me.role === "office";
  const checklist = useLoad<OnboardingChecklistData>(setup ? "/onboarding" : null);
  const editable = canEdit(me);
  const workOrders = useFeature("work_orders");

  if (technician) return null;
  if (error) return <p className="error">{error}</p>;
  // Wait for the checklist too (unless it failed), so it doesn't push the page down when it arrives.
  if (!data || (setup && !checklist.data && !checklist.error)) return <p className="muted">Loading…</p>;

  const tiles = [
    { label: "Due this week", value: data.counts.dueThisWeek, href: "/due" },
    { label: "Overdue", value: data.counts.overdue, href: "/due", alert: data.counts.overdue > 0 },
    { label: "Filings at risk", value: data.counts.filingsAtRisk, href: "/filings", alert: data.counts.filingsAtRisk > 0 },
    { label: "Contracts expiring", value: data.counts.contractsExpiring, href: "/renewals" },
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

      {me.role !== "technician" && <IntroCard intro="office" me={me} />}
      {setup && <OnboardingChecklist data={checklist.data} />}

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
        {data.items.length === 0 && <p className="card muted">Nothing needs you right now. Everything due is scheduled, filed and confirmed.</p>}
        {data.items.length > 0 && (
          <ul className="exceptions">
            {data.items.map((e) => {
              const link = href(e);
              const retest = editable && e.kind === "corrective_report_due" && !e.detail?.includes("Retest booked");
              const inline = editable && e.kind !== "corrective_report_due" && (e.target.type === "inspection" || e.target.type === "issue" || e.target.type === "service_request");
              return (
                <li key={e.key} className="card">
                  <div className="row">
                    <span className={`badge ${SEVERITY_CLASS[e.severity]}`}>{e.severity}</span>
                    <strong>{e.title}</strong>
                    {e.dueOn && <span className="muted small">{day(e.dueOn)}</span>}
                    <span className="spacer" />
                    {(e.kind === "issue_open" || e.kind === "service_request") && (e.workOrder || editable) && <WorkOrderAction e={e} canCreate={editable && workOrders} />}
                    {inline && <InlineAction e={e} onDone={() => void reload()} />}
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
            <Link href="/schedule">{r.name}</Link>: {r.done} of {r.stops} stop{r.stops === 1 ? "" : "s"} done
          </p>
        ))}
      </section>
    </div>
  );
}
