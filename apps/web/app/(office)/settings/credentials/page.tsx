"use client";

import { CREDENTIAL_KINDS, CREDENTIAL_LABELS, type Credential } from "@aerowise/domain";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, today } from "@/lib/format";
import { useSession } from "@/lib/session";

/**
 * Licenses and registrations: the responsible maintenance provider's MP license, each
 * technician's registration, installer licenses. Filings check them before anything goes
 * to an authority. One person can hold several.
 */
export default function CredentialsPage() {
  const { role } = useSession();
  const owner = role === "owner";
  const { data, error, reload } = useLoad<{ items: Credential[] }>("/credentials");
  const people = useLoad<{ items: { id: string; name: string }[] }>(owner ? "/technicians" : null);
  const [message, setMessage] = useState<string | null>(null);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  async function send(action: () => Promise<unknown>, done: string) {
    setMessage(null);
    try {
      await action();
      await reload();
      setMessage(done);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const v = formValues(form);
    void send(async () => {
      await api("/credentials", {
        method: "POST",
        body: {
          userId: v.userId ?? null,
          holderName: v.holderName,
          kind: v.kind,
          number: v.number,
          expiresOn: v.expiresOn ?? null,
          verifiedOn: v.verifiedOn ?? null,
          verificationSource: v.verificationSource ?? null,
        },
      });
      form.reset();
    }, "Added");
  }

  const todayOn = today();
  const responsible = data.items.find((c) => c.responsible);
  return (
    <div className="stack">
      <p>
        <Link href="/filings">← Filings</Link>
      </p>
      <h1>Licenses and registrations</h1>
      <p className="muted">
        Authorities that ask for them (LCRA&apos;s cover sheet, for one) need the responsible maintenance provider&apos;s TCEQ MP number, and the technician who did the inspection must hold an active MP license or
        maintenance technician registration. Filings are held for review until these are on record. Check numbers against TCEQ&apos;s license search and record when you did.
      </p>
      {message && <p className="muted">{message}</p>}

      <section className="card stack">
        <h2>Responsible maintenance provider</h2>
        {responsible ? (
          <p>
            <strong>{responsible.holderName}</strong>, MP {responsible.number}
            {responsible.expiresOn && <span className="muted small"> · expires {day(responsible.expiresOn)}</span>}
          </p>
        ) : (
          <p className="restriction">Not set. Filings to authorities that need an MP number will wait for review.</p>
        )}
        {owner && (
          <label>
            Choose
            <select
              value={responsible?.id ?? ""}
              onChange={(e) => void send(() => api("/settings/responsible-provider", { method: "PUT", body: { credentialId: e.target.value || null } }), "Saved")}
            >
              <option value="">None</option>
              {data.items
                .filter((c) => c.kind === "tceq_maintenance_provider" && c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.holderName}, MP {c.number}
                  </option>
                ))}
            </select>
          </label>
        )}
      </section>

      <table>
        <thead>
          <tr>
            <th>Holder</th>
            <th>Credential</th>
            <th>Number</th>
            <th>Expires</th>
            <th>Checked</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((c) => (
            <tr key={c.id}>
              <td>{c.holderName}</td>
              <td>{CREDENTIAL_LABELS[c.kind]}</td>
              <td>{c.number}</td>
              <td>
                {c.expiresOn ? day(c.expiresOn) : "—"}
                {c.expiresOn && c.expiresOn < todayOn && <span className="badge expired">Expired</span>}
              </td>
              <td className="small">{c.verifiedOn ? `${day(c.verifiedOn)}, ${c.verificationSource}` : <span className="muted">Not recorded</span>}</td>
              <td>
                {!c.active && <span className="badge inactive">Inactive</span>}
                {owner && (
                  <button className="link" onClick={() => void send(() => api(`/credentials/${c.id}`, { method: "PATCH", body: { active: !c.active } }), "Saved")}>
                    {c.active ? "Mark inactive" : "Mark active"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.items.length === 0 && <p className="muted">None recorded yet.</p>}

      {owner && (
        <form className="card stack" onSubmit={add}>
          <h2>Add one</h2>
          <label>
            Person (if they sign in)
            <select name="userId" defaultValue="">
              <option value="">Not a user</option>
              {people.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name on the license
            <input name="holderName" required />
          </label>
          <label>
            Kind
            <select name="kind" defaultValue="tceq_maintenance_provider">
              {CREDENTIAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CREDENTIAL_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Number
            <input name="number" required />
          </label>
          <label>
            Expires on
            <input name="expiresOn" type="date" />
          </label>
          <div className="row">
            <label>
              Checked on
              <input name="verifiedOn" type="date" />
            </label>
            <label>
              Checked where
              <input name="verificationSource" placeholder="e.g. TCEQ license search" />
            </label>
          </div>
          <button type="submit">Add</button>
        </form>
      )}
    </div>
  );
}
