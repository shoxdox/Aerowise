"use client";

import type { AdminOrganization, InvitationSent } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" }) : "Never";

export default function AdminOrganizationsPage() {
  const { data, reload } = useLoad<{ items: AdminOrganization[] }>("/admin/organizations");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [invitingFor, setInvitingFor] = useState<AdminOrganization | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ org: string; result: InvitationSent } | null>(null);

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!invitingFor) return;
    setInviteError(null);
    const v = formValues(event.currentTarget);
    try {
      const result = await api<InvitationSent>(`/admin/organizations/${invitingFor.id}/invitations`, {
        method: "POST",
        body: { email: v.email, name: v.name },
      });
      setSent({ org: invitingFor.name, result });
      setInvitingFor(null);
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : "Could not send the invitation");
    }
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const v = formValues(event.currentTarget);
    try {
      const org = await api<AdminOrganization>("/admin/organizations", {
        method: "POST",
        body: { name: v.name, email: v.email, phone: v.phone, timezone: v.timezone },
      });
      setCreating(false);
      setCreated(org.name);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the organization");
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Organizations</h1>
        <span className="spacer" />
        <button onClick={() => setCreating((c) => !c)}>{creating ? "Cancel" : "New organization"}</button>
      </div>
      {created && <p role="status">Created {created}.</p>}

      {sent && (
        <div className="card stack" role="status">
          <p style={{ margin: 0 }}>
            {sent.result.emailed ? `Owner invitation for ${sent.org} emailed to ${sent.result.invitation.email}.` : `The email to ${sent.result.invitation.email} could not be sent.`}{" "}
            The link below works once, for 7 days.
          </p>
          <input readOnly value={sent.result.url} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}

      {invitingFor && (
        <form className="card grid" onSubmit={onInvite}>
          <p className="wide" style={{ margin: 0 }}>
            <strong>Invite the owner of {invitingFor.name}</strong>
          </p>
          <label>
            Owner email
            <input name="email" type="email" required />
          </label>
          <label>
            Owner name
            <input name="name" placeholder="Optional" />
          </label>
          {inviteError && <p className="error wide">{inviteError}</p>}
          <div className="wide row">
            <button type="submit">Send owner invitation</button>
            <button type="button" className="link" onClick={() => setInvitingFor(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {creating && (
        <form className="card grid" onSubmit={onCreate}>
          <label className="wide">
            Company name
            <input name="name" required placeholder="Brazos Aerobic Co" />
          </label>
          <label>
            Office email
            <input name="email" type="email" />
          </label>
          <label>
            Office phone
            <input name="phone" type="tel" />
          </label>
          <label>
            Time zone
            <select name="timezone" defaultValue="America/Chicago">
              <option value="America/Chicago">Central</option>
              <option value="America/Denver">Mountain (El Paso)</option>
            </select>
          </label>
          {error && <p className="error wide">{error}</p>}
          <div className="wide">
            <button type="submit">Create organization</button>
          </div>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Organization</th>
            <th>Active contracts</th>
            <th>Users</th>
            <th>Last activity</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.items.map((o) => (
            <tr key={o.id}>
              <td>{o.name}</td>
              <td>{o.activeContracts}</td>
              <td>{o.users}</td>
              <td>{when(o.lastActivityAt)}</td>
              <td>{when(o.createdAt)}</td>
              <td>
                <button className="link" onClick={() => { setInvitingFor(o); setSent(null); }}>
                  Invite owner
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.items.length === 0 && <p className="muted">No organizations yet.</p>}
    </div>
  );
}
