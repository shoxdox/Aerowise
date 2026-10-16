"use client";

import type { OrganizationSettings } from "@aerowise/domain";
import Link from "next/link";
import { useState, type ChangeEvent } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { LoadState } from "@/components/LoadState";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, ApiError } from "@/lib/api";
import { mpNumber } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

export default function CompanySettingsPage() {
  const me = useSession();
  // Only the owner edits, and nobody does while the plan is read-only or support is looking.
  const owner = me.role === "owner" && canEdit(me);
  const settings = useLoad<OrganizationSettings>("/organization/settings");
  const { data, reload } = settings;
  const [saved, setSaved] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0);

  const saving = useSubmit(
    async (v: Record<string, string | undefined>) => {
      setSaved(false);
      await api("/organization/settings", {
        method: "PATCH",
        body: {
          name: v.name ?? "",
          phone: v.phone ?? "",
          emergencyPhone: v.emergencyPhone ?? "",
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
    },
    { fallback: "Could not save the company details.", labels: { postalCode: "ZIP", emergencyPhone: "Emergency phone" } },
  );
  // The logo goes up as the file itself, not JSON, so it is sent with fetch.
  const logo = useSubmit(
    async (file: File) => {
      const res = await fetch("/api/organization/logo", { method: "PUT", headers: { "content-type": file.type }, body: file, credentials: "same-origin" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error ?? "error", res.status === 413 ? "The logo must be 1 MB or smaller." : (body.message ?? "Could not upload the logo."));
      }
      setLogoVersion((n) => n + 1);
      await reload();
    },
    { fallback: "Could not upload the logo." },
  );
  const removing = useSubmit(
    async () => {
      await api("/organization/logo/remove", { method: "POST", body: {} });
      await reload();
    },
    { fallback: "Could not remove the logo." },
  );

  function onLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file) void logo.run(file);
  }

  if (!data) return <LoadState load={settings} label="company details" />;
  return (
    <div className="stack">
      <h1>Company</h1>
      <p className="muted">Shown to your customers and on the reports you send the authorities.{!owner && " Only an owner can change these."}</p>

      <form className="card grid" onSubmit={saving.form} key={JSON.stringify(data)}>
        <label className="wide">
          Company name
          <input name="name" defaultValue={data.name} required disabled={!owner} />
        </label>
        <label>
          Phone
          <input name="phone" type="tel" defaultValue={data.phone ?? ""} disabled={!owner} />
        </label>
        <label>
          Emergency phone
          <input name="emergencyPhone" type="tel" defaultValue={data.emergencyPhone ?? ""} disabled={!owner} />
          <span className="muted small">Printed on reports to authorities that require one (Travis County, SJRA).</span>
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
        <label className="wide check">
          <input type="checkbox" name="billFilingFees" defaultChecked={data.billFilingFees} disabled={!owner} />
          Add the county&apos;s filing fees to the homeowner&apos;s contract invoices
        </label>
        <p className="wide muted small">
          Off by default. When on, each new contract invoice also bills the filing fees the county charged for that site&apos;s reports, each once. Late fees are never passed on.
        </p>
        <FormError error={saving.error} className="wide" />
        {saved && <p className="wide" role="status">Saved.</p>}
        {owner && (
          <div className="wide">
            <SubmitButton busy={saving.busy}>Save</SubmitButton>
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
              <input type="file" accept="image/png,image/jpeg" onChange={onLogo} disabled={logo.busy} aria-label="Logo file" style={{ display: "block" }} />
            </label>
            {logo.busy && <span className="muted small">Uploading…</span>}
            {data.hasLogo && (
              <ConfirmButton className="link danger" question="Remove the logo from new reports?" confirmLabel="Remove logo" busy={removing.busy} onConfirm={() => removing.run()}>
                Remove logo
              </ConfirmButton>
            )}
          </div>
        )}
        <FormError error={logo.error ?? removing.error} />
      </section>

      <section className="card stack">
        <h2>TCEQ maintenance provider license</h2>
        {data.responsibleProvider ? (
          <p style={{ margin: 0 }}>
            Reports are filed under <strong>{data.responsibleProvider.holderName}</strong>, {mpNumber(data.responsibleProvider.number)}.
          </p>
        ) : (
          <p style={{ margin: 0 }}>No responsible MP is chosen yet. Reports to the authorities need one.</p>
        )}
        <Link href="/settings/credentials">Licenses and registrations</Link>
      </section>
    </div>
  );
}
