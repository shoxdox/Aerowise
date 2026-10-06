"use client";

import type { OrganizationSettings } from "@aerowise/domain";
import Link from "next/link";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { canEdit, useSession } from "@/lib/session";

export default function CompanySettingsPage() {
  const me = useSession();
  // Only the owner edits, and nobody does while the plan is read-only or support is looking.
  const owner = me.role === "owner" && canEdit(me);
  const { data, reload } = useLoad<OrganizationSettings>("/organization/settings");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const v = formValues(event.currentTarget);
    try {
      await api("/organization/settings", {
        method: "PATCH",
        body: {
          name: v.name ?? "",
          phone: v.phone ?? "",
          email: v.email ?? "",
          addressLine1: v.addressLine1 ?? "",
          addressLine2: v.addressLine2 ?? "",
          city: v.city ?? "",
          state: v.state ?? "",
          postalCode: v.postalCode ?? "",
          serviceCounties: (v.serviceCounties ?? "").split(/[\n,]/).map((c) => c.trim()).filter(Boolean),
          billFilingFees: v.billFilingFees === "on",
        },
      });
      setSaved(true);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function onLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError(null);
    const res = await fetch("/api/organization/logo", { method: "PUT", headers: { "content-type": file.type }, body: file, credentials: "same-origin" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(res.status === 413 ? "The logo must be 1 MB or smaller" : (body.message ?? "Could not upload the logo"));
      return;
    }
    setLogoVersion((n) => n + 1);
    await reload();
  }

  async function removeLogo() {
    await api("/organization/logo/remove", { method: "POST", body: {} });
    await reload();
  }

  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <h1>Company</h1>
      <p className="muted">Shown to your customers and on the reports you send the authorities.{!owner && " Only an owner can change these."}</p>

      <form className="card grid" onSubmit={onSave} key={JSON.stringify(data)}>
        <label className="wide">
          Company name
          <input name="name" defaultValue={data.name} required disabled={!owner} />
        </label>
        <label>
          Phone
          <input name="phone" type="tel" defaultValue={data.phone ?? ""} disabled={!owner} />
        </label>
        <label>
          Email
          <input name="email" type="email" defaultValue={data.email ?? ""} disabled={!owner} />
        </label>
        <label className="wide">
          Address
          <input name="addressLine1" defaultValue={data.addressLine1 ?? ""} disabled={!owner} />
        </label>
        <label className="wide">
          Address line 2
          <input name="addressLine2" defaultValue={data.addressLine2 ?? ""} disabled={!owner} />
        </label>
        <label>
          City
          <input name="city" defaultValue={data.city ?? ""} disabled={!owner} />
        </label>
        <label>
          State
          <input name="state" defaultValue={data.state ?? ""} disabled={!owner} />
        </label>
        <label>
          ZIP
          <input name="postalCode" defaultValue={data.postalCode ?? ""} disabled={!owner} />
        </label>
        <label className="wide">
          Service counties
          <textarea name="serviceCounties" rows={3} defaultValue={data.serviceCounties.join("\n")} disabled={!owner} placeholder={"Travis County\nHays County"} />
          <span className="muted small">One per line. These are the counties you work in.</span>
        </label>
        <label className="wide row">
          <input type="checkbox" name="billFilingFees" defaultChecked={data.billFilingFees} disabled={!owner} />
          Add the county&apos;s filing fees to the homeowner&apos;s contract invoices
        </label>
        <p className="wide muted small">
          Off by default. When on, each new contract invoice also bills the filing fees the county charged for that site&apos;s reports, each once. Late fees are never passed on.
        </p>
        {error && <p className="error wide">{error}</p>}
        {saved && <p className="wide" role="status">Saved.</p>}
        {owner && (
          <div className="wide">
            <button type="submit">Save</button>
          </div>
        )}
      </form>

      <section className="card stack">
        <h2>Logo</h2>
        <p className="muted small">PNG or JPEG, up to 1 MB. It goes at the top of new inspection reports; reports already made keep the logo they had.</p>
        {data.hasLogo ? (
          <img src={`/api/organization/logo?v=${logoVersion}`} alt="Company logo" style={{ maxHeight: 64, maxWidth: 240, alignSelf: "flex-start" }} />
        ) : (
          <p className="muted">No logo yet.</p>
        )}
        {owner && (
          <div className="row">
            <label>
              {data.hasLogo ? "Replace logo" : "Upload logo"}
              <input type="file" accept="image/png,image/jpeg" onChange={onLogo} aria-label="Logo file" style={{ display: "block" }} />
            </label>
            {data.hasLogo && (
              <button className="link" onClick={removeLogo}>
                Remove logo
              </button>
            )}
          </div>
        )}
      </section>

      <section className="card stack">
        <h2>TCEQ maintenance provider license</h2>
        {data.responsibleProvider ? (
          <p style={{ margin: 0 }}>
            Reports are filed under <strong>{data.responsibleProvider.holderName}</strong>, MP {data.responsibleProvider.number}.
          </p>
        ) : (
          <p style={{ margin: 0 }}>No responsible MP is chosen yet. Reports to the authorities need one.</p>
        )}
        <Link href="/settings/credentials">Licenses and registrations</Link>
      </section>
    </div>
  );
}
