"use client";

import type { WorkType } from "@aerowise/domain";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { blankLine, EstimateLineEditor, toInput, type DraftLine } from "@/components/EstimateLineEditor";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { api, Refusal } from "@/lib/api";
import { useFeature } from "@/lib/features";

interface SiteOption {
  id: string;
  addressLine1: string;
  city: string;
  customerName: string;
}

function NewEstimate() {
  const router = useRouter();
  const params = useSearchParams();
  const fixedSite = params.get("siteId");
  const [search, setSearch] = useState("");
  const types = useLoad<{ items: WorkType[] }>("/work-types");
  const list = useLoad<{ items: SiteOption[] }>(fixedSite ? null : `/sites?limit=50${search ? `&search=${encodeURIComponent(search)}` : ""}`);
  const one = useLoad<{ id: string; addressLine1: string; city: string; customer: { displayName: string } }>(fixedSite ? `/sites/${fixedSite}` : null);
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine()]);
  const deposits = useFeature("deposits");
  const siteOptions: SiteOption[] = fixedSite
    ? one.data
      ? [{ id: one.data.id, addressLine1: one.data.addressLine1, city: one.data.city, customerName: one.data.customer.displayName }]
      : []
    : (list.data?.items ?? []);

  const create = useSubmit(
    async (v: Record<string, string | undefined>) => {
      const parsed = toInput(lines);
      if ("error" in parsed) throw new Refusal(parsed.error);
      const e = await api<{ id: string }>("/estimates", {
        method: "POST",
        body: {
          siteId: v.siteId,
          workTypeId: v.workTypeId || null,
          title: v.title || undefined,
          lines: parsed.lines,
          discountCents: v.discount ? Math.round(Number(v.discount) * 100) : 0,
          expiresOn: v.expiresOn || null,
          ...(deposits && Number(v.deposit) > 0 ? { depositCents: Math.round(Number(v.deposit) * 100) } : {}),
        },
      });
      router.push(`/estimates/${e.id}`);
    },
    { fallback: "Could not create the estimate.", leaves: true },
  );

  return (
    <form className="stack" onSubmit={create.form}>
      <p>
        <Link href="/estimates">← Estimates</Link>
      </p>
      <h1>New estimate</h1>
      {!fixedSite && (
        <label>
          Find a site
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Address, city or permit number" />
        </label>
      )}
      <label>
        Site
        <select name="siteId" required>
          {siteOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.addressLine1}, {s.city}
              {s.customerName ? ` (${s.customerName})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Kind of work <span className="muted small">(the work order it becomes; repair if left blank)</span>
        <select name="workTypeId" defaultValue="">
          <option value="">Choose later</option>
          {types.data?.items
            .filter((t) => t.active)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        Title <span className="muted small">(&quot;Estimate&quot; plus the kind of work if left blank)</span>
        <input name="title" maxLength={200} />
      </label>
      {/* A fieldset grows to its widest content unless told otherwise; the lines scroll instead. */}
      <fieldset className="stack" style={{ minWidth: 0 }}>
        <legend>Lines</legend>
        <EstimateLineEditor lines={lines} onChange={setLines} />
      </fieldset>
      <div className="row">
        <label>
          Discount ($)
          <input name="discount" type="number" min="0" step="0.01" />
        </label>
        <label>
          Good until
          <input name="expiresOn" type="date" />
        </label>
        {deposits && (
          <label>
            Deposit ($) <span className="muted small">(paid on acceptance; blank for none)</span>
            <input name="deposit" type="number" min="0" step="0.01" />
          </label>
        )}
      </div>
      <p className="muted small">The company&apos;s sales tax rate and estimate terms apply; you can change them on the draft before sending.</p>
      <FormError error={create.error} />
      <div className="row">
        <SubmitButton busy={create.busy}>Save draft</SubmitButton>
        <button type="button" className="secondary" onClick={() => router.back()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export default function NewEstimatePage() {
  return (
    <Suspense>
      <NewEstimate />
    </Suspense>
  );
}
