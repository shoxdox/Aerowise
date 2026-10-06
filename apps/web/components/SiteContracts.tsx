"use client";

import { RENEWAL_STATUS_LABELS, type ContractDetail, type ContractTermsPreview, type Plan, type RenewalStatus } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ContractFilingStatus } from "@/components/ContractFilingStatus";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money, today } from "@/lib/format";

/** Thrown to stop `run` without an error message or closing the form. */
class Keep extends Error {}

const STATE_LABEL: Record<ContractDetail["state"], string> = {
  upcoming: "starts soon",
  active: "active",
  expired: "expired",
  cancelled: "cancelled",
};

export function SiteContracts({ siteId, editable }: { siteId: string; editable: boolean }) {
  const { data, reload } = useLoad<{ items: ContractDetail[] }>(`/sites/${siteId}/contracts`);
  const plans = useLoad<{ items: Plan[] }>(editable ? "/plans" : null);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The authority needs more visits than the plan has: shown before anything is created.
  const [moreVisits, setMoreVisits] = useState<{ body: Record<string, unknown>; preview: ContractTermsPreview } | null>(null);
  const router = useRouter();

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      setCreating(false);
      await reload();
    } catch (err) {
      if (err instanceof Keep) return;
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    const body = {
      planId: v.planId,
      startOn: v.startOn,
      priceCents: v.price ? Math.round(Number(v.price) * 100) : undefined,
      autoRenew: v.autoRenew === "on",
    };
    void run(async () => {
      const preview = await api<ContractTermsPreview>(`/sites/${siteId}/contract-terms?planId=${v.planId}&startOn=${v.startOn}`);
      if (preview.warning) {
        setMoreVisits({ body, preview });
        throw new Keep();
      }
      await api(`/sites/${siteId}/contracts`, { method: "POST", body });
    });
  }

  function createWithMoreVisits() {
    if (!moreVisits) return;
    const { body, preview } = moreVisits;
    setMoreVisits(null);
    void run(() => api(`/sites/${siteId}/contracts`, { method: "POST", body: { ...body, acceptVisits: preview.visitsPerTerm } }));
  }

  function cancel(c: ContractDetail, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    setCancelling(null);
    void run(() => api(`/contracts/${c.id}/cancel`, { method: "POST", body: { reason: v.reason, discontinuedBy: v.discontinuedBy, serviceEndsOn: v.serviceEndsOn } }));
  }

  const offered = plans.data?.items.filter((p) => p.active) ?? [];

  return (
    <section className="stack">
      <div className="row">
        <h2>Contracts</h2>
        <span className="spacer" />
        {editable && (
          <button className="secondary" onClick={() => setCreating((c) => !c)}>
            {creating ? "Cancel" : "New contract"}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      {creating && (
        <form className="card grid" onSubmit={onCreate}>
          {offered.length === 0 ? (
            <p className="muted wide">Create a maintenance plan first, under Plans.</p>
          ) : (
            <>
              <label className="wide">
                Plan
                <select name="planId" required>
                  {offered.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}: {p.termMonths} months, {p.visitsPerTerm} visits, {money(p.priceCents)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Start date
                <input name="startOn" type="date" required defaultValue={today()} />
              </label>
              <label>
                Price override ($)
                <input name="price" type="number" min={0} step="0.01" placeholder="Plan price" />
              </label>
              <label className="check">
                <input type="checkbox" name="autoRenew" />
                Auto-renew
              </label>
              {moreVisits ? (
                <div className="wide stack" role="alert">
                  <p className="restriction">{moreVisits.preview.warning}</p>
                  <div className="row">
                    <button type="button" onClick={createWithMoreVisits}>
                      Start contract with {moreVisits.preview.visitsPerTerm} visits
                    </button>
                    <button type="button" className="link" onClick={() => setMoreVisits(null)}>
                      Change the plan
                    </button>
                  </div>
                </div>
              ) : (
                <div className="wide">
                  <button type="submit">Start contract</button>
                </div>
              )}
            </>
          )}
        </form>
      )}

      {data?.items.length === 0 && <p className="muted">No contracts on this site.</p>}
      {data?.items.map((c) => (
        <div key={c.id} className="card stack">
          <div className="row">
            <strong>{c.planName}</strong>
            <span className={`badge ${c.state}`}>{STATE_LABEL[c.state]}</span>
            <span className="muted">
              {day(c.startOn)} to {day(c.endOn)} · {money(c.priceCents)}
              {c.autoRenew ? " · auto-renews" : ""}
            </span>
            <span className="spacer" />
            {editable && c.status === "active" && (
              <button
                className="secondary"
                onClick={() => run(async () => router.push(`/invoices/${(await api<{ id: string }>(`/contracts/${c.id}/invoice`, { method: "POST", body: {} })).id}`))}
              >
                Bill next installment
              </button>
            )}
            {c.renewalId && (
              <Link href={`/renewals/${c.renewalId}`} className="small">
                Renewal: {RENEWAL_STATUS_LABELS[c.renewalStatus as RenewalStatus]?.toLowerCase() ?? c.renewalStatus}
              </Link>
            )}
            {editable && c.status === "active" && !c.serviceEndsOn && !c.renewedById && (!c.renewalId || c.renewalStatus === "declined" || c.renewalStatus === "expired") && (
              <button
                className="secondary"
                onClick={() => run(async () => router.push(`/renewals/${(await api<{ id: string }>(`/contracts/${c.id}/renewal`, { method: "POST", body: {} })).id}`))}
              >
                Start renewal
              </button>
            )}
            {editable && c.status === "active" && !c.serviceEndsOn && !c.renewedById && (
              <button
                className="link"
                title="Create the next term now, without the customer signing or paying online"
                onClick={() => {
                  if (window.confirm("Create the next term now, without the customer signing or paying online?")) void run(() => api(`/contracts/${c.id}/renew`, { method: "POST", body: {} }));
                }}
              >
                Renew now
              </button>
            )}
            {editable && c.status === "active" && !c.serviceEndsOn && (
              <button className="link" onClick={() => setCancelling((x) => (x === c.id ? null : c.id))}>
                Cancel contract
              </button>
            )}
          </div>
          {cancelling === c.id && (
            <form className="card stack" onSubmit={(event) => cancel(c, event)}>
              <label>
                Why is this contract being cancelled?
                <input name="reason" required />
              </label>
              <label>
                Who is ending it?
                <select name="discontinuedBy" required defaultValue="">
                  <option value="" disabled>
                    Choose
                  </option>
                  <option value="provider">We are (the provider)</option>
                  <option value="owner">The owner</option>
                </select>
              </label>
              <label>
                Last day of service
                <input name="serviceEndsOn" type="date" required />
              </label>
              <p className="muted small">A future last day keeps the contract active, with the visits due by then, until that day passes.</p>
              <p className="muted small">
                30 TAC 285.7(d)(3): the provider must notify the permitting authority and the system&apos;s manufacturer in writing, and the owner too when the provider ends the contract, at least
                30 days before service stops. Aerowise reminds you and records the notice; it does not send it.
              </p>
              <button className="primary">Cancel contract</button>
            </form>
          )}
          {c.status === "active" && c.serviceEndsOn && (
            <p className="muted">
              Ending: service stops after {day(c.serviceEndsOn)}. Visits due by then stay scheduled. {c.cancelReason}
            </p>
          )}
          {c.status === "cancelled" && c.cancelReason && <p className="muted">Cancelled: {c.cancelReason}</p>}
          <ContractFilingStatus key={`${c.id}-${c.status}-${c.serviceEndsOn ?? ""}`} contractId={c.id} editable={editable} />
          <table className="compact">
            <thead>
              <tr>
                <th>Visit</th>
                <th>Window</th>
                <th>Due</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {c.obligations.map((o) => (
                <tr key={o.id}>
                  <td>#{o.sequence}</td>
                  <td>
                    {day(o.windowStart, { month: "short", day: "numeric" })} to {day(o.windowEnd)}
                  </td>
                  <td>{day(o.dueOn)}</td>
                  <td>
                    <span className={`badge ${o.status}`}>{o.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
