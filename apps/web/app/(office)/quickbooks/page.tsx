"use client";

import {
  MATCH_REASON_LABELS,
  QUICKBOOKS_ACTION_LABELS,
  QUICKBOOKS_SYNC_STATUS_LABELS,
  type QuickBooksAccount,
  type QuickBooksAction,
  type QuickBooksItem,
  type QuickBooksMapping,
  type QuickBooksRecord,
  type QuickBooksStatus,
  type QuickBooksSyncStatus,
  type QuickBooksTaxCode,
} from "@aerowise/domain";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { day, money, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

const RETURN_MESSAGES: Record<string, string> = {
  state: "That connection link expired or was started by someone else. Try connecting again.",
  declined: "QuickBooks was not connected.",
  connect: "QuickBooks did not finish connecting. Try again.",
};

const ENTITY_LABELS = { customer: "Customers", invoice: "Invoices", payment: "Payments", refund: "Refunds" } as const;
const HEALTH_ORDER: QuickBooksSyncStatus[] = ["synced", "queued", "syncing", "failed", "conflict", "quarantined", "ignored"];

/** One record waiting on a person, with what it means and the choices that settle it. */
function RecordCard({ r, editable, onDone }: { r: QuickBooksRecord; editable: boolean; onDone: () => Promise<void> }) {
  const [pick, setPick] = useState<string>(r.candidates[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const details = (r.details ?? {}) as Record<string, unknown>;

  const acting = useSubmit(
    async (action: QuickBooksAction) => {
      await api(`/quickbooks/records/${r.id}/resolve`, {
        method: "POST",
        body: { action, ...(action === "match" && r.conflictKind === "ambiguous_match" ? { externalId: pick } : {}), ...(action === "keep_remote" ? { reason } : {}) },
      });
      await onDone();
    },
    { fallback: "Could not save that choice." },
  );
  const act = (action: QuickBooksAction) => acting.run(action);
  const busy = acting.busy;
  const error = acting.error;

  const fields = (details.fields ?? []) as { field: string; aerowise: string | null; quickbooks: string | null }[];
  const existing = details.existing as { customerName: string | null; totalCents: number } | undefined;
  const totals = details as { aerowise?: { totalCents: number; taxCents: number }; quickbooks?: { totalCents: number; taxCents: number }; checkedAt?: string };
  return (
    <li className="card stack qb-record" data-testid="qb-record">
      <div className="row">
        <span className={`badge ${r.status === "failed" || r.status === "quarantined" ? "danger" : "warn"}`}>{r.title}</span>
        <strong>{r.label}</strong>
        {r.customer && r.entityType !== "customer" && <span className="muted">{r.customer.displayName}</span>}
        <span className="spacer" />
        <span className="muted small">{when(r.updatedAt)}</span>
      </div>
      <p className="muted small">{r.explanation}</p>
      {r.syncError && <p className="error small">QuickBooks said: {r.syncError}</p>}

      {r.conflictKind === "ambiguous_match" && r.candidates.length > 0 && (
        <fieldset className="plain stack">
          {r.candidates.map((c) => (
            <label key={c.id} className="check">
              <input type="radio" name={`pick-${r.id}`} value={c.id} checked={pick === c.id} onChange={() => setPick(c.id)} disabled={!editable} />
              <span>
                <strong>{c.name}</strong> <span className="muted small">{[c.email, c.phone, c.address].filter(Boolean).join(" · ")}</span>{" "}
                {c.reasons.map((reason) => (
                  <span key={reason} className="badge">
                    {MATCH_REASON_LABELS[reason]}
                  </span>
                ))}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {r.conflictKind === "changed_in_both" && fields.length > 0 && (
        <table className="compact">
          <thead>
            <tr>
              <th />
              <th>Aerowise</th>
              <th>QuickBooks</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.field}>
                <td className="muted">{f.field}</td>
                <td>{f.aerowise ?? "—"}</td>
                <td>{f.quickbooks ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.conflictKind === "item_missing" && (
        <p className="small">
          {details.reason === "unmapped"
            ? "No QuickBooks item is chosen for these lines yet."
            : `"${String(details.itemName ?? details.itemId)}" is ${details.reason === "inactive" ? "inactive" : "deleted"} in QuickBooks.`}{" "}
          Choose another under Products and services below.
        </p>
      )}
      {r.conflictKind === "payment_mismatch" && (
        <p className="small">
          Payment {money(Number(details.paymentCents))}, but QuickBooks shows {money(Number(details.balanceCents))} still owed on {String(details.docNumber ?? "the invoice")}.
        </p>
      )}
      {r.conflictKind === "duplicate_number" && existing && (
        <p className="small">
          QuickBooks has {String(details.docNumber)} for {existing.customerName ?? "another customer"}, {money(existing.totalCents)}.
        </p>
      )}
      {r.conflictKind === "tax_mapping_missing" && <p className="small">Sales tax on this invoice: {money(Number(details.taxCents))}.</p>}
      {r.conflictKind === "tax_total_mismatch" && totals.aerowise && totals.quickbooks && (
        <>
          <table className="compact" data-testid="qb-totals">
            <thead>
              <tr>
                <th />
                <th>Aerowise</th>
                <th>QuickBooks</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="muted">Sales tax</td>
                <td>{money(totals.aerowise.taxCents)}</td>
                <td>{money(totals.quickbooks.taxCents)}</td>
              </tr>
              <tr>
                <td className="muted">Total</td>
                <td>{money(totals.aerowise.totalCents)}</td>
                <td>{money(totals.quickbooks.totalCents)}</td>
              </tr>
            </tbody>
          </table>
          {totals.checkedAt && <p className="muted small">Checked again {when(totals.checkedAt)}: still different.</p>}
          {editable && r.actions.includes("keep_remote") && (
            <label>
              Why keep it as it is (needed to stop syncing it)
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            </label>
          )}
        </>
      )}

      {editable && (
        <div className="row">
          {r.actions.map((a, i) => (
            <button
              key={a}
              className={i === 0 ? undefined : "secondary"}
              disabled={busy || (a === "match" && r.conflictKind === "ambiguous_match" && !pick) || (a === "keep_remote" && !reason.trim())}
              onClick={() => void act(a)}
            >
              {a === "match" && r.conflictKind === "duplicate_number" ? "Link to that invoice" : QUICKBOOKS_ACTION_LABELS[a]}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </li>
  );
}

/** Which QuickBooks item invoice lines use, and the date invoices start syncing from. */
function MappingForm({ owner, onSaved }: { owner: boolean; onSaved: () => Promise<void> }) {
  const mapping = useLoad<QuickBooksMapping>("/quickbooks/mapping");
  const items = useLoad<QuickBooksItem[]>("/quickbooks/items");
  const accounts = useLoad<QuickBooksAccount[]>("/quickbooks/accounts");
  const taxCodes = useLoad<QuickBooksTaxCode[]>("/quickbooks/tax-codes");
  const [message, setMessage] = useState<string | null>(null);
  const saving = useSubmit(
    async (form: HTMLFormElement) => {
      const m = mapping.data!;
      const f = new FormData(form);
      setMessage(null);
      await api("/quickbooks/mapping", {
        method: "PUT",
        body: {
          syncFrom: String(f.get("syncFrom")),
          defaultItemId: String(f.get("defaultItem") ?? "") || null,
          refundItemId: String(f.get("refundItem") ?? "") || null,
          stripeRefundAccountId: String(f.get("stripeRefundAccount") ?? "") || null,
          manualRefundAccountId: String(f.get("manualRefundAccount") ?? "") || null,
          // Where tax sync is not allowed, only turning it off can be sent.
          ...(m.tax.allowed
            ? {
                taxableCodeRef: String(f.get("taxableCode") ?? "") || null,
                nontaxableCodeRef: String(f.get("nontaxableCode") ?? "") || null,
                taxRateRef: String(f.get("taxRate") ?? "") || null,
                taxMode: f.get("taxMode") === "taxcode" ? "taxcode" : "off",
              }
            : m.tax.mode === "taxcode" && f.get("taxMode") !== "taxcode"
              ? { taxMode: "off" }
              : {}),
          plans: m.plans.map((p) => ({ planId: p.planId, itemId: String(f.get(`plan-${p.planId}`) ?? "") || null })),
          serviceItems: m.serviceItems.map((i) => ({ serviceItemId: i.serviceItemId, itemId: String(f.get(`service-item-${i.serviceItemId}`) ?? "") || null })),
        },
      });
      await Promise.all([mapping.reload(), onSaved()]);
      setMessage("Saved");
    },
    { fallback: "Could not save the mapping." },
  );
  if (!mapping.data) return <LoadState load={mapping} label="QuickBooks mapping" />;
  const m = mapping.data;
  const active = (items.data ?? []).filter((i) => i.active);
  const known = new Set(active.map((i) => i.id));
  const activeAccounts = (accounts.data ?? []).filter((a) => a.active);
  const knownAccounts = new Set(activeAccounts.map((a) => a.id));
  const activeCodes = (taxCodes.data ?? []).filter((c) => c.active);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saving.run(event.currentTarget);
  }

  const select = (name: string, value: string | null, empty: string) => (
    <select name={name} defaultValue={value ?? ""} disabled={!owner}>
      <option value="">{empty}</option>
      {value && !known.has(value) && <option value={value}>Missing in QuickBooks ({value})</option>}
      {active.map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}
        </option>
      ))}
    </select>
  );

  const accountSelect = (name: string, value: string | null) => (
    <select name={name} defaultValue={value ?? ""} disabled={!owner}>
      <option value="">Not chosen: refunds wait</option>
      {value && !knownAccounts.has(value) && <option value={value}>Missing in QuickBooks ({value})</option>}
      {activeAccounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} ({a.type})
        </option>
      ))}
    </select>
  );

  const codeSelect = (name: string, value: string | null, taxable: boolean) => (
    <select name={name} defaultValue={value ?? ""} disabled={!owner || !m.tax.allowed}>
      <option value="">Not chosen</option>
      {value && !activeCodes.some((c) => c.id === value) && <option value={value}>Missing in QuickBooks ({value})</option>}
      {activeCodes
        .filter((c) => c.taxable === taxable)
        .map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
    </select>
  );

  return (
    <form className="card stack" onSubmit={save} key={JSON.stringify(m) + active.length + activeAccounts.length + activeCodes.length}>
      <h2>Products and services</h2>
      <p className="muted small">Each invoice line goes to QuickBooks under a product or service. Plan installments use their plan&apos;s item and lines written from a service item use that item&apos;s; everything else uses the item for other charges.</p>
      {items.error && <p className="error">{items.error}</p>}
      <div className="grid">
        <label>
          Other charges
          {select("defaultItem", m.defaultItem?.id ?? null, "Choose an item")}
        </label>
        {m.plans.map((p) => (
          <label key={p.planId}>
            {p.planName}
            {!p.active && " (inactive plan)"}
            {select(`plan-${p.planId}`, p.item?.id ?? null, "Same as other charges")}
          </label>
        ))}
        {m.serviceItems.map((i) => (
          <label key={i.serviceItemId}>
            {i.name}
            {!i.active && " (switched off)"}
            {select(`service-item-${i.serviceItemId}`, i.item?.id ?? null, "Same as other charges")}
          </label>
        ))}
        <label>
          Send invoices issued from
          <input type="date" name="syncFrom" defaultValue={m.syncFrom} disabled={!owner} required />
        </label>
      </div>
      <p className="muted small">Invoices issued before {day(m.syncFrom)} are not sent, so ones already entered in QuickBooks by hand are not doubled.</p>
      <h2>Refunds</h2>
      <p className="muted small">
        An ordinary refund goes to QuickBooks as a Refund Receipt, and the original payment stays as it is. Choose the item it reduces and where the money leaves from. Ask your accountant if unsure. Refunds wait until all three are chosen.
      </p>
      {accounts.error && <p className="error">{accounts.error}</p>}
      <div className="grid">
        <label>
          Refund item
          {select("refundItem", m.refundItem?.id ?? null, "Not chosen: refunds wait")}
        </label>
        <label>
          Card and bank refunds paid from
          {accountSelect("stripeRefundAccount", m.stripeRefundAccount?.id ?? null)}
        </label>
        <label>
          Check and cash refunds paid from
          {accountSelect("manualRefundAccount", m.manualRefundAccount?.id ?? null)}
        </label>
      </div>
      <h2>Sales tax</h2>
      <p className="muted small">
        Off: an invoice that charges sales tax stays out of QuickBooks, for you to enter there yourself. On: each line goes with its taxable or non-taxable code, and the invoice with its tax code and
        Aerowise&apos;s tax. If QuickBooks ends up with different totals (for example, it recalculated the tax), the invoice is held for you to settle and its payments wait.
      </p>
      {!m.tax.allowed && <p className="restriction small">Sales tax sync stays off for live QuickBooks companies until it has been checked against a QuickBooks sandbox.</p>}
      {taxCodes.error && <p className="error">{taxCodes.error}</p>}
      <div className="grid">
        <label className="check">
          <input type="checkbox" name="taxMode" value="taxcode" defaultChecked={m.tax.mode === "taxcode"} disabled={!owner || (!m.tax.allowed && m.tax.mode !== "taxcode")} />
          <span>Send sales tax to QuickBooks</span>
        </label>
        <label>
          Taxable lines
          {codeSelect("taxableCode", m.tax.taxableCode?.id ?? null, true)}
        </label>
        <label>
          Untaxed lines
          {codeSelect("nontaxableCode", m.tax.nontaxableCode?.id ?? null, false)}
        </label>
        <label>
          Invoice tax code (rate)
          {codeSelect("taxRate", m.tax.taxRate?.id ?? null, true)}
        </label>
      </div>
      {owner && (
        <div className="row">
          <SubmitButton busy={saving.busy}>Save</SubmitButton>
          {message && <span className="muted">{message}</span>}
          <FormError error={saving.error} />
        </div>
      )}
    </form>
  );
}

function QuickBooks() {
  const me = useSession();
  const owner = me.role === "owner";
  const editable = canEdit(me);
  const params = useSearchParams();
  const status = useLoad<QuickBooksStatus>("/quickbooks");
  const { data, reload } = status;
  const records = useLoad<QuickBooksRecord[]>(data?.connection?.setupState === "active" ? "/quickbooks/records" : null);
  const [message, setMessage] = useState<string | null>(null);
  const acting = useSubmit(
    async (path: string, ok: string) => {
      setMessage(null);
      const res = await api<{ url?: string }>(path, { method: "POST", body: {} });
      if (res?.url) {
        window.location.href = res.url;
        return;
      }
      await Promise.all([reload(), records.reload()]);
      setMessage(ok);
    },
    { fallback: "Something went wrong. Try again." },
  );
  const run = (path: string, ok: string) => acting.run(path, ok);
  const busy = acting.busy;
  const returned = params.get("error");

  // While a sync is queued or running, look again shortly.
  const pending = data ? Object.values(data.counts).some((c) => (c.queued ?? 0) + (c.syncing ?? 0) > 0) : false;
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => void Promise.all([reload(), records.reload()]), 3000);
    return () => clearTimeout(t);
  }, [pending, data, reload, records]);

  if (!data) return <LoadState load={status} label="QuickBooks" />;
  const c = data.connection;
  const connected = c && c.status !== "disconnected";
  const refreshAll = async () => {
    await Promise.all([reload(), records.reload()]);
  };

  return (
    <div className="stack">
      <h1>QuickBooks</h1>
      {returned && <p className="error">{RETURN_MESSAGES[returned] ?? "QuickBooks was not connected."}</p>}
      {params.get("connected") && c?.setupState === "review" && <p className="restriction">Connected. Next, review how your customers match QuickBooks.</p>}

      <section className="card stack">
        {data.provider === "none" && <p className="muted">QuickBooks is not configured on this server.</p>}
        {data.provider === "test" && <p className="restriction small">This server uses a built-in test company instead of QuickBooks Online. Nothing reaches a real QuickBooks account.</p>}
        {data.provider !== "none" && !connected && (
          <>
            <p>Connect QuickBooks Online so invoices, payments and customers reach your books without typing them twice. Aerowise never changes or deletes anything in QuickBooks without asking.</p>
            {owner ? (
              <div>
                <button disabled={busy} onClick={() => void run("/quickbooks/connect", "")}>
                  Connect QuickBooks
                </button>
              </div>
            ) : (
              <p className="muted small">The owner can connect QuickBooks.</p>
            )}
          </>
        )}
        {connected && (
          <>
            <div className="row">
              <h2>{c.companyName ?? "QuickBooks company"}</h2>
              {c.status === "connected" ? <Badge tone="success">Connected</Badge> : <Badge tone="danger">Needs reconnecting</Badge>}
              {c.environment !== "production" && <Badge>{c.environment === "test" ? "Test company" : "Sandbox"}</Badge>}
              <span className="spacer" />
              {c.setupState === "active" && editable && c.status === "connected" && (
                <button className="secondary" disabled={busy} onClick={() => void run("/quickbooks/sync", "Sync started")}>
                  Sync now
                </button>
              )}
            </div>
            {c.status === "needs_reauth" && (
              <p className="error">
                QuickBooks stopped accepting this connection{c.lastSyncError ? ` (${c.lastSyncError})` : ""}. Nothing is lost: changes wait until it is reconnected.
              </p>
            )}
            <dl className="details">
              <dt>Last sync</dt>
              <dd>{c.lastSyncFinishedAt ? when(c.lastSyncFinishedAt) : "Not yet"}</dd>
              {c.lastSyncError && c.status === "connected" && (
                <>
                  <dt>Last sync problem</dt>
                  <dd className="error">{c.lastSyncError}</dd>
                </>
              )}
              <dt>Connected</dt>
              <dd>{when(c.connectedAt)}</dd>
            </dl>
            {owner && (
              <div className="row">
                {c.status === "needs_reauth" && (
                  <button disabled={busy} onClick={() => void run("/quickbooks/connect", "")}>
                    Reconnect QuickBooks
                  </button>
                )}
                <ConfirmButton className="link danger" question="Stop syncing with QuickBooks? Nothing already in QuickBooks is changed." confirmLabel="Disconnect" busy={busy} onConfirm={() => run("/quickbooks/disconnect", "Disconnected")}>
                  Disconnect
                </ConfirmButton>
              </div>
            )}
          </>
        )}
        {message && <p className="muted">{message}</p>}
        <FormError error={acting.error} />
      </section>

      {connected && c.setupState === "review" && (
        <section className="card stack">
          <h2>First sync</h2>
          <p>Before anything is sent, check how your customers match the ones already in QuickBooks, so nobody is added twice. Choose the products and services below first.</p>
          <div>
            <Link className="button" href="/quickbooks/review">
              Review customer matches
            </Link>
          </div>
        </section>
      )}

      {connected && c.setupState === "active" && (
        <>
          <section className="stack">
            <div className="row">
              <h2>Needs a decision</h2>
              {data.attention > 0 && <Badge tone="warning">{data.attention}</Badge>}
            </div>
            <LoadState load={records} label="QuickBooks records" quiet />
            {records.data && records.data.length === 0 && <p className="card muted">Nothing needs you. Every record is in QuickBooks, on its way, or set aside on purpose.</p>}
            {records.data && records.data.length > 0 && (
              <ul className="exceptions">
                {records.data.map((r) => (
                  <RecordCard key={`${r.id}-${r.updatedAt}`} r={r} editable={editable} onDone={refreshAll} />
                ))}
              </ul>
            )}
          </section>

          <section className="card stack">
            <h2>Sync health</h2>
            <table className="compact">
              <thead>
                <tr>
                  <th />
                  {HEALTH_ORDER.map((s) => (
                    <th key={s}>{QUICKBOOKS_SYNC_STATUS_LABELS[s]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(Object.keys(ENTITY_LABELS) as (keyof typeof ENTITY_LABELS)[]).map((e) => (
                  <tr key={e}>
                    <td>{ENTITY_LABELS[e]}</td>
                    {HEALTH_ORDER.map((s) => (
                      <td key={s}>{data.counts[e][s] ?? 0}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">Failed records are retried on their own a few times. Customers are sent when they first have an invoice, or when the first sync linked them.</p>
          </section>
        </>
      )}

      {connected && c.status === "connected" && <MappingForm owner={owner} onSaved={refreshAll} />}
    </div>
  );
}

export default function QuickBooksPage() {
  return (
    <Suspense>
      <QuickBooks />
    </Suspense>
  );
}
