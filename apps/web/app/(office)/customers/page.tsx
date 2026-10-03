"use client";

import type { Customer, CustomerListItem } from "@aerowise/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { canEdit, useSession } from "@/lib/session";

const PAGE = 50;

export default function CustomersPage() {
  const me = useSession();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = new URLSearchParams({ limit: String(PAGE), offset: String(offset), ...(search ? { search } : {}) });
  const { data } = useLoad<{ items: CustomerListItem[]; total: number }>(`/customers?${query}`);

  // Creates the customer, their primary contact and first service site in one step.
  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const v = formValues(event.currentTarget);
    try {
      const customer = await api<Customer>("/customers", {
        method: "POST",
        body: {
          displayName: v.displayName,
          billingLine1: v.addressLine1,
          billingCity: v.city,
          billingState: "TX",
          billingPostalCode: v.postalCode,
        },
      });
      if (v.phone || v.email) {
        await api(`/customers/${customer.id}/contacts`, {
          method: "POST",
          body: { name: v.displayName, phone: v.phone, email: v.email, type: "primary" },
        });
      }
      if (v.addressLine1 && v.city) {
        await api(`/customers/${customer.id}/sites`, {
          method: "POST",
          body: { addressLine1: v.addressLine1, city: v.city, postalCode: v.postalCode, permitNumber: v.permitNumber },
        });
      }
      router.push(`/customers/${customer.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create customer");
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <h1>Customers</h1>
        <span className="spacer" />
        {canEdit(me) && <button onClick={() => setCreating((c) => !c)}>{creating ? "Cancel" : "New customer"}</button>}
      </div>

      {creating && (
        <form className="card grid" onSubmit={onCreate}>
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
            <input name="postalCode" inputMode="numeric" />
          </label>
          <label>
            Permit number
            <input name="permitNumber" />
          </label>
          {error && <p className="error wide">{error}</p>}
          <div className="wide">
            <button type="submit">Create customer</button>
          </div>
        </form>
      )}

      <input
        type="search"
        placeholder="Search by name, address or permit number"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOffset(0);
        }}
      />

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Billing city</th>
            <th>Sites</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`/customers/${c.id}`}>{c.displayName}</Link>
              </td>
              <td>{c.billingCity ?? "—"}</td>
              <td>{c.siteCount}</td>
              <td>
                <span className={`badge ${c.status}`}>{c.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && (
        <div className="row muted">
          {data.total === 0 ? "No customers found" : `${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total}`}
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
