"use client";

import { canInviteRole, ROLE_LABELS, ROLES, type InvitationSent, type UsersOverview } from "@aerowise/domain";
import { useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadState } from "@/components/LoadState";
import { StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { dayOf } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

export default function UsersPage() {
  const me = useSession();
  const users = useLoad<UsersOverview>("/users");
  const { data, reload } = users;
  const [inviting, setInviting] = useState(false);
  const [sent, setSent] = useState<InvitationSent | null>(null);
  // Nothing here changes while the plan is read-only or support is looking.
  const editable = canEdit(me);
  const owner = editable && me.role === "owner";
  const roles = editable ? ROLES.filter((r) => canInviteRole(me.role, r)) : [];

  const invite = useSubmit(
    async (v: Record<string, string | undefined>) => {
      setSent(await api<InvitationSent>("/invitations", { method: "POST", body: { email: v.email, name: v.name, role: v.role } }));
      setInviting(false);
      await reload();
    },
    { fallback: "Could not send the invitation." },
  );
  // Resending, cancelling an invitation and (de)activating someone each say when they fail.
  const change = useSubmit(
    async (action: () => Promise<unknown>) => {
      await action();
      await reload();
    },
    { fallback: "Could not save the change." },
  );
  const resend = (id: string) => change.run(async () => setSent(await api<InvitationSent>(`/invitations/${id}/resend`, { method: "POST", body: {} })));
  const setActive = (userId: string, active: boolean) => change.run(() => api(`/users/${userId}/${active ? "reactivate" : "deactivate"}`, { method: "POST", body: {} }));
  const revoke = (id: string) =>
    change.run(async () => {
      await api(`/invitations/${id}/revoke`, { method: "POST", body: {} });
      setSent(null);
    });

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
            {!sent.emailed
              ? `The email to ${sent.invitation.email} could not be sent.`
              : sent.delivery === "outbox"
                ? `Invitation for ${sent.invitation.email} recorded in the test outbox; no email was delivered.`
                : `Invitation emailed to ${sent.invitation.email}.`} You can also share this
            link with them. It works once and expires on {dayOf(sent.invitation.expiresAt)}.
          </p>
          <input readOnly value={sent.url} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
        </div>
      )}

      {inviting && (
        <form className="card grid" onSubmit={invite.form}>
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
          <FormError error={invite.error} className="wide" />
          <div className="wide">
            <SubmitButton busy={invite.busy} busyLabel="Sending…">
              Send invitation
            </SubmitButton>
          </div>
        </form>
      )}

      <LoadState load={users} label="users" quiet />
      <FormError error={change.error} />
      {data && (
        <table className="stack">
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
            {data.members.map((m) => (
              <tr key={m.userId}>
                <td data-label="Name">{m.name}</td>
                <td data-label="Email">{m.email}</td>
                <td data-label="Role">{ROLE_LABELS[m.role]}</td>
                <td data-label="Status">
                  <StatusBadge of="membership" value={m.active ? "active" : "deactivated"} />
                </td>
                {owner && (
                  <td className={m.userId !== me.user.id ? "actions" : undefined}>
                    {m.userId !== me.user.id &&
                      (m.active ? (
                        <ConfirmButton
                          className="link danger"
                          question={`Deactivate ${m.name}? They are signed out at once and cannot sign in to ${me.organization.name}.`}
                          confirmLabel="Deactivate"
                          busy={change.busy}
                          onConfirm={() => setActive(m.userId, false)}
                        >
                          Deactivate
                        </ConfirmButton>
                      ) : (
                        <SubmitButton type="button" className="link" busy={change.busy} onClick={() => void setActive(m.userId, true)}>
                          Reactivate
                        </SubmitButton>
                      ))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data && data.invitations.length > 0 && (
        <>
          <h2>Invitations</h2>
          <table className="stack">
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
                  <td data-label="Email">
                    {i.email}
                    {i.name && <span className="muted"> · {i.name}</span>}
                  </td>
                  <td data-label="Role">{ROLE_LABELS[i.role]}</td>
                  <td data-label="Sent">
                    {dayOf(i.sentAt)} <span className="muted">by {i.invitedBy}</span>
                  </td>
                  <td data-label="Status">
                    <StatusBadge of="invitation" value={i.status} />
                  </td>
                  <td className={editable && canInviteRole(me.role, i.role) ? "actions" : undefined}>
                    {editable && canInviteRole(me.role, i.role) && (
                      <span className="row">
                        <SubmitButton type="button" className="link" busy={change.busy} busyLabel="Sending…" onClick={() => void resend(i.id)}>
                          Send again
                        </SubmitButton>
                        <ConfirmButton className="link danger" question="Cancel this invitation? Its link stops working." confirmLabel="Cancel invitation" busy={change.busy} onConfirm={() => revoke(i.id)}>
                          Cancel
                        </ConfirmButton>
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
