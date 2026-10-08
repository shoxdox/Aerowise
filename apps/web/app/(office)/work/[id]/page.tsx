"use client";

import { roleHasPermission, WORK_ORDER_STATUS_LABELS, type Technician, type WorkOrderDetail } from "@aerowise/domain";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { WorkCoverage } from "@/components/WorkCoverage";
import { day, money } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

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
  const { data: w, error, reload } = useLoad<WorkOrderDetail>(`/work-orders/${id}`);
  const techs = useLoad<{ items: Technician[] }>(editable ? "/technicians" : null);
  const [problem, setProblem] = useState<string | null>(null);
  const [closing, setClosing] = useState<"complete" | "cancel" | null>(null);
  const router = useRouter();
  const invoicing = useFeature("service_items") && editable && roleHasPermission(me.role, "invoices:write");

  async function createInvoice(workOrderId: string) {
    setProblem(null);
    try {
      const made = await api<{ invoiceId: string }>(`/work-orders/${workOrderId}/invoice`, { method: "POST", body: {} });
      router.push(`/invoices/${made.invoiceId}`);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not make the invoice");
    }
  }

  async function act(path: string, body: unknown, method = "POST") {
    setProblem(null);
    try {
      await api(path, { method, body });
      setClosing(null);
      await reload();
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save");
      return false;
    }
  }
  const submitWith = (fn: (v: Record<string, string | undefined>, form: HTMLFormElement) => Promise<boolean>) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (await fn(formValues(form), form)) form.reset();
  };

  if (error) return <p className="error">{error}</p>;
  if (!w) return <p className="muted">Loading…</p>;
  const open = w.status !== "completed" && w.status !== "cancelled";
  const href = sourceHref(w);

  return (
    <div className="stack">
      <p>
        <Link href="/work">← Work orders</Link>
      </p>
      <div className="row">
        <h1>
          {w.label} · {w.title}
        </h1>
        <span className={`badge ${w.status === "completed" ? "completed" : w.status === "cancelled" ? "cancelled" : ""}`} data-testid="work-status">
          {WORK_ORDER_STATUS_LABELS[w.status]}
        </span>
        {w.priority === "urgent" && <span className="badge danger">urgent</span>}
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

      {problem && <p className="error">{problem}</p>}

      {editable && w.status === "draft" && (
        <button onClick={() => void act(`/work-orders/${w.id}`, { ready: true }, "PATCH")}>Ready to schedule</button>
      )}

      <section className="stack">
        <h2>Visits</h2>
        {w.visits.length === 0 && <p className="muted">No visit scheduled yet.</p>}
        {w.visits.map((v) => (
          <div key={v.jobId} className="card tight">
            <strong>Visit {v.visitNumber}</strong> · {day(v.scheduledDate, { weekday: "short", month: "short", day: "numeric" })} · {v.technicianName}{" "}
            <span className={`badge ${v.status === "cancelled" ? "cancelled" : v.status === "completed" ? "completed" : ""}`}>{v.status.replace("_", " ")}</span>
            {v.notes && <div className="muted small">{v.notes}</div>}
            {v.cancelReason && <div className="muted small">{v.cancelReason}</div>}
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
            <button type="submit">Schedule visit</button>
          </form>
        )}
        {w.visits.some((v) => v.status === "scheduled") && (
          <p className="muted small">The technician&apos;s phone lists work visits after the next phone update; until then, record the outcome here.</p>
        )}
      </section>

      <section className="stack">
        <h2>Charges</h2>
        {w.lines.length === 0 ? (
          <p className="muted">No planned charges.</p>
        ) : (
          <div className="table-scroll">
            <table className="compact">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Qty</th>
                  <th>Unit price</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {w.lines.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.description}
                      {l.taxable && <span className="muted small"> · taxable</span>}
                    </td>
                    <td>{l.quantity}</td>
                    <td>{money(l.unitPriceCents)}</td>
                    <td>{money(l.amountCents)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3}>
                    <strong>Total before tax</strong>
                  </td>
                  <td>
                    <strong>{money(w.linesTotalCents)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {invoicing && w.billingStatus === "unbilled" && w.lines.length > 0 && w.status !== "draft" && w.status !== "cancelled" && (
          <div className="row">
            <button onClick={() => void createInvoice(w.id)}>Create invoice</button>
            <span className="muted small">A draft from these charges; you can change it before issuing.</span>
          </div>
        )}
        {w.billingStatus === "no_charge" && <p className="muted small">Marked no charge.</p>}
        {w.invoices.length > 0 && (
          <p>
            Invoiced:{" "}
            {w.invoices.map((i) => (
              <Link key={i.id} href={`/invoices/${i.id}`} className="badge">
                {i.number ? `#${i.number}` : "Draft"} · {money(i.totalCents)} · {i.status}
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
              <button type="submit" className="secondary">
                Add note
              </button>
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
              <button className="secondary" onClick={() => setClosing("cancel")}>
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
                <button type="submit">{closing === "complete" ? "Complete" : "Cancel work order"}</button>
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
