"use client";

import { canInviteRole, ROLES, type InvitationSent, type Role, type UsersOverview } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { canEdit, useSession } from "@/lib/session";

const ROLE_LABELS: Record<Role, string> = { owner: "Owner", office: "Office", technician: "Technician", read_only: "Read-only" };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/Chicago" });

export default function UsersPage() {
  const me = useSession();
  const { data, reload } = useLoad<UsersOverview>("/users");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<InvitationSent | null>(null);
  // Nothing here changes while the plan is read-only or support is looking.
  const editable = canEdit(me);
  const owner = editable && me.role === "owner";
  const roles = editable ? ROLES.filter((r) => canInviteRole(me.role, r)) : [];

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const v = formValues(event.currentTarget);
    try {
      setSent(await api<InvitationSent>("/invitations", { method: "POST", body: { email: v.email, name: v.name, role: v.role } }));
      setInviting(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the invitation");
    }
  }

  async function resend(id: string) {
    setSent(await api<InvitationSent>(`/invitations/${id}/resend`, { method: "POST", body: {} }));
    await reload();
  }

  async function setActive(userId: string, active: boolean) {
    await api(`/users/${userId}/${active ? "reactivate" : "deactivate"}`, { method: "POST", body: {} });
    await reload();
  }

  async function revoke(id: string) {
    await api(`/invitations/${id}/revoke`, { method: "POST", body: {} });
    setSent(null);
    await reload();
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Users</h1>
        <span className="spacer" />
        {editable && <button onClick={() => setInviting((c) => !c)}>{inviting ? "Cancel" : "Invite someone"}</button>}
      </div>

      {sent && (
        <div className="card stack" role="status">
          <p style={{ margin: 0 }}>
            {sent.emailed ? `Invitation emailed to ${sent.invitation.email}.` : `The email to ${sent.invitation.email} could not be sent.`} You can also share this
            link with them. It works once and expires on {day(sent.invitation.expiresAt)}.
          </p>
          <input readOnly value={sent.url} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}

      {inviting && (
        <form className="card grid" onSubmit={onInvite}>
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Name
            <input name="name" placeholder="Optional" />
          </label>
          <label>
            Role
            <select name="role" defaultValue="technician">
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="error wide">{error}</p>}
          <div className="wide">
            <button type="submit">Send invitation</button>
          </div>
        </form>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            {owner && <th />}
          </tr>
        </thead>
        <tbody>
          {data?.members.map((m) => (
            <tr key={m.userId}>
              <td>{m.name}</td>
              <td>{m.email}</td>
              <td>{ROLE_LABELS[m.role]}</td>
              <td>
                <span className={`badge ${m.active ? "active" : "inactive"}`}>{m.active ? "active" : "deactivated"}</span>
              </td>
              {owner && (
                <td>
                  {m.userId !== me.user.id && (
                    <button
                      className="link"
                      onClick={() => {
                        if (m.active && !window.confirm(`Deactivate ${m.name}? They are signed out at once and cannot sign in to ${me.organization.name}.`)) return;
                        void setActive(m.userId, !m.active);
                      }}
                    >
                      {m.active ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {data && data.invitations.length > 0 && (
        <>
          <h2>Invitations</h2>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Sent</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.invitations.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.email}
                    {i.name && <span className="muted"> · {i.name}</span>}
                  </td>
                  <td>{ROLE_LABELS[i.role]}</td>
                  <td>
                    {day(i.sentAt)} <span className="muted">by {i.invitedBy}</span>
                  </td>
                  <td>
                    <span className={`badge ${i.status === "expired" ? "expired" : "upcoming"}`}>{i.status}</span>
                  </td>
                  <td>
                    {editable && canInviteRole(me.role, i.role) && (
                      <span className="row">
                        <button className="link" onClick={() => resend(i.id)}>
                          Send again
                        </button>
                        <button className="link" onClick={() => revoke(i.id)}>
                          Cancel
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
