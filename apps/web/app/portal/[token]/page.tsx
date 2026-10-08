"use client";

import { SERVICE_REQUEST_KINDS, SERVICE_REQUEST_LABELS, type PortalSite, type PortalView } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money } from "@/lib/format";

const CONTRACT_LABEL: Record<NonNullable<PortalSite["contract"]>["state"], string> = { active: "Active", upcoming: "Starts soon", expired: "Ended", cancelled: "Cancelled" };
const PAYMENT_LABEL: Record<PortalView["invoices"][number]["paymentStatus"], string> = {
  unpaid: "Unpaid",
  processing: "Payment processing",
  partial: "Partly paid",
  paid: "Paid",
  overpaid: "Paid",
  refunded: "Refunded",
};

function Renewal({ r }: { r: NonNullable<PortalSite["renewal"]> }) {
  if (!r.url) return null;
  const path = new URL(r.url).pathname;
  if (r.status === "upcoming" || r.status === "sent" || r.status === "viewed") {
    return (
      <p>
        Your plan is up for renewal from {day(r.startOn)}.{" "}
        <Link href={path} className="button">
          Review and renew
        </Link>
      </p>
    );
  }
  if (r.status === "signed" || r.status === "payment_pending") {
    return (
      <p>
        Your renewal is signed. <Link href={path}>Finish your renewal</Link>
      </p>
    );
  }
  if (r.status === "activated" || r.status === "paid") return <p className="muted small">Renewed from {day(r.startOn)}.</p>;
  return null;
}

function SiteCard({ site, token, onRequested }: { site: PortalSite; token: string; onRequested: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const latest = site.reports[0];

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api(`/portal/${token}/service-requests`, { method: "POST", body: { siteId: site.id, kind: v.kind, description: v.description ?? "", contactPhone: v.phone ?? null } });
      setSent(true);
      setAsking(false);
      await onRequested();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <h2>{site.address}</h2>
      {site.contract ? (
        <div>
          <div className="row">
            <strong>{site.contract.planName}</strong>
            <span className={`badge ${site.contract.state === "active" ? "ok" : site.contract.state}`}>{CONTRACT_LABEL[site.contract.state]}</span>
          </div>
          <div className="muted small">
            {day(site.contract.startOn)} to {day(site.contract.endOn)} · {site.contract.visitsDone} of {site.contract.visitsPerTerm} visits done
          </div>
        </div>
      ) : (
        <p className="muted">No maintenance plan on file for this property.</p>
      )}
      {site.renewal && <Renewal r={site.renewal} />}

      <dl className="details">
        <dt>Next visit</dt>
        <dd>
          {site.nextVisit
            ? site.nextVisit.scheduledDate
              ? `Scheduled for ${day(site.nextVisit.scheduledDate)}`
              : `Due between ${day(site.nextVisit.windowStart)} and ${day(site.nextVisit.windowEnd)}`
            : "None planned"}
        </dd>
        <dt>Last inspection</dt>
        <dd>
          {latest ? (
            <a href={`/api${latest.url}`} target="_blank" rel="noreferrer">
              Report from {day(latest.inspectedOn)}
            </a>
          ) : (
            "No reports yet"
          )}
        </dd>
        {site.system && (
          <>
            <dt>System</dt>
            <dd>{[site.system.manufacturer, site.system.model].filter(Boolean).join(" ") || site.system.systemType || "On file"}</dd>
          </>
        )}
      </dl>

      {site.reports.length > 1 && (
        <details>
          <summary>All inspection reports ({site.reports.length})</summary>
          <ul>
            {site.reports.map((r) => (
              <li key={r.id}>
                <a href={`/api${r.url}`} target="_blank" rel="noreferrer">
                  {day(r.inspectedOn)}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}

      {site.completedWork.length > 0 && (
        <div className="stack" data-testid="completed-work">
          <h3>Completed work</h3>
          <ul>
            {site.completedWork.map((w) => (
              <li key={w.id}>
                <a href={`/api${w.url}`} target="_blank" rel="noreferrer">
                  {w.title}, completed {day(w.completedOn)}
                </a>
                <span className="muted small"> · {w.label} · work completion summary</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {site.serviceRequests.length > 0 && (
        <div className="stack">
          <h3>Your requests</h3>
          {site.serviceRequests.map((r) => (
            <div key={r.id}>
              <div className="row">
                <strong>{SERVICE_REQUEST_LABELS[r.kind]}</strong>
                <span className={`badge ${r.status === "open" ? "warn" : "ok"}`}>{r.status === "open" ? "Received" : "Done"}</span>
              </div>
              <div className="muted small">
                Sent {day(r.createdAt.slice(0, 10))} · {r.description}
              </div>
              {r.resolution && <div className="small">{r.resolution}</div>}
            </div>
          ))}
        </div>
      )}

      {sent && <p className="ok-text">Thanks, we have your request and will be in touch.</p>}
      {asking ? (
        <form className="stack" onSubmit={(e) => void ask(e)}>
          <label>
            What do you need?
            <select name="kind" defaultValue="alarm">
              {SERVICE_REQUEST_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SERVICE_REQUEST_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tell us more
            <textarea name="description" required minLength={3} maxLength={2000} rows={3} />
          </label>
          <label>
            Best phone to reach you (optional)
            <input name="phone" type="tel" maxLength={40} />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button type="submit" disabled={busy}>
              Send request
            </button>
            <button type="button" className="link" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="secondary" onClick={() => setAsking(true)}>
          Request service
        </button>
      )}
    </section>
  );
}

/** A homeowner's account, opened from their magic link. No sign-in: the link is the key. */
export default function PortalPage() {
  const { token } = useParams<{ token: string }>();
  const { data: v, error, reload } = useLoad<PortalView>(`/portal/${token}`);

  if (error) {
    return (
      <main className="pay">
        <div className="pay-card">
          <div className="card stack">
            <h1>Link not valid</h1>
            <p>{error}</p>
            <Link href="/portal">Email me a new link</Link>
          </div>
        </div>
      </main>
    );
  }
  if (!v) return <p className="muted pad">Loading…</p>;
  const contact = [v.provider.phone, v.provider.email].filter(Boolean).join(" or ");
  const owed = v.invoices.filter((i) => i.amountDueCents > 0);
  const settled = v.invoices.filter((i) => i.amountDueCents === 0);

  return (
    <main className="pay">
      <div className="pay-card">
        <div>
          <strong>{v.provider.name}</strong>
          <div className="muted small">{contact && `Questions? ${contact}`}</div>
        </div>
        <h1>Hello, {v.customerName}</h1>

        {v.amountDueCents > 0 && (
          <section className="card stack">
            <h2>Balance due: {money(v.amountDueCents)}</h2>
            {owed.map((i) => (
              <div key={i.number} className="row">
                <span>
                  {i.number} · due {day(i.dueOn)} {i.overdue && <span className="badge danger">Overdue</span>}
                </span>
                <span className="spacer" />
                <a className="button" href={new URL(i.payUrl).pathname}>
                  Pay {money(i.amountDueCents)}
                </a>
              </div>
            ))}
          </section>
        )}

        {v.sites.length === 0 && <p className="muted">No properties on file yet.</p>}
        {v.sites.map((s) => (
          <SiteCard key={s.id} site={s} token={token} onRequested={reload} />
        ))}

        {settled.length > 0 && (
          <section className="card stack">
            <h2>Payment history</h2>
            {settled.map((i) => (
              <div key={i.number} className="row">
                <span>
                  {i.number} · {day(i.issuedOn)} · {money(i.totalCents)}
                </span>
                <span className="spacer" />
                <span className="badge ok">{PAYMENT_LABEL[i.paymentStatus]}</span>
                <a href={new URL(i.payUrl).pathname}>View</a>
              </div>
            ))}
          </section>
        )}

        <p className="muted small">This link works until {day(v.expiresAt.slice(0, 10))}. Anyone with it can see your account, so please keep it to yourself.</p>
      </div>
    </main>
  );
}
