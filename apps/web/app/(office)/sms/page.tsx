"use client";

import { formatPhone, SMS_KIND_LABELS, SMS_KINDS, SMS_SKIP_LABELS, type SmsKind, type SmsMessage, type SmsOptOut, type SmsSettings } from "@aerowise/domain";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { when } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { EmptyState } from "@/components/EmptyState";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "replies", label: "Replies" },
  { key: "problems", label: "Not delivered" },
] as const;

const STATUS_LABEL: Record<SmsMessage["status"], string> = {
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  skipped: "Not sent",
  received: "Received",
};
const STATUS_CLASS: Partial<Record<SmsMessage["status"], string>> = { delivered: "ok", failed: "danger", skipped: "warn", received: "upcoming" };

const phone = (p: string | null) => (p ? formatPhone(p) : "—");

function Texts() {
  const me = useSession();
  const editable = canEdit(me);
  const owner = me.role === "owner";
  const initial = useSearchParams().get("filter");
  const [filter, setFilter] = useState<string>(FILTERS.some((f) => f.key === initial) ? initial! : "all");
  const settings = useLoad<SmsSettings>("/sms/settings");
  const messages = useLoad<{ items: SmsMessage[] }>(`/sms/messages?filter=${filter}`);
  const optOuts = useLoad<{ items: SmsOptOut[] }>("/sms/opt-outs");
  const reloadAll = () => Promise.all([settings.reload(), messages.reload(), optOuts.reload()]);

  async function handled(id: string) {
    await api(`/sms/messages/${id}/handled`, { method: "POST", body: {} });
    await messages.reload();
  }

  const s = settings.data;
  return (
    <div className="stack">
      <div className="row">
        <h1>Texts</h1>
        <span className="spacer" />
        {s && (
          <span className={`badge ${s.enabled ? "ok" : ""}`}>
            {s.mode === "off" ? "Not set up" : s.enabled ? `On · from ${s.fromNumber ? formatPhone(s.fromNumber) : "—"}` : "Off"}
          </span>
        )}
      </div>
      {s?.mode === "test" && (
        <p className="notice">
          Test mode: no texts leave Aerowise. Each one is recorded below as if a phone got it. Add a Twilio account to send real texts.
        </p>
      )}
      {settings.error && <p className="error">{settings.error}</p>}

      <div className="columns">
        {s && <SettingsCard s={s} owner={owner} onSaved={() => void reloadAll()} />}
        <div className="stack">
          {s?.mode === "test" && editable && <TestReply onSent={() => void reloadAll()} />}
          <div className="card stack">
            <h2>Replied STOP</h2>
            <p className="muted small">These numbers get no texts. Only the customer can turn texts back on, by texting START.</p>
            {optOuts.data?.items.length === 0 && <p className="muted">Nobody has opted out.</p>}
            {optOuts.data?.items.map((o) => (
              <div key={o.phone} className="small">
                <strong>{phone(o.phone)}</strong> · {o.source === "reply" ? "replied STOP" : "unsubscribed with their carrier"} {when(o.optedOutAt)}
                {o.customers.map((c) => (
                  <span key={c.id}>
                    {" "}
                    · <Link href={`/customers/${c.id}`}>{c.displayName}</Link>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="renewal-tabs">
        {FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? undefined : "secondary"} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      {messages.error && <p className="error">{messages.error}</p>}
      {messages.data?.items.length === 0 && (
        <EmptyState title="No texts here">
          Visit reminders and invoice links texted to customers show here, with their delivery and any replies. Customers get texts once they have a mobile number on file, until they reply STOP.
        </EmptyState>
      )}
      {messages.data && messages.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Customer</th>
              <th>Text</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {messages.data.items.map((m) => (
              <tr key={m.id}>
                <td className="small">{when(m.createdAt)}</td>
                <td>
                  {m.customer ? <Link href={`/customers/${m.customer.id}`}>{m.customer.displayName}</Link> : <span className="muted">Unknown number</span>}
                  <div className="muted small">
                    {m.direction === "inbound" ? "From" : "To"} {phone(m.phone)}
                    {m.contactName ? ` · ${m.contactName}` : ""}
                  </div>
                </td>
                <td>
                  <div className="muted small">{m.kind ? SMS_KIND_LABELS[m.kind] : "Customer's reply"}</div>
                  {m.body}
                </td>
                <td>
                  <span className={`badge ${STATUS_CLASS[m.status] ?? ""}`}>{STATUS_LABEL[m.status]}</span>
                  {m.skipReason && <div className="muted small">{SMS_SKIP_LABELS[m.skipReason]}</div>}
                  {m.error && <div className="error small">{m.error}</div>}
                  {m.direction === "inbound" &&
                    (m.handledAt ? (
                      <div className="muted small">Handled</div>
                    ) : (
                      editable && (
                        <div>
                          <button className="link" onClick={() => void handled(m.id)}>
                            Mark handled
                          </button>
                        </div>
                      )
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SettingsCard({ s, owner, onSaved }: { s: SmsSettings; owner: boolean; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = formValues(form);
    const kinds = SMS_KINDS.filter((k) => (form.elements.namedItem(`kind_${k}`) as HTMLInputElement | null)?.checked);
    setError(null);
    setSaved(false);
    try {
      await api("/sms/settings", { method: "PATCH", body: { enabled: v.enabled === "on", kinds, ...(s.mode === "live" ? { fromNumber: v.fromNumber ?? null } : {}) } });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  if (s.mode === "off") {
    return (
      <div className="card stack">
        <h2>Texting</h2>
        <p className="muted">Texting is not set up on this server. It needs a Twilio account (TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN).</p>
      </div>
    );
  }
  return (
    <form className="card stack" onSubmit={onSubmit}>
      <h2>Texting</h2>
      <p className="muted small">Texts go only to contacts who agreed to them (the “texts” box on the contact), never to a number that replied STOP, and automatic ones only between 8 am and 9 pm.</p>
      <fieldset disabled={!owner} className="plain stack">
        <label className="check">
          <input type="checkbox" name="enabled" defaultChecked={s.enabled} />
          Text customers
        </label>
        <div className="stack">
          <span className="small">Which texts go</span>
          {SMS_KINDS.map((k: SmsKind) => (
            <label key={k} className="check">
              <input type="checkbox" name={`kind_${k}`} defaultChecked={s.kinds.includes(k)} />
              {SMS_KIND_LABELS[k]}
            </label>
          ))}
        </div>
        {s.mode === "live" && (
          <label>
            Twilio number texts come from
            <input name="fromNumber" defaultValue={s.fromNumber ?? ""} placeholder="+15125550100" pattern="\+[1-9]\d{7,14}" />
          </label>
        )}
        {s.webhooks && (
          <p className="muted small">
            On that number in Twilio, send incoming messages to <code>{s.webhooks.inbound}</code>. Delivery receipts come back to <code>{s.webhooks.status}</code> on their own.
          </p>
        )}
        {owner && (
          <div className="row">
            <button type="submit">Save</button>
            {saved && <span className="muted">Saved</span>}
          </div>
        )}
      </fieldset>
      {!owner && <p className="muted small">Only the owner can change these.</p>}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

/** Test mode only: play a text from a customer, to see STOP, START and replies at work. */
function TestReply({ onSent }: { onSent: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = formValues(form);
    setMessage(null);
    try {
      const r = await api<{ keyword: string | null }>("/sms/test/inbound", { method: "POST", body: { from: v.from, body: v.body } });
      setMessage(r.keyword === "stop" ? "Opted out." : r.keyword === "start" ? "Opted back in." : r.keyword === "help" ? "Help request recorded." : "Reply received. It is in the inbox.");
      form.reset();
      onSent();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not send");
    }
  }
  return (
    <form className="card stack" onSubmit={onSubmit}>
      <h2>Pretend a customer texted</h2>
      <label>
        From
        <input name="from" required placeholder="(512) 555-0123" />
      </label>
      <label>
        Message
        <input name="body" required placeholder="STOP" />
      </label>
      <div className="row">
        <button type="submit" className="secondary">
          Receive text
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
    </form>
  );
}

export default function TextsPage() {
  return (
    <Suspense>
      <Texts />
    </Suspense>
  );
}
