"use client";

import { isClosed, RENEWAL_STATUS_LABELS, statusLabel, type ContractDetail, type ContractTermsPreview, type Plan, type PlanDetail, type RenewalStatus } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ContractFilingStatus } from "@/components/ContractFilingStatus";
import { useQueryState } from "@/components/useQueryState";
import { LoadState } from "@/components/LoadState";
import { StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { dateRange, day, money, plural, today } from "@/lib/format";

/** Returned by an action to stop without an error message or closing the form. */
const KEEP = Symbol("keep");

/** The contract's latest renewal is still in progress (sent, signed, awaiting payment or in review). */
const renewalOpen = (c: ContractDetail) => !!c.renewalId && !isClosed(c.renewalStatus as RenewalStatus);

export function SiteContracts({ siteId, editable }: { siteId: string; editable: boolean }) {
  const recordLoad = useLoad<{ items: ContractDetail[] }>(`/sites/${siteId}/contracts`);
  const { data, reload } = recordLoad;
  const [selectedObligation] = useQueryState("obligationId", "");
  useEffect(() => {
    if (!data || !selectedObligation) return;
    const row = document.getElementById(`obligation-${selectedObligation}`);
    const disclosure = row?.closest("details");
    if (disclosure) disclosure.open = true;
    window.requestAnimationFrame(() => { row?.scrollIntoView({ block: "center" }); row?.focus(); });
  }, [data, selectedObligation]);
  const plans = useLoad<{ items: Plan[] }>(editable ? "/plans" : null);
  const [creating, setCreating] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  // The authority needs more visits than the plan has: shown before anything is created.
  const [moreVisits, setMoreVisits] = useState<{ body: Record<string, unknown>; preview: ContractTermsPreview } | null>(null);
  const router = useRouter();
  // The chosen plan's options (SW-8, plan builder on): the office ticks what the customer takes.
  const builder = useFeature("plan_builder");
  // Pumping and maintenance visits on a contract are booked as work orders (SW-9).
  const cyclesOn = useFeature("service_cycles");
  const [planId, setPlanId] = useState("");
  const [optionKeys, setOptionKeys] = useState<string[] | null>(null);

  // One change at a time: a second click while one is on its way does nothing.
  const acting = useSubmit(
    async (action: () => Promise<unknown>) => {
      if ((await action()) === KEEP) return;
      setCreating(false);
      await reload();
    },
    { fallback: "Could not save." },
  );
  const run = (action: () => Promise<unknown>) => acting.run(action);
  const error = acting.error;

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    const body = {
      planId: v.planId,
      startOn: v.startOn,
      priceCents: v.price ? Math.round(Number(v.price) * 100) : undefined,
      autoRenew: v.autoRenew === "on",
      ...(planOptions.length ? { optionKeys: planOptions.filter((o) => o.required || ticked.includes(o.optionKey)).map((o) => o.optionKey) } : {}),
    };
    void run(async () => {
      const preview = await api<ContractTermsPreview>(`/sites/${siteId}/contract-terms?planId=${v.planId}&startOn=${v.startOn}`);
      // Said before the contract is made: more visits than the plan, or a schedule the authority hasn't settled.
      if (preview.warning || preview.scheduleNotice || preview.systemWarning) {
        setMoreVisits({ body, preview });
        return KEEP;
      }
      return api(`/sites/${siteId}/contracts`, { method: "POST", body });
    });
  }

  function createWithMoreVisits() {
    if (!moreVisits) return;
    const { body, preview } = moreVisits;
    setMoreVisits(null);
    void run(() =>
      api(`/sites/${siteId}/contracts`, {
        method: "POST",
        body: { ...body, acceptVisits: preview.visitsPerTerm, ...(preview.systemWarning ? { confirmSystemCategory: true } : {}) },
      }),
    );
  }

  /** Books a pumping or maintenance visit as its work order (an existing one is returned) and opens it. */
  function bookWork(obligationId: string) {
    void run(async () => router.push(`/work/${(await api<{ id: string }>(`/obligations/${obligationId}/work-order`, { method: "POST", body: {} })).id}`));
  }

  function cancel(c: ContractDetail, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    setCancelling(null);
    void run(() => api(`/contracts/${c.id}/cancel`, { method: "POST", body: { reason: v.reason, discontinuedBy: v.discontinuedBy, serviceEndsOn: v.serviceEndsOn } }));
  }

  const offered = plans.data?.items.filter((p) => p.active) ?? [];
  const chosenPlanId = planId || offered[0]?.id || "";
  const planDetail = useLoad<PlanDetail>(creating && builder && chosenPlanId ? `/plans/${chosenPlanId}` : null);
  const planOptions = planDetail.data?.id === chosenPlanId ? planDetail.data.preview.options : [];
  const ticked = optionKeys ?? planOptions.filter((o) => o.default).map((o) => o.optionKey);

  return (
    <section className="stack" id="contracts">
      <LoadState load={recordLoad} label="contracts" />
      <div className="row">
        <h2>Contracts{data ? ` (${data.items.length})` : ""}</h2>
        <span className="spacer" />
        {editable && (
          <button className="secondary" onClick={() => setCreating((c) => !c)}>
            {creating ? "Cancel" : "New contract"}
          </button>
        )}
      </div>
      <FormError error={error} />

      {creating && <LoadState load={plans} label="maintenance plans" />}
      {creating && (
        <form className="card grid" onSubmit={onCreate}>
          {offered.length === 0 ? (
            <p className="muted wide">Create a maintenance plan first, under Plans.</p>
          ) : (
            <>
              <label className="wide">
                Plan
                <select
                  name="planId"
                  required
                  value={chosenPlanId}
                  onChange={(e) => {
                    setPlanId(e.target.value);
                    setOptionKeys(null);
                  }}
                >
                  {offered.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}: {p.termMonths} months, {plural(p.visitsPerTerm, "visit")}, {money(p.priceCents)}
                    </option>
                  ))}
                </select>
              </label>
              {planOptions.length > 0 && (
                <fieldset className="wide" data-testid="contract-options">
                  <legend>Plan options (billed with the first payment)</legend>
                  {planOptions.map((o) => (
                    <label key={o.optionKey} className="check">
                      <input
                        type="checkbox"
                        checked={o.required || ticked.includes(o.optionKey)}
                        disabled={o.required}
                        onChange={(e) => setOptionKeys(e.target.checked ? [...ticked, o.optionKey] : ticked.filter((k) => k !== o.optionKey))}
                      />
                      {o.name} · {money(o.priceCents)}
                      {o.required ? " (always included)" : ""}
                    </label>
                  ))}
                </fieldset>
              )}
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
                  {moreVisits.preview.systemWarning && (
                    <p className="restriction" data-testid="system-warning">
                      {moreVisits.preview.systemWarning}
                    </p>
                  )}
                  {moreVisits.preview.warning && <p className="restriction">{moreVisits.preview.warning}</p>}
                  {moreVisits.preview.scheduleNotice && (
                    <p className="restriction">{moreVisits.preview.scheduleNotice}. Until then its filings are held for review.</p>
                  )}
                  <div className="row">
                    <SubmitButton type="button" busy={acting.busy} onClick={createWithMoreVisits}>
                      {moreVisits.preview.warning ? `Start contract with ${moreVisits.preview.visitsPerTerm} visits` : "Start contract anyway"}
                    </SubmitButton>
                    <button type="button" className="link" onClick={() => setMoreVisits(null)}>
                      Change the plan
                    </button>
                  </div>
                </div>
              ) : (
                <div className="wide">
                  <SubmitButton busy={acting.busy}>Start contract</SubmitButton>
                </div>
              )}
            </>
          )}
        </form>
      )}

      {data?.items.length === 0 && <p className="muted">No contracts on this site.</p>}
      {data?.items.map((c) => (
        <details key={c.id} className="card stack" open={c.state === "active" || c.state === "upcoming"}><summary>{c.planName} · {statusLabel("contract", c.state).label} · {dateRange(c.startOn, c.endOn)}</summary>
          <div className="row">
            <strong>{c.planName}</strong>
            <StatusBadge of="contract" value={c.state} />
            <span className="muted">
              {dateRange(c.startOn, c.endOn)} · {money(c.priceCents)}
              {c.autoRenew ? " · auto-renews" : ""}
            </span>
            <span className="spacer" />
            {editable && c.status === "active" && (
              <SubmitButton
                type="button"
                className="secondary"
                busy={acting.busy}
                busyLabel="Billing…"
                onClick={() => run(async () => router.push(`/invoices/${(await api<{ id: string }>(`/contracts/${c.id}/invoice`, { method: "POST", body: {} })).id}`))}
              >
                Bill next installment
              </SubmitButton>
            )}
            {c.renewalId && (
              <Link href={`/renewals/${c.renewalId}`} className="small">
                {/* An offer still open is finished from its own page, so the link says where it stands and invites a look. */}
                {renewalOpen(c)
                  ? `Renewal ${RENEWAL_STATUS_LABELS[c.renewalStatus as RenewalStatus]?.toLowerCase() ?? c.renewalStatus} — view`
                  : `Renewal: ${RENEWAL_STATUS_LABELS[c.renewalStatus as RenewalStatus]?.toLowerCase() ?? c.renewalStatus}`}
              </Link>
            )}
            {editable && c.status === "active" && !c.serviceEndsOn && !c.renewedById && (!c.renewalId || c.renewalStatus === "declined" || c.renewalStatus === "expired") && (
              <SubmitButton
                type="button"
                className="secondary"
                busy={acting.busy}
                onClick={() => run(async () => router.push(`/renewals/${(await api<{ id: string }>(`/contracts/${c.id}/renewal`, { method: "POST", body: {} })).id}`))}
              >
                Start renewal
              </SubmitButton>
            )}
            {/* One way to make the next term at a time: while a renewal offer is open, it is the way. */}
            {editable && c.status === "active" && !c.serviceEndsOn && !c.renewedById && !renewalOpen(c) && (
              <ConfirmButton
                className="link"
                danger={false}
                question="Create the next term now, without the customer signing or paying online?"
                confirmLabel="Renew now"
                busy={acting.busy}
                onConfirm={() => run(() => api(`/contracts/${c.id}/renew`, { method: "POST", body: {} }))}
              >
                Renew now
              </ConfirmButton>
            )}
            {editable && c.status === "active" && !c.serviceEndsOn && (
              <button className="link danger" onClick={() => setCancelling((x) => (x === c.id ? null : c.id))}>
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
              <div>
                <SubmitButton className="danger" busy={acting.busy}>
                  Cancel contract
                </SubmitButton>
              </div>
            </form>
          )}
          {c.status === "active" && c.serviceEndsOn && (
            <p className="muted">
              Ending: service stops after {day(c.serviceEndsOn)}. Visits due by then stay scheduled. {c.cancelReason}
            </p>
          )}
          {c.status === "cancelled" && c.cancelReason && <p className="muted">Cancelled: {c.cancelReason}</p>}
          {c.options.length > 0 && (
            <p className="small" data-testid="contract-options-taken">
              <span className="muted">Options: </span>
              {c.options.map((o) => `${o.name} (${money(o.priceCents)})`).join(", ")}
            </p>
          )}
          {c.coverage.length > 0 && (
            <div className="small" data-testid="contract-coverage">
              <span className="muted">Coverage{c.planVersion ? ` (plan version ${c.planVersion.version})` : ""}:</span>
              <ul className="plain">
                {c.coverage.map((r) => (
                  <li key={r.id}>
                    {r.summary}
                    {r.limit !== null && <span className="muted"> · {r.used} of {r.limit} used</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.cycles.some((y) => y.serviceType !== "aerobic_inspection") && (
            <div className="small" data-testid="contract-cycles">
              <span className="muted">Service included:</span>
              <ul className="plain">
                {c.cycles.map((y) => (
                  <li key={y.id}>
                    {y.label}: {y.summary}
                    {y.workType ? <span className="muted"> · {y.workType.name}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ContractFilingStatus key={`${c.id}-${c.status}-${c.serviceEndsOn ?? ""}`} contractId={c.id} editable={editable} />
          <table className="compact stack">
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
                <tr key={o.id} id={`obligation-${o.id}`} tabIndex={o.id === selectedObligation ? -1 : undefined} className={o.id === selectedObligation ? "selected-obligation" : undefined} data-testid={o.serviceType === "aerobic_inspection" ? undefined : "cycle-visit"}>
                  <td data-label="Visit">
                    {o.serviceType === "aerobic_inspection" ? "" : `${c.cycles.find((y) => y.cycleKey === o.cycleKey)?.label ?? o.cycleKey} `}#{o.sequence}
                  </td>
                  <td data-label="Window">
                    {day(o.windowStart, { month: "short", day: "numeric" })} to {day(o.windowEnd)}
                  </td>
                  <td data-label="Due">{day(o.dueOn)}</td>
                  <td data-label="Status">
                    <StatusBadge of="obligation" value={o.status} />
                    {o.workOrder ? (
                      <>
                        {" "}
                        <Link href={`/work/${o.workOrder.id}`} className="small">
                          {o.workOrder.label}: {statusLabel("workOrder", o.workOrder.status).label}
                        </Link>
                      </>
                    ) : (
                      editable &&
                      cyclesOn &&
                      o.serviceType !== "aerobic_inspection" &&
                      o.status === "open" &&
                      c.status === "active" && (
                        <>
                          {" "}
                          <button className="link small" disabled={acting.busy} onClick={() => bookWork(o.id)}>
                            Book work
                          </button>
                        </>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </section>
  );
}
