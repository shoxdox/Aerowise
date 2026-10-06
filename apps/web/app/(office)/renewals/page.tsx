"use client";

import { type RenewalAddon, type RenewalListItem, type RenewalSettings, type RenewalStatus } from "@aerowise/domain";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { RenewalBadge } from "@/components/RenewalBadge";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money, when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { EmptyState } from "@/components/EmptyState";

const TABS: { key: string; label: string; statuses: RenewalStatus[] | null }[] = [
  { key: "open", label: "In progress", statuses: ["upcoming", "sent", "viewed", "signed", "payment_pending", "paid", "needs_review"] },
  { key: "upcoming", label: "Not sent", statuses: ["upcoming"] },
  { key: "sent", label: "Sent", statuses: ["sent", "viewed"] },
  { key: "signed", label: "Signed", statuses: ["signed", "payment_pending", "paid"] },
  { key: "needs_review", label: "Needs review", statuses: ["needs_review"] },
  { key: "activated", label: "Renewed", statuses: ["activated"] },
  { key: "lost", label: "Declined or expired", statuses: ["declined", "expired"] },
  { key: "all", label: "All", statuses: null },
];

/** The furthest the customer has got, for the table. */
function lastStep(r: RenewalListItem) {
  if (r.activatedAt) return `Renewed ${when(r.activatedAt)}`;
  if (r.signedAt) return `Signed ${when(r.signedAt)}`;
  if (r.viewedAt) return `Opened ${when(r.viewedAt)}`;
  if (r.sentAt) return `Emailed ${when(r.sentAt)}`;
  return r.hasEmail ? "Not sent yet" : "No email on file";
}

export default function RenewalsPage() {
  const editable = canEdit(useSession());
  const [tab, setTab] = useState("open");
  const { data, error, reload } = useLoad<{ items: RenewalListItem[]; counts: Partial<Record<RenewalStatus, number>>; notStarted: number }>("/renewals?limit=500");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  async function runCampaign() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api<{ created: number; sent: number; reminded: number; expired: number; activated: number }>("/renewals/campaign", { method: "POST", body: {} });
      const parts = [
        `${r.created} started`,
        r.sent ? `${r.sent} emailed` : null,
        r.reminded ? `${r.reminded} reminded` : null,
        r.expired ? `${r.expired} expired` : null,
        r.activated ? `${r.activated} activated` : null,
      ].filter(Boolean);
      setMessage(`Campaign run: ${parts.join(", ")}.`);
      await reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not run the campaign");
    } finally {
      setBusy(false);
    }
  }

  const statuses = TABS.find((t) => t.key === tab)?.statuses;
  const items = data?.items.filter((r) => !statuses || statuses.includes(r.status)) ?? [];
  const count = (t: (typeof TABS)[number]) => (t.statuses ? t.statuses.reduce((n, s) => n + (data?.counts[s] ?? 0), 0) : Object.values(data?.counts ?? {}).reduce((n, c) => n + (c ?? 0), 0));

  return (
    <div className="stack">
      <div className="row">
        <h1>Renewals</h1>
        <span className="spacer" />
        {editable && (
          <>
            <button className="secondary" onClick={() => setShowSettings((s) => !s)}>
              {showSettings ? "Hide settings" : "Settings and add-ons"}
            </button>
            <button onClick={() => void runCampaign()} disabled={busy}>
              Run campaign now
            </button>
          </>
        )}
      </div>
      {data && data.notStarted > 0 && (
        <p className="muted">
          {data.notStarted} contract{data.notStarted === 1 ? "" : "s"} inside the renewal window {data.notStarted === 1 ? "has" : "have"} no renewal yet. The campaign starts them every hour, or run it now.
        </p>
      )}
      {message && <p>{message}</p>}
      {error && <p className="error">{error}</p>}
      {showSettings && editable && <RenewalSettingsPanel />}

      <div className="renewal-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? undefined : "secondary"} onClick={() => setTab(t.key)}>
            {t.label} ({count(t)})
          </button>
        ))}
      </div>

      {data && items.length === 0 && (
        <EmptyState title="No renewals in this list">
          Renewals start on their own for contracts ending inside the renewal window, and go to the customer to sign and pay. Change the window under Settings and add-ons, or run the campaign now.
        </EmptyState>
      )}
      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Contract ends</th>
              <th>Status</th>
              <th>Latest</th>
              <th style={{ textAlign: "right" }}>Next term</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/renewals/${r.id}`}>{r.customer.displayName}</Link>
                  <div className="muted small">
                    {r.site.addressLine1}, {r.site.city}
                  </div>
                </td>
                <td>{day(r.contractEndOn)}</td>
                <td>
                  <RenewalBadge status={r.status} />
                  {r.reviewReason && <div className="error small">{r.reviewReason}</div>}
                </td>
                <td className="small">{lastStep(r)}</td>
                <td style={{ textAlign: "right" }}>
                  {money(r.priceCents)}
                  <div className="muted small">{r.planName}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RenewalSettingsPanel() {
  const settings = useLoad<RenewalSettings>("/renewals/settings");
  const addons = useLoad<{ items: RenewalAddon[] }>("/renewals/addons");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setSaved(false);
    try {
      await action();
      setSaved(true);
      await Promise.all([settings.reload(), addons.reload()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    const terms = v.terms?.trim();
    void run(() =>
      api("/renewals/settings", {
        method: "PATCH",
        body: {
          windowDays: Number(v.windowDays),
          autoSend: v.autoSend === "on",
          payment: v.payment,
          // Saving the built-in text unchanged keeps following the built-in text.
          terms: !terms || (!settings.data?.customTerms && terms === settings.data?.terms.trim()) ? null : terms,
        },
      }),
    );
  }

  function onAddAddon(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = formValues(form);
    void run(async () => {
      await api("/renewals/addons", { method: "POST", body: { name: v.name, description: v.description, priceCents: Math.round(Number(v.price ?? 0) * 100), taxable: v.taxable === "on" } });
      form.reset();
    });
  }

  const s = settings.data;
  return (
    <div className="columns">
      {s && (
        <form className="card stack" onSubmit={onSave}>
          <h2>Campaign</h2>
          <label>
            Start renewals this many days before a contract ends
            <input name="windowDays" type="number" min={14} max={180} defaultValue={s.windowDays} required />
          </label>
          <label className="check">
            <input type="checkbox" name="autoSend" defaultChecked={s.autoSend} />
            Email renewal links and reminders automatically
          </label>
          <label>
            When does the new term start?
            <select name="payment" defaultValue={s.payment}>
              <option value="pay_to_activate">Once the customer pays</option>
              <option value="invoice">When the customer signs (they pay the invoice on its terms)</option>
            </select>
          </label>
          <label>
            Agreement terms the customer signs
            <textarea name="terms" rows={8} defaultValue={s.terms} />
          </label>
          <div className="row">
            <button type="submit">Save</button>
            {saved && <span className="muted">Saved</span>}
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      )}
      <div className="card stack">
        <h2>Add-ons</h2>
        <p className="muted small">Offered on every renewal page. Customers pick them when they sign, and they are billed once with the first payment.</p>
        {addons.data?.items.length === 0 && <p className="muted">No add-ons yet.</p>}
        {addons.data?.items.map((a) => (
          <div key={a.id} className="row">
            <span>
              {a.name} · {money(a.priceCents)}
              {a.taxable ? " · taxed" : ""}
              {!a.active && <span className="badge inactive"> retired</span>}
            </span>
            <span className="spacer" />
            <button className="link" onClick={() => void run(() => api(`/renewals/addons/${a.id}`, { method: "PATCH", body: { active: !a.active } }))}>
              {a.active ? "Retire" : "Offer again"}
            </button>
          </div>
        ))}
        <form className="stack" onSubmit={onAddAddon}>
          <label>
            Name
            <input name="name" required maxLength={200} />
          </label>
          <label>
            Description
            <input name="description" maxLength={1000} />
          </label>
          <label>
            Price ($)
            <input name="price" type="number" min={0} step="0.01" required />
          </label>
          <label className="check">
            <input type="checkbox" name="taxable" />
            Charge sales tax
          </label>
          <button type="submit" className="secondary">
            Add add-on
          </button>
        </form>
      </div>
    </div>
  );
}
