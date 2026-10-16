"use client";

import { statusLabel, type CustomerDetail } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { CustomerNextActions } from "@/components/CustomerNextActions";
import { CustomerInvoices } from "@/components/CustomerInvoices";
import { CustomerPortal } from "@/components/CustomerPortal";
import { SafetyBadges } from "@/components/SafetyBadges";
import { LoadState } from "@/components/LoadState";
import { Badge, StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, formValues } from "@/lib/api";
import { phone } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/title";

/** Field names the API may refuse, as the form calls them. */
const FIELDS = { displayName: "Name", billingLine1: "Billing address", billingCity: "City", billingPostalCode: "ZIP", postalCode: "ZIP", addressLine1: "Address", permitNumber: "Permit number" };

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const me = useSession();
  const editable = canEdit(me);
  const recordLoad = useLoad<CustomerDetail>(`/customers/${id}`);
  const { data: customer, reload } = recordLoad;
  const [editing, setEditingState] = useState<"customer" | "contact" | "site" | null>(null);
  // The new contact's own id, chosen when its form opens: a second click or a retry adds it once.
  const contactId = useRef<string | null>(null);
  usePageTitle(customer?.displayName);
  const setEditing = (next: typeof editing) => {
    contactId.current = next === "contact" ? crypto.randomUUID() : null;
    save.clear();
    setEditingState(next);
  };

  const save = useSubmit(
    async (path: string, method: "POST" | "PATCH", body: object) => {
      await api(path, { method, body });
      setEditingState(null);
      await reload();
    },
    { fallback: "Could not save.", labels: FIELDS },
  );
  const submit = (path: string, method: "POST" | "PATCH", toBody: (v: Record<string, string | undefined>) => object) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void save.run(path, method, toBody(formValues(event.currentTarget)));
  };

  if (!customer) return <LoadState load={recordLoad} label="customer" back={{ href: "/customers", label: "Customers" }} />;

  return (
    <div className="stack">
      <LoadState load={recordLoad} label="customer" back={{ href: "/customers", label: "Customers" }} />
      <p>
        <Link href="/customers">← Customers</Link>
      </p>
      <div className="row">
        <h1>{customer.displayName}</h1>
        <StatusBadge of="customer" value={customer.status} />
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
            <input name="billingPostalCode" inputMode="numeric" defaultValue={customer.billingPostalCode ?? ""} aria-invalid={save.fieldError("/billingPostalCode") ? true : undefined} />
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
          <FormError error={save.error} className="wide" />
          <div className="wide">
            <SubmitButton busy={save.busy}>Save</SubmitButton>
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
              <input name="postalCode" inputMode="numeric" aria-invalid={save.fieldError("/postalCode") ? true : undefined} />
            </label>
            <label>
              County
              <input name="county" />
            </label>
            <label>
              Permit number
              <input name="permitNumber" />
            </label>
            <FormError error={save.error} className="wide" />
            <div className="wide">
              <SubmitButton busy={save.busy}>Add site</SubmitButton>
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
            {!s.active && <Badge tone="muted">Inactive</Badge>}
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
              creationId: contactId.current ?? undefined,
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
                <option value="site">At the site</option>
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
            <FormError error={save.error} className="wide" />
            <div className="wide">
              <SubmitButton busy={save.busy}>Add contact</SubmitButton>
            </div>
          </form>
        )}
        {customer.contacts.length > 0 && (
          <table className="stack">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Phone</th>
                <th>Email</th>
              </tr>
            </thead>
            <tbody>
              {customer.contacts.map((c) => (
                <tr key={c.id}>
                  <td data-label="Name">{c.name}</td>
                  <td data-label="Kind">{statusLabel("contact", c.type).label}</td>
                  <td data-label="Phone">{c.phone ? <a href={`tel:${c.phone}`}>{phone(c.phone)}</a> : "—"}</td>
                  <td data-label="Email">{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
