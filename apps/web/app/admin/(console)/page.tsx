"use client";

import {
  SUBSCRIPTION_STATE_LABELS,
  SUBSCRIPTION_TRANSITIONS,
  type AdminOrganization,
  type InvitationSent,
  type SubscriptionConfig,
  type SubscriptionState,
} from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money } from "@/lib/format";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Chicago" }) : "Never";

/** Dollars typed in a form to cents, or null when left blank (use the configured price). */
const toCents = (dollars: string | undefined) => (dollars === undefined ? null : Math.round(Number(dollars) * 100));
const toDollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

function planSummary(o: AdminOrganization) {
  const label = SUBSCRIPTION_STATE_LABELS[o.plan.state];
  if (!o.plan.endsOn) return label;
  const left = o.daysLeft ?? 0;
  const remaining = left > 0 ? `${left} days left` : left === 0 ? "ends today" : `ended ${-left} days ago`;
  return `${label} until ${day(o.plan.endsOn)} (${remaining})`;
}

function priceSummary(o: AdminOrganization, defaults: SubscriptionConfig) {
  const price = o.plan.pricePerContractCentsOverride ?? defaults.pricePerContractCents;
  const minimum = o.plan.monthlyMinimumCentsOverride ?? defaults.monthlyMinimumCents;
  const founder = o.plan.pricePerContractCentsOverride !== null || o.plan.monthlyMinimumCentsOverride !== null;
  return `${money(price)}/contract, ${money(minimum)} min${founder ? " (founder)" : ""}`;
}

function PlanEditor({ org, defaults, onSaved, onCancel }: { org: AdminOrganization; defaults: SubscriptionConfig; onSaved: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const states: SubscriptionState[] = [org.plan.state, ...SUBSCRIPTION_TRANSITIONS[org.plan.state]];

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const v = formValues(event.currentTarget);
    try {
      await api(`/admin/organizations/${org.id}/plan`, {
        method: "PUT",
        body: {
          state: v.state,
          startsOn: v.startsOn,
          endsOn: v.endsOn ?? null,
          pricePerContractCentsOverride: toCents(v.price),
          monthlyMinimumCentsOverride: toCents(v.minimum),
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the plan");
    }
  }

  return (
    <form className="card grid" onSubmit={onSave} aria-label={`Plan for ${org.name}`}>
      <h2 className="wide">Plan for {org.name}</h2>
      <label>
        State
        <select name="state" defaultValue={org.plan.state}>
          {states.map((s) => (
            <option key={s} value={s}>
              {SUBSCRIPTION_STATE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Starts on
        <input name="startsOn" type="date" required defaultValue={org.plan.startsOn} />
      </label>
      <label>
        Ends on
        <input name="endsOn" type="date" defaultValue={org.plan.endsOn ?? ""} />
        <span className="muted small">Required for a trial or design-partner period.</span>
      </label>
      <label>
        Founder price per active contract ($/month)
        <input name="price" type="number" min="0" step="0.01" defaultValue={toDollars(org.plan.pricePerContractCentsOverride)} placeholder={toDollars(defaults.pricePerContractCents)} />
      </label>
      <label>
        Founder monthly minimum ($)
        <input name="minimum" type="number" min="0" step="0.01" defaultValue={toDollars(org.plan.monthlyMinimumCentsOverride)} placeholder={toDollars(defaults.monthlyMinimumCents)} />
      </label>
      <p className="muted small wide">Leave a price blank to use the standard price ({priceSummary({ ...org, plan: { ...org.plan, pricePerContractCentsOverride: null, monthlyMinimumCentsOverride: null } }, defaults)}).</p>
      {error && <p className="error wide">{error}</p>}
      <div className="wide row">
        <button type="submit">Save plan</button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function AdminOrganizationsPage() {
  const { data, reload } = useLoad<{ items: AdminOrganization[]; defaults: SubscriptionConfig }>("/admin/organizations");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
        body: { name: v.name, email: v.email, phone: v.phone, timezone: v.timezone, plan: v.plan },
      });
      setCreating(false);
      setNotice(`Created ${org.name}.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the organization");
    }
  }

  const editingOrg = data?.items.find((o) => o.id === editing);

  return (
    <div className="stack">
      <div className="row">
        <h1>Organizations</h1>
        <span className="spacer" />
        <button onClick={() => setCreating((c) => !c)}>{creating ? "Cancel" : "New organization"}</button>
      </div>
      {notice && <p role="status">{notice}</p>}

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

      {creating && data && (
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
          <label>
            Starts on
            <select name="plan" defaultValue="trial">
              <option value="trial">Free trial ({data.defaults.trialDays} days)</option>
              <option value="design_partner">Design partner ({data.defaults.designPartnerDays} days)</option>
            </select>
          </label>
          {error && <p className="error wide">{error}</p>}
          <div className="wide">
            <button type="submit">Create organization</button>
          </div>
        </form>
      )}

      {editingOrg && data && (
        <PlanEditor
          key={editingOrg.id}
          org={editingOrg}
          defaults={data.defaults}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setNotice(`Saved the plan for ${editingOrg.name}.`);
            await reload();
          }}
        />
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Organization</th>
              <th>Active contracts</th>
              <th>Users</th>
              <th>Last activity</th>
              <th>Created</th>
              <th />
              <th>Plan</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((o) => (
              <tr key={o.id}>
                <td>
                  {o.name}{" "}
                  <button className="link small" onClick={() => setEditing(o.id)} aria-label={`Edit plan for ${o.name}`}>
                    Edit plan
                  </button>
                </td>
                <td>{o.activeContracts}</td>
                <td>{o.users}</td>
                <td>{when(o.lastActivityAt)}</td>
                <td>{when(o.createdAt)}</td>
                <td>
                  <button className="link" onClick={() => { setInvitingFor(o); setSent(null); }}>
                    Invite owner
                  </button>
                </td>
                <td>{planSummary(o)}</td>
                <td>{priceSummary(o, data.defaults)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.items.length === 0 && <p className="muted">No organizations yet.</p>}
    </div>
  );
}
