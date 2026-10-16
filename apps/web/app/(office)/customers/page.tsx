"use client";

import type { Customer, CustomerListItem } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { LoadState } from "@/components/LoadState";
import { StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, mayHaveSaved } from "@/lib/api";
import { canEdit, useSession } from "@/lib/session";
import { EmptyState } from "@/components/EmptyState";

const PAGE = 50;

export default function CustomersPage() {
  const me = useSession();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(search ? { search } : {}) });
  const load = useLoad<{ items: CustomerListItem[]; total: number }>(`/customers?${query}`);

  const { data } = load;
  // One save id per new customer: a retry after a lost answer finds the customer the first try made.
  const creationId = useRef<string | null>(null);
  // Whether the last failure could have saved anyway (no answer, or a server error), so the customer may exist.
  const [unsure, setUnsure] = useState(false);

  // Creates the customer, their primary contact and first service site in one step.
  const create = useSubmit(
    async (v: Record<string, string | undefined>) => {
      setUnsure(false);
      creationId.current ??= crypto.randomUUID();
      try {
        const customer = await api<Customer>("/customers/create-with-site", {
          method: "POST",
          body: {
            creationId: creationId.current,
            customer: { displayName: v.displayName, billingLine1: v.addressLine1, billingCity: v.city, billingState: "TX", billingPostalCode: v.postalCode },
            ...(v.phone || v.email ? { contact: { name: v.displayName, phone: v.phone, email: v.email, type: "primary" } } : {}),
            ...(v.addressLine1 || v.city ? { site: { addressLine1: v.addressLine1, city: v.city, postalCode: v.postalCode, permitNumber: v.permitNumber } } : {}),
          },
        });
        router.push(`/customers/${customer.id}`);
      } catch (err) {
        setUnsure(mayHaveSaved(err));
        throw err;
      }
    },
    { fallback: "Could not confirm the save.", labels: { billingPostalCode: "ZIP", postalCode: "ZIP", displayName: "Name", addressLine1: "Service address" } },
  );

  return (
    <div className="stack">
      <div className="row">
        <h1>Customers</h1>
        <span className="spacer" />
        {canEdit(me) && <button onClick={() => setCreating((c) => !c)}>{creating ? "Cancel" : "New customer"}</button>}
      </div>

      {creating && (
        <form className="card grid" onSubmit={create.form}>
          <label className="wide">
            Name
            <input name="displayName" required />
          </label>
          <label>
            Phone
            <input name="phone" type="tel" />
          </label>
          <label>
            Email
            <input name="email" type="email" />
          </label>
          <label className="wide">
            Service address
            <input name="addressLine1" />
          </label>
          <label>
            City
            <input name="city" />
          </label>
          <label>
            ZIP
            <input name="postalCode" inputMode="numeric" aria-invalid={create.fieldError("/customer/billingPostalCode") || create.fieldError("/site/postalCode") ? true : undefined} />
          </label>
          <label>
            Permit number
            <input name="permitNumber" />
          </label>
          {create.error && (
            <div className="wide">
              <FormError error={create.error} />
              {/* Only when the save may have gone through: a refused form made nothing to review. */}
              {unsure && creationId.current && (
                <p className="small">
                  Try again: the same save never makes a second customer. Or <Link href={`/customers/${creationId.current}`}>check whether it was saved</Link>.
                </p>
              )}
            </div>
          )}
          <div className="wide">
            <SubmitButton busy={create.busy} busyLabel="Saving customer…">
              Create customer
            </SubmitButton>
          </div>
        </form>
      )}

      <input
        type="search"
        aria-label="Search customers"
        placeholder="Search by name, address or permit number"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOffset(0);
        }}
      />

      <LoadState load={load} label="customers" />
      {data && data.items.length > 0 && (
        <table className="stack">
          <thead>
            <tr>
              <th>Name</th>
              <th>Billing city</th>
              <th className="num">Sites</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((c) => (
              <tr key={c.id}>
                <td data-label="Name">
                  <Link href={`/customers/${c.id}`}>{c.displayName}</Link>
                </td>
                <td data-label="Billing city">{c.billingCity ?? "—"}</td>
                <td data-label="Sites" className="num">
                  {c.siteCount}
                </td>
                <td data-label="Status">
                  <StatusBadge of="customer" value={c.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.total === 0 && !search && (
        <EmptyState title="No customers yet">
          Customers are the homeowners and businesses you serve, each with one or more sites. Add one with New customer, or bring your list in from a{" "}
          <Link href="/import">spreadsheet</Link>.
        </EmptyState>
      )}
      {data && data.total === 0 && search && <p className="muted">No customers match “{search}”.</p>}
      {data && data.total > 0 && (
        <div className="row muted">
          {`${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total}`}
          <span className="spacer" />
          <button className="secondary" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>
            Previous
          </button>
          <button className="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
