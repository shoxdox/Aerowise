"use client";

import { CREDENTIAL_KINDS, CREDENTIAL_LABELS, type Credential } from "@aerowise/domain";
import Link from "next/link";
import { useState } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { day, mpNumber, today } from "@/lib/format";
import { useSession } from "@/lib/session";
import { EmptyState } from "@/components/EmptyState";

/**
 * Licenses and registrations: the responsible maintenance provider's MP license, each
 * technician's registration, installer licenses. Filings check them before anything goes
 * to an authority. One person can hold several.
 */
export default function CredentialsPage() {
  const { role } = useSession();
  const owner = role === "owner";
  const credentials = useLoad<{ items: Credential[] }>("/credentials");
  const { data, reload } = credentials;
  const people = useLoad<{ items: { id: string; name: string }[] }>(owner ? "/technicians" : null);
  const [message, setMessage] = useState<string | null>(null);
  // Which change the message is about, so "Added" shows by the form that added it.
  const [added, setAdded] = useState(false);

  const sending = useSubmit(
    async (action: () => Promise<unknown>, done: string) => {
      setMessage(null);
      setAdded(false);
      await action();
      await reload();
      setMessage(done);
    },
    { fallback: "Could not save." },
  );
  const send = (action: () => Promise<unknown>, done: string) => sending.run(action, done);
  const adding = useSubmit(
    async (v: Record<string, string | undefined>, form: HTMLFormElement) => {
      setAdded(false);
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
      await reload();
      setAdded(true);
    },
    { fallback: "Could not add the license." },
  );

  if (!data) return <LoadState load={credentials} label="licenses" />;
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
      <FormError error={sending.error} />

      <section className="card stack">
        <h2>Responsible maintenance provider</h2>
        {responsible ? (
          <p>
            <strong>{responsible.holderName}</strong>, {mpNumber(responsible.number)}
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
              disabled={sending.busy}
              onChange={(e) => void send(() => api("/settings/responsible-provider", { method: "PUT", body: { credentialId: e.target.value || null } }), "Saved")}
            >
              <option value="">None</option>
              {data.items
                .filter((c) => c.kind === "tceq_maintenance_provider" && c.active)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.holderName}, {mpNumber(c.number)}
                  </option>
                ))}
            </select>
          </label>
        )}
      </section>

      <table className="stack">
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
              <td data-label="Holder">{c.holderName}</td>
              <td data-label="Credential">{CREDENTIAL_LABELS[c.kind]}</td>
              <td data-label="Number">{c.number}</td>
              <td data-label="Expires">
                {c.expiresOn ? day(c.expiresOn) : "—"} {c.expiresOn && c.expiresOn < todayOn && <Badge tone="danger">Expired</Badge>}
              </td>
              <td data-label="Checked" className="small">
                {c.verifiedOn ? `${day(c.verifiedOn)}, ${c.verificationSource}` : <span className="muted">Not recorded</span>}
              </td>
              <td className={owner || !c.active ? "actions" : undefined}>
                {!c.active && <Badge tone="muted">Inactive</Badge>}{" "}
                {owner && (
                  <button className={c.active ? "link danger" : "link"} disabled={sending.busy} onClick={() => void send(() => api(`/credentials/${c.id}`, { method: "PATCH", body: { active: !c.active } }), "Saved")}>
                    {c.active ? "Mark inactive" : "Mark active"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.items.length === 0 && (
        <EmptyState title="No licenses recorded yet">
          Record your maintenance provider license and each technician&apos;s registration. Reports to the authorities need them before they can be signed and filed.
        </EmptyState>
      )}

      {owner && (
        <form className="card stack" onSubmit={adding.form}>
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
          <FormError error={adding.error} />
          <div className="row">
            <SubmitButton busy={adding.busy}>Add</SubmitButton>
            {added && (
              <span className="muted" role="status">
                Added.{!responsible && " Choose it as the responsible maintenance provider above if it is."}
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
