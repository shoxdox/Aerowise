"use client";

import {
  PLATFORM_FEE_MAX_BPS,
  SUBSCRIPTION_STATE_LABELS,
  SUBSCRIPTION_TRANSITIONS,
  type AdminOrganization,
  type InvitationSent,
  type OrganizationErasure,
  type SubscriptionConfig,
  type SubscriptionState,
} from "@aerowise/domain";
import { useState } from "react";
import { LoadState } from "@/components/LoadState";
import { Badge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api } from "@/lib/api";
import { day, money, plural, when as moment } from "@/lib/format";

// The platform console has no company of its own, so moments read in Texas time (format.ts's default).
const when = (iso: string | null) => (iso ? moment(iso) : "Never");

/** Dollars typed in a form to cents, or null when left blank (use the configured price). */
const toCents = (dollars: string | undefined) =>
  dollars === undefined ? null : Math.round(Number(dollars) * 100);
const toDollars = (cents: number | null) =>
  cents === null ? "" : (cents / 100).toFixed(2);

function planSummary(o: AdminOrganization) {
  const label = SUBSCRIPTION_STATE_LABELS[o.plan.state];
  if (!o.plan.endsOn) return label;
  const left = o.daysLeft ?? 0;
  const remaining =
    left > 0
      ? `${plural(left, "day")} left`
      : left === 0
        ? "ends today"
        : `ended ${plural(-left, "day")} ago`;
  return `${label} until ${day(o.plan.endsOn)} (${remaining})`;
}

function priceSummary(o: AdminOrganization, defaults: SubscriptionConfig) {
  const price =
    o.plan.pricePerContractCentsOverride ?? defaults.pricePerContractCents;
  const minimum =
    o.plan.monthlyMinimumCentsOverride ?? defaults.monthlyMinimumCents;
  const founder =
    o.plan.pricePerContractCentsOverride !== null ||
    o.plan.monthlyMinimumCentsOverride !== null;
  return `${money(price)}/contract, ${money(minimum)} min${founder ? " (founder)" : ""}`;
}

/** Basis points as a percentage: 50 → "0.5%". */
const feePercent = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

function PlanEditor({
  org,
  defaults,
  onSaved,
  onCancel,
}: {
  org: AdminOrganization;
  defaults: SubscriptionConfig;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const states: SubscriptionState[] = [
    org.plan.state,
    ...SUBSCRIPTION_TRANSITIONS[org.plan.state],
  ];

  const saving = useSubmit(
    async (v: Record<string, string | undefined>) => {
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
      const platformFeeBps = Math.round(Number(v.fee ?? 0) * 100);
      if (platformFeeBps !== org.platformFeeBps) {
        await api(`/admin/organizations/${org.id}/platform-fee`, {
          method: "PUT",
          body: { platformFeeBps },
        });
      }
      onSaved();
    },
    { fallback: "Could not save the plan." },
  );
  const error = saving.error;

  return (
    <form
      className="card grid"
      onSubmit={saving.form}
      aria-label={`Plan for ${org.name}`}
    >
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
        <input
          name="startsOn"
          type="date"
          required
          defaultValue={org.plan.startsOn}
        />
      </label>
      <label>
        Ends on
        <input name="endsOn" type="date" defaultValue={org.plan.endsOn ?? ""} />
        <span className="muted small">
          Required for a trial or design-partner period.
        </span>
      </label>
      <label>
        Founder price per active contract ($/month)
        <input
          name="price"
          type="number"
          min="0"
          step="0.01"
          defaultValue={toDollars(org.plan.pricePerContractCentsOverride)}
          placeholder={toDollars(defaults.pricePerContractCents)}
        />
      </label>
      <label>
        Founder monthly minimum ($)
        <input
          name="minimum"
          type="number"
          min="0"
          step="0.01"
          defaultValue={toDollars(org.plan.monthlyMinimumCentsOverride)}
          placeholder={toDollars(defaults.monthlyMinimumCents)}
        />
      </label>
      <label>
        Platform fee on homeowner payments (%)
        <input
          name="fee"
          type="number"
          min="0"
          max={PLATFORM_FEE_MAX_BPS / 100}
          step="0.01"
          defaultValue={org.platformFeeBps / 100}
        />
        <span className="muted small">
          Taken from each card or bank payment the company collects through
          Aerowise. 0 means no fee.
        </span>
      </label>
      <p className="muted small wide">
        Leave a price blank to use the standard price (
        {priceSummary(
          {
            ...org,
            plan: {
              ...org.plan,
              pricePerContractCentsOverride: null,
              monthlyMinimumCentsOverride: null,
            },
          },
          defaults,
        )}
        ).
      </p>
      <FormError error={error} className="wide" />
      <div className="wide row">
        <SubmitButton busy={saving.busy}>Save plan</SubmitButton>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Deleting an organization's data on its request: the admin types its name and their own password to confirm. */
function EraseForm({ org, onDone, onCancel }: { org: AdminOrganization; onDone: (result: OrganizationErasure) => void; onCancel: () => void }) {
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const erase = useSubmit(
    async () => {
      onDone(await api<OrganizationErasure>(`/admin/organizations/${org.id}/erase`, { method: "POST", body: { confirmName: typed, password } }));
    },
    { fallback: "Could not delete the data." },
  );

  return (
    <form className="card stack" onSubmit={(e) => (e.preventDefault(), void erase.run())} aria-label={`Delete the data of ${org.name}`}>
      <p style={{ margin: 0 }}>
        <strong>Delete all of {org.name}&apos;s data</strong>
      </p>
      <p className="notice">
        This deletes every customer, site, contract, inspection, report, invoice, user and file of this company, and signs its people out. It cannot be undone. Only do this when the
        company has asked, and ask its owner to download an export first (Settings, Export).
      </p>
      <p className="muted small" style={{ margin: 0 }}>
        The company stays in this list, marked as deleted, and the platform audit log keeps a record of the deletion.
      </p>
      <label>
        <span>
          Type <strong>{org.name}</strong> to confirm
        </span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </label>
      <label>
        <span>Your password</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </label>
      <FormError error={erase.error} />
      <div className="row">
        <SubmitButton className="danger" busy={erase.busy} busyLabel="Deleting…" disabled={typed.trim() !== org.name.trim() || password.length === 0}>
          Delete all data
        </SubmitButton>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function AdminOrganizationsPage() {
  const organizations = useLoad<{
    items: AdminOrganization[];
    defaults: SubscriptionConfig;
  }>("/admin/organizations");
  const { data, reload } = organizations;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [invitingFor, setInvitingFor] = useState<AdminOrganization | null>(
    null,
  );
  const [supportFor, setSupportFor] = useState<AdminOrganization | null>(null);

  // Opens the company as its owner sees it, read-only, then goes there.
  const support = useSubmit(
    async (v: Record<string, string | undefined>) => {
      if (!supportFor) return;
      await api(`/admin/organizations/${supportFor.id}/support`, {
        method: "POST",
        body: { reason: v.reason },
      });
      window.location.assign("/inbox");
    },
    { fallback: "Could not open the company." },
  );
  const [sent, setSent] = useState<{
    org: string;
    result: InvitationSent;
  } | null>(null);
  const [erasing, setErasing] = useState<AdminOrganization | null>(null);

  const invite = useSubmit(
    async (v: Record<string, string | undefined>) => {
      if (!invitingFor) return;
      const result = await api<InvitationSent>(
        `/admin/organizations/${invitingFor.id}/invitations`,
        {
          method: "POST",
          body: { email: v.email, name: v.name },
        },
      );
      setSent({ org: invitingFor.name, result });
      setInvitingFor(null);
    },
    { fallback: "Could not send the invitation." },
  );

  const create = useSubmit(
    async (v: Record<string, string | undefined>) => {
      const org = await api<AdminOrganization>("/admin/organizations", {
        method: "POST",
        body: {
          name: v.name,
          email: v.email,
          phone: v.phone,
          timezone: v.timezone,
          plan: v.plan,
        },
      });
      setCreating(false);
      setNotice(`Created ${org.name}.`);
      await reload();
    },
    { fallback: "Could not create the organization." },
  );

  const editingOrg = data?.items.find((o) => o.id === editing);

  return (
    <div className="stack">
      <div className="row">
        <h1>Organizations</h1>
        <span className="spacer" />
        <button onClick={() => setCreating((c) => !c)}>
          {creating ? "Cancel" : "New organization"}
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}

      {sent && (
        <div className="card stack" role="status">
          <p style={{ margin: 0 }}>
            {!sent.result.emailed
              ? `The email to ${sent.result.invitation.email} could not be sent.`
              : sent.result.delivery === "outbox"
                ? `Owner invitation for ${sent.org} recorded in the test outbox for ${sent.result.invitation.email}; no email was delivered.`
                : `Owner invitation for ${sent.org} emailed to ${sent.result.invitation.email}.`}{" "}
            The link below works once, for 7 days.
          </p>
          <input
            readOnly
            value={sent.result.url}
            aria-label="Invitation link"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}

      {invitingFor && (
        <form className="card grid" onSubmit={invite.form}>
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
          <FormError error={invite.error} className="wide" />
          <div className="wide row">
            <SubmitButton busy={invite.busy} busyLabel="Sending…">
              Send owner invitation
            </SubmitButton>
            <button
              type="button"
              className="link"
              onClick={() => setInvitingFor(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {supportFor && (
        <form className="card grid" onSubmit={support.form}>
          <p className="wide">
            View <strong>{supportFor.name}</strong> as its owner sees it, for
            up to an hour. Nothing can be changed, and the company&apos;s
            audit log records the visit and your reason.
          </p>
          <label className="wide">
            Reason
            <input
              name="reason"
              required
              minLength={3}
              placeholder="Owner asked why a filing is late"
            />
          </label>
          <FormError error={support.error} className="wide" />
          <div className="wide row">
            <SubmitButton busy={support.busy} busyLabel="Opening…">
              Open read-only
            </SubmitButton>
            <button
              type="button"
              className="link"
              onClick={() => setSupportFor(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {creating && data && (
        <form className="card grid" onSubmit={create.form}>
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
              <option value="trial">
                Free trial ({data.defaults.trialDays} days)
              </option>
              <option value="design_partner">
                Design partner ({data.defaults.designPartnerDays} days)
              </option>
            </select>
          </label>
          <FormError error={create.error} className="wide" />
          <div className="wide">
            <SubmitButton busy={create.busy}>Create organization</SubmitButton>
          </div>
        </form>
      )}

      {erasing && (
        <EraseForm
          key={erasing.id}
          org={erasing}
          onCancel={() => setErasing(null)}
          onDone={async (result) => {
            setErasing(null);
            const records = Object.values(result.tables).reduce((n, c) => n + c, 0);
            setNotice(
              `Deleted the data of ${result.organization.name}: ${records} records, ${result.users.deleted + result.users.anonymized} users` +
                (result.files === null ? ". Its files could not be deleted; see the platform audit log." : ` and ${result.files} files.`),
            );
            await reload();
          }}
        />
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

      <LoadState load={organizations} label="organizations" quiet />
      {/* The table scrolls on its own on a phone, so the page (and the plan form) stays screen-wide. */}
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
                  {o.dataDeletedAt ? (
                    <Badge tone="muted">Data deleted {when(o.dataDeletedAt)}</Badge>
                  ) : (
                    <>
                      <button
                        className="link small"
                        onClick={() => setEditing(o.id)}
                        aria-label={`Edit plan for ${o.name}`}
                      >
                        Edit plan
                      </button>{" "}
                      <button
                        className="link small danger"
                        onClick={() => {
                          setErasing(o);
                          setNotice(null);
                        }}
                        aria-label={`Delete the data of ${o.name}`}
                      >
                        Delete data
                      </button>
                    </>
                  )}
                </td>
                <td>{o.activeContracts}</td>
                <td>{o.users}</td>
                <td>{when(o.lastActivityAt)}</td>
                <td>{when(o.createdAt)}</td>
                <td>
                  {!o.dataDeletedAt && (
                    <>
                      <button
                        className="link"
                        onClick={() => {
                          setInvitingFor(o);
                          setSent(null);
                        }}
                      >
                        Invite owner
                      </button>
                      {o.users > 0 && (
                        <>
                          {" "}
                          <button
                            className="link"
                            onClick={() => {
                              setSupportFor(o);
                              support.clear();
                            }}
                            aria-label={`View ${o.name} read-only`}
                          >
                            View read-only
                          </button>
                    </>
                  )}
                    </>
                  )}
                </td>
                <td>{planSummary(o)}</td>
                <td>
                  {priceSummary(o, data.defaults)}
                  {o.platformFeeBps > 0 &&
                    `; ${feePercent(o.platformFeeBps)} fee on payments`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && data.items.length === 0 && (
        <p className="muted">No organizations yet.</p>
      )}
    </div>
  );
}
