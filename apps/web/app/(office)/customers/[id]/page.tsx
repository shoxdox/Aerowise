"use client";

import type { CustomerDetail } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { CustomerNextActions } from "@/components/CustomerNextActions";
import { CustomerInvoices } from "@/components/CustomerInvoices";
import { CustomerPortal } from "@/components/CustomerPortal";
import { SafetyBadges } from "@/components/SafetyBadges";
import { LoadState } from "@/components/LoadState";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { canEdit, useSession } from "@/lib/session";

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const me = useSession();
  const editable = canEdit(me);
  const recordLoad = useLoad<CustomerDetail>(`/customers/${id}`);
  const { data: customer, error, reload } = recordLoad;
  const [editing, setEditing] = useState<"customer" | "contact" | "site" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  if (error && !customer) return <LoadState load={recordLoad} label="record" />;
  if (!customer) return <LoadState load={recordLoad} label="record" />;

  const submit = (path: string, method: "POST" | "PATCH", toBody: (v: Record<string, string | undefined>) => object) =>
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setFormError(null);
      try {
        await api(path, { method, body: toBody(formValues(event.currentTarget)) });
        setEditing(null);
        await reload();
      } catch (err) {
        setFormError(err instanceof ApiError ? err.message : "Could not save");
      }
    };

  return (
    <div className="stack">
      <LoadState load={recordLoad} label="record" />
      <p>
        <Link href="/customers">← Customers</Link>
      </p>
      <div className="row">
        <h1>{customer.displayName}</h1>
        <span className={`badge ${customer.status}`}>{customer.status}</span>
        <span className="spacer" />
        {editable && (
          <button className="secondary" onClick={() => setEditing(editing === "customer" ? null : "customer")}>
            Edit
          </button>
        )}
      </div>

      <CustomerNextActions customerId={id} />
      {me.role !== "technician" && <CustomerInvoices customerId={id} editable={editable} />}
      {editing === "customer" ? (
        <form
          className="card grid"
          onSubmit={submit(`/customers/${id}`, "PATCH", (v) => ({
            displayName: v.displayName,
            billingLine1: v.billingLine1 ?? null,
            billingCity: v.billingCity ?? null,
            billingPostalCode: v.billingPostalCode ?? null,
            status: v.status,
            notes: v.notes ?? null,
          }))}
        >
          <label className="wide">
            Name
            <input name="displayName" defaultValue={customer.displayName} required />
          </label>
          <label className="wide">
            Billing address
            <input name="billingLine1" defaultValue={customer.billingLine1 ?? ""} />
          </label>
          <label>
            City
            <input name="billingCity" defaultValue={customer.billingCity ?? ""} />
          </label>
          <label>
            ZIP
            <input name="billingPostalCode" defaultValue={customer.billingPostalCode ?? ""} />
          </label>
          <label>
            Status
            <select name="status" defaultValue={customer.status}>
              <option value="active">Active</option>
              <option value="prospect">Prospect</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
          <label className="wide">
            Notes
            <textarea name="notes" defaultValue={customer.notes ?? ""} rows={3} />
          </label>
          {formError && <p className="error wide">{formError}</p>}
          <div className="wide">
            <button type="submit">Save</button>
          </div>
        </form>
      ) : (
        <div className="card">
          <p>
            {[customer.billingLine1, customer.billingCity, customer.billingState, customer.billingPostalCode].filter(Boolean).join(", ") ||
              "No billing address"}
          </p>
          {customer.notes && <p className="muted">{customer.notes}</p>}
        </div>
      )}

      <section className="stack">
        <div className="row">
          <h2>Service sites</h2>
          <span className="spacer" />
          {editable && (
            <button className="secondary" onClick={() => setEditing(editing === "site" ? null : "site")}>
              Add site
            </button>
          )}
        </div>
        {editing === "site" && (
          <form
            className="card grid"
            onSubmit={submit(`/customers/${id}/sites`, "POST", (v) => ({
              addressLine1: v.addressLine1,
              city: v.city,
              postalCode: v.postalCode,
              county: v.county,
              permitNumber: v.permitNumber,
            }))}
          >
            <label className="wide">
              Address
              <input name="addressLine1" required />
            </label>
            <label>
              City
              <input name="city" required />
            </label>
            <label>
              ZIP
              <input name="postalCode" inputMode="numeric" />
            </label>
            <label>
              County
              <input name="county" />
            </label>
            <label>
              Permit number
              <input name="permitNumber" />
            </label>
            {formError && <p className="error wide">{formError}</p>}
            <div className="wide">
              <button type="submit">Add site</button>
            </div>
          </form>
        )}
        {customer.sites.length === 0 && <p className="muted">No sites yet.</p>}
        {customer.sites.map((s) => (
          <Link key={s.id} href={`/sites/${s.id}`} className="card link-card">
            <strong>
              {s.addressLine1}, {s.city}
            </strong>
            <span className="muted"> Permit {s.permitNumber ?? "not recorded"}</span> <SafetyBadges flags={s.safetyFlags} />
            {!s.active && <span className="badge inactive">inactive</span>}
          </Link>
        ))}
      </section>

      {me.role !== "technician" && <CustomerPortal customerId={id} editable={editable} />}

      <section className="stack">
        <div className="row">
          <h2>Contacts</h2>
          <span className="spacer" />
          {editable && (
            <button className="secondary" onClick={() => setEditing(editing === "contact" ? null : "contact")}>
              Add contact
            </button>
          )}
        </div>
        {editing === "contact" && (
          <form
            className="card grid"
            onSubmit={submit(`/customers/${id}/contacts`, "POST", (v) => ({
              name: v.name,
              phone: v.phone,
              email: v.email,
              type: v.type,
              siteId: v.siteId,
            }))}
          >
            <label className="wide">
              Name
              <input name="name" required />
            </label>
            <label>
              Phone
              <input name="phone" type="tel" />
            </label>
            <label>
              Email
              <input name="email" type="email" />
            </label>
            <label>
              Type
              <select name="type" defaultValue="primary">
                <option value="primary">Primary</option>
                <option value="billing">Billing</option>
                <option value="site">Site</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              For site
              <select name="siteId" defaultValue="">
                <option value="">All sites</option>
                {customer.sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.addressLine1}
                  </option>
                ))}
              </select>
            </label>
            {formError && <p className="error wide">{formError}</p>}
            <div className="wide">
              <button type="submit">Add contact</button>
            </div>
          </form>
        )}
        <table>
          <tbody>
            {customer.contacts.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.type}</td>
                <td>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : "—"}</td>
                <td>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
