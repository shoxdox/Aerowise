"use client";

import { roleHasPermission, statusLabel, type Technician, type WorkOrderDetail } from "@aerowise/domain";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { PumpingHistory } from "@/components/PumpingHistory";
import { LoadState } from "@/components/LoadState";
import { Badge, StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { HeldFieldRecords, useWorkForms, VisitFieldRecord } from "@/components/WorkFieldRecords";
import { api, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { WorkCoverage } from "@/components/WorkCoverage";
import { day, invoiceLabel, money, quantity, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/title";

/** Where the work came from, as a link the office can follow. */
function sourceHref(w: WorkOrderDetail) {
  if (w.source.kind === "inspection_issue") return "/inbox";
  if (w.source.kind === "portal_request") return `/sites/${w.site.id}`;
  return null;
}

export default function WorkOrderPage() {
  const { id } = useParams<{ id: string }>();
  const me = useSession();
  const editable = canEdit(me);
  const recordLoad = useLoad<WorkOrderDetail>(`/work-orders/${id}`);
  const { data: w, reload } = recordLoad;
  const techs = useLoad<{ items: Technician[] }>(editable ? "/technicians" : null);
  const [closing, setClosing] = useState<"complete" | "cancel" | null>(null);
  const router = useRouter();
  const invoicing = useFeature("service_items") && editable && roleHasPermission(me.role, "invoices:write");
  usePageTitle(w ? `${w.label} · ${w.title}` : null);

  const invoice = useSubmit(
    async (workOrderId: string) => {
      const made = await api<{ invoiceId: string }>(`/work-orders/${workOrderId}/invoice`, { method: "POST", body: {} });
      router.push(`/invoices/${made.invoiceId}`);
    },
    { fallback: "Could not make the invoice." },
  );
  // SW-2: technicians record visits on their phones.
  const fieldWork = useFeature("field_work");
  const forms = useWorkForms(fieldWork);

  const acting = useSubmit(
    async (path: string, body: unknown, method: string) => {
      await api(path, { method, body });
      setClosing(null);
      await reload();
      return true;
    },
    { fallback: "Could not save." },
  );
  const act = async (path: string, body: unknown, method = "POST") => (await acting.run(path, body, method)) === true;
  const problem = acting.error ?? invoice.error;
  const submitWith = (fn: (v: Record<string, string | undefined>, form: HTMLFormElement) => Promise<boolean>) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (await fn(formValues(form), form)) form.reset();
  };

  if (!w) return <LoadState load={recordLoad} label="work order" back={{ href: "/work", label: "Work orders" }} />;
  const open = w.status !== "completed" && w.status !== "cancelled";
  const href = sourceHref(w);

  return (
    <div className="stack">
      <LoadState load={recordLoad} label="work order" back={{ href: "/work", label: "Work orders" }} />
      <p>
        <Link href="/work">← Work orders</Link>
      </p>
      <div className="row">
        <h1>
          {w.label} · {w.title}
        </h1>
        <StatusBadge of="workOrder" value={w.status} data-testid="work-status" />
        {w.priority === "urgent" && <Badge tone="danger">Urgent</Badge>}
      </div>
      <dl className="details">
        <dt>Kind of work</dt>
        <dd>{w.workType.name}</dd>
        <dt>Site</dt>
        <dd>
          <Link href={`/sites/${w.site.id}`}>
            {w.site.addressLine1}, {w.site.city}
          </Link>{" "}
          <span className="muted">· {w.customer.displayName}</span>
        </dd>
        <dt>From</dt>
        <dd>{href ? <Link href={href}>{w.source.label}</Link> : w.source.label}</dd>
        {w.requestedOn && (
          <>
            <dt>Requested</dt>
            <dd>{day(w.requestedOn)}</dd>
          </>
        )}
        {w.description && (
          <>
            <dt>What needs doing</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{w.description}</dd>
          </>
        )}
        {w.completedWithoutRecordReason && (
          <>
            <dt>Completed without a field record</dt>
            <dd>{w.completedWithoutRecordReason}</dd>
          </>
        )}
        {w.cancelReason && (
          <>
            <dt>Cancelled</dt>
            <dd>{w.cancelReason}</dd>
          </>
        )}
      </dl>
      <p className="muted small">Work orders never count as an inspection visit, never open a filing and never go to an authority.</p>
      {fieldWork && w.status === "completed" && !w.completedWithoutRecordReason && (
        <p>
          <a href={`/api/work-orders/${w.id}/completion-summary.pdf`} target="_blank" rel="noreferrer" data-testid="completion-summary">
            Work completion summary (PDF)
          </a>{" "}
          <span className="muted small">· the customer&apos;s copy, also in their portal</span>
        </p>
      )}

      <FormError error={problem} />

      {editable && w.status === "draft" && (
        <div>
          <SubmitButton type="button" busy={acting.busy} onClick={() => void act(`/work-orders/${w.id}`, { ready: true }, "PATCH")}>
            Ready to schedule
          </SubmitButton>
        </div>
      )}

      <section className="stack">
        <h2>Visits</h2>
        {w.visits.length === 0 && <p className="muted">No visit scheduled yet.</p>}
        {w.visits.map((v) => (
          <div key={v.jobId} className="card tight">
            <strong>Visit {v.visitNumber}</strong> · {day(v.scheduledDate, { weekday: "short", month: "short", day: "numeric" })} · {v.technicianName}{" "}
            <StatusBadge of="job" value={v.status} />
            {v.notes && <div className="muted small">{v.notes}</div>}
            {v.cancelReason && <div className="muted small">{v.cancelReason}</div>}
            {fieldWork && <VisitFieldRecord key={`${v.jobId}:${w.events.length}`} jobId={v.jobId} forms={forms} />}
          </div>
        ))}
        {editable && w.status === "open" && (
          <form className="row" onSubmit={submitWith((v) => act(`/work-orders/${w.id}/schedule`, { technicianId: v.technicianId, scheduledDate: v.scheduledDate, notes: v.notes }))}>
            <select name="technicianId" required aria-label="Technician">
              {techs.data?.items.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <input name="scheduledDate" type="date" required aria-label="Visit date" />
            <input name="notes" placeholder="Notes for the technician" aria-label="Notes for the technician" maxLength={2000} />
            <SubmitButton busy={acting.busy}>Schedule visit</SubmitButton>
          </form>
        )}
        {!fieldWork && w.visits.some((v) => v.status === "scheduled") && (
          <p className="muted small">The technician&apos;s phone lists work visits after the next phone update; until then, record the outcome here.</p>
        )}
      </section>

      {fieldWork && <HeldFieldRecords key={w.events.length} workOrderId={w.id} forms={forms} editable={editable} onChanged={() => void reload()} />}

      {fieldWork && <PumpingHistory key={`p${w.events.length}`} workOrderId={w.id} />}

      <section className="stack">
        <h2>Charges</h2>
        {w.lines.length === 0 ? (
          <p className="muted">No planned charges.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact stack">
              <thead>
                <tr>
                  <th>Description</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit price</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {w.lines.map((l) => (
                  <tr key={l.id}>
                    <td data-label="Description">
                      {l.description}
                      {l.taxable && <span className="muted small"> · taxable</span>}
                      {l.billPumpedVolume && <span className="muted small"> · billed at the gallons pumped</span>}
                    </td>
                    <td data-label="Qty" className="num">
                      {quantity(l.quantity)}
                    </td>
                    <td data-label="Unit price" className="num">
                      {money(l.unitPriceCents)}
                    </td>
                    <td data-label="Amount" className="num">
                      {money(l.amountCents)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3}>
                    <strong>Total before tax</strong>
                  </td>
                  <td data-label="Total before tax" className="num">
                    <strong>{money(w.linesTotalCents)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {invoicing && w.billingStatus === "unbilled" && w.lines.length > 0 && w.status !== "draft" && w.status !== "cancelled" && (
          <div className="row">
            <SubmitButton type="button" busy={invoice.busy} busyLabel="Making the invoice…" onClick={() => void invoice.run(w.id)}>
              Create invoice
            </SubmitButton>
            <span className="muted small">A draft from these charges; you can change it before issuing.</span>
          </div>
        )}
        {w.billingStatus === "no_charge" && <p className="muted small">Marked no charge.</p>}
        {w.invoices.length > 0 && (
          <p>
            Invoiced:{" "}
            {w.invoices.map((i) => (
              <Link key={i.id} href={`/invoices/${i.id}`} className="badge">
                {i.number === null ? `Draft invoice · ${money(i.totalCents)}` : `${invoiceLabel(Number(i.number))} · ${money(i.totalCents)} · ${statusLabel("invoice", i.status).label}`}
              </Link>
            ))}
          </p>
        )}
      </section>

      {editable && roleHasPermission(me.role, "work:write") && <WorkCoverage workOrderId={w.id} onChange={() => void reload()} />}

      <section className="stack">
        <h2>Notes</h2>
        {w.notes.map((n) => (
          <div key={n.id} className="card tight">
            <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
            <div className="muted small">
              {n.authorName ?? "Someone"} · {when(n.createdAt)} · {n.visibility === "customer" ? "the customer can see this" : "internal"}
            </div>
          </div>
        ))}
        {editable && (
          <form className="stack" onSubmit={submitWith((v) => act(`/work-orders/${w.id}/notes`, { body: v.body, visibility: v.visibility ?? "internal" }))}>
            <textarea name="body" rows={2} required maxLength={4000} aria-label="Note" placeholder="Add a note" />
            <div className="row">
              <select name="visibility" defaultValue="internal" aria-label="Who can see the note">
                <option value="internal">Internal</option>
                <option value="customer">The customer can see it</option>
              </select>
              <SubmitButton className="secondary" busy={acting.busy}>
                Add note
              </SubmitButton>
            </div>
          </form>
        )}
      </section>

      <section className="stack">
        <h2>History</h2>
        <ol className="timeline" data-testid="work-timeline">
          {w.events.map((e) => (
            <li key={e.id}>
              <span className="muted small">{when(e.occurredAt)}</span> {e.summary}
              {e.actorName && <span className="muted small"> · {e.actorName}</span>}
            </li>
          ))}
        </ol>
      </section>

      {editable && open && (
        <section className="stack">
          {closing === null && (
            <div className="row">
              {w.status !== "draft" && (
                <button className="secondary" onClick={() => setClosing("complete")}>
                  Complete without a field record
                </button>
              )}
              <button className="secondary danger" onClick={() => setClosing("cancel")}>
                Cancel work order
              </button>
            </div>
          )}
          {closing && (
            <form className="stack" onSubmit={submitWith((v) => act(`/work-orders/${w.id}/${closing}`, { reason: v.reason }))}>
              <label>
                {closing === "complete" ? "How was it done? (for example, recorded on a paper ticket)" : "Why is it cancelled?"}
                <input name="reason" required maxLength={2000} />
              </label>
              <div className="row">
                <SubmitButton className={closing === "cancel" ? "danger" : undefined} busy={acting.busy}>
                  {closing === "complete" ? "Complete" : "Cancel work order"}
                </SubmitButton>
                <button type="button" className="link" onClick={() => setClosing(null)}>
                  Back
                </button>
              </div>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
