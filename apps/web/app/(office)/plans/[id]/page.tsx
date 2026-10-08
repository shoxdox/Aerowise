"use client";

import { COVERAGE_EFFECTS, WORK_CATEGORIES, WORK_CATEGORY_LABELS, type CoverageEffect, type PlanDetail, type ServiceItem, type WorkCategory } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { day, money } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";

// The plan builder (SW-8): a plan's own agreement terms, the options offered with it at
// signing, and its coverage rules. Saving makes the next version; earlier versions, and the
// contracts made from them, never change.

type Tab = "terms" | "options" | "coverage" | "versions" | "preview";
const TABS: [Tab, string][] = [
  ["terms", "Terms"],
  ["options", "Options"],
  ["coverage", "Coverage"],
  ["versions", "Versions"],
  ["preview", "Preview agreement"],
];
const EFFECT_LABELS: Record<CoverageEffect, string> = { included: "No charge", percent_off: "Percent off", excluded: "Never covered" };

interface OptionRow {
  optionKey: string;
  name: string;
  price: string;
  taxable: boolean;
  required: boolean;
  default: boolean;
}
interface RuleRow {
  ruleKey: string;
  label: string;
  matchKind: "category" | "item";
  category: WorkCategory;
  serviceItemId: string;
  effect: CoverageEffect;
  percentOff: string;
  limit: string;
}

export default function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const builder = useFeature("plan_builder") && canEdit(useSession());
  const { data: plan, error, reload } = useLoad<PlanDetail>(`/plans/${id}`);
  const items = useLoad<{ items: ServiceItem[] }>(builder ? "/service-items?active=all" : null);
  const [tab, setTab] = useState<Tab>("terms");
  const [ownTerms, setOwnTerms] = useState(false);
  const [terms, setTerms] = useState("");
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // The form starts from the current version.
  const current = plan?.versions[0];
  useEffect(() => {
    if (!current) return;
    setOwnTerms(current.termsText !== null);
    setTerms(current.termsText ?? plan!.preview.terms);
    setOptions(current.options.map((o) => ({ optionKey: o.optionKey, name: o.name, price: (o.priceCents / 100).toFixed(2), taxable: o.taxable, required: o.required, default: o.default })));
    setRules(
      current.coverage.map((r) => ({
        ruleKey: r.ruleKey,
        label: r.label,
        matchKind: "category" in r.match ? "category" : "item",
        category: "category" in r.match ? r.match.category : "repair",
        serviceItemId: "serviceItemId" in r.match ? r.match.serviceItemId : "",
        effect: r.effect,
        percentOff: r.percentOff?.toString() ?? "",
        limit: r.limit?.count.toString() ?? "",
      })),
    );
  }, [current?.id]);

  async function save() {
    setProblem(null);
    setSaved(null);
    try {
      const next = await api<PlanDetail>(`/plans/${id}/versions`, {
        method: "POST",
        body: {
          termsText: ownTerms ? terms : null,
          options: options.map((o) => ({ optionKey: o.optionKey, name: o.name, priceCents: Math.round(Number(o.price) * 100), taxable: o.taxable, required: o.required, default: o.required || o.default })),
          coverage: rules.map((r) => ({
            ruleKey: r.ruleKey,
            label: r.label,
            match: r.matchKind === "category" ? { category: r.category } : { serviceItemId: r.serviceItemId },
            effect: r.effect,
            percentOff: r.effect === "percent_off" ? Number(r.percentOff) : null,
            limit: r.effect !== "excluded" && r.limit ? { count: Number(r.limit), per: "term" } : null,
          })),
        },
      });
      setSaved(`Saved as version ${next.version}. New contracts and renewal offers take it from now on; existing contracts keep theirs.`);
      await reload();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!plan || !current) return <p className="muted">Loading…</p>;
  const setOption = (i: number, patch: Partial<OptionRow>) => setOptions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setRule = (i: number, patch: Partial<RuleRow>) => setRules((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="stack">
      <p>
        <Link href="/plans">← Plans</Link>
      </p>
      <div className="row">
        <h1>{plan.name}</h1>
        <span className="muted">
          version {plan.version} · {plan.termMonths} months · {plan.visitsPerTerm} visits · {money(plan.priceCents)} billed {plan.billingFrequency}
        </span>
      </div>
      <p className="muted">
        Basic, Gold or Platinum are only names: a plan covers exactly what its coverage rules say, and nothing when it has none. Each save is a new version; contracts keep the version they were made
        with.
      </p>
      <div className="row" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "" : "secondary"} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "terms" && (
        <section className="stack">
          <label className="row">
            <input type="checkbox" checked={ownTerms} disabled={!builder} onChange={(e) => setOwnTerms(e.target.checked)} />
            This plan has its own agreement terms
          </label>
          {ownTerms ? (
            <textarea rows={14} value={terms} disabled={!builder} onChange={(e) => setTerms(e.target.value)} aria-label="Agreement terms" />
          ) : (
            <p className="muted">
              Customers sign your company&apos;s agreement terms (Settings → Renewals). <span className="small">Have real terms reviewed before customers sign them.</span>
            </p>
          )}
        </section>
      )}

      {tab === "options" && (
        <section className="stack">
          <p className="muted">Offered when the customer signs a renewal online, and billed once with the first payment, like an add-on.</p>
          {options.length === 0 && <p className="muted">No options.</p>}
          {options.map((o, i) => (
            <div key={i} className="card grid" data-testid="plan-option">
              <label>
                Name
                <input value={o.name} disabled={!builder} onChange={(e) => setOption(i, { name: e.target.value })} />
              </label>
              <label>
                Price ($)
                <input type="number" min={0} step="0.01" value={o.price} disabled={!builder} onChange={(e) => setOption(i, { price: e.target.value })} />
              </label>
              <label className="row">
                <input type="checkbox" checked={o.taxable} disabled={!builder} onChange={(e) => setOption(i, { taxable: e.target.checked })} /> Taxable
              </label>
              <label className="row">
                <input type="checkbox" checked={o.required} disabled={!builder} onChange={(e) => setOption(i, { required: e.target.checked })} /> Always included
              </label>
              <label className="row">
                <input type="checkbox" checked={o.required || o.default} disabled={!builder || o.required} onChange={(e) => setOption(i, { default: e.target.checked })} /> Ticked to start
              </label>
              {builder && (
                <button className="link" onClick={() => setOptions((rows) => rows.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {builder && (
            <p>
              <button
                className="secondary"
                onClick={() => setOptions((rows) => [...rows, { optionKey: `option-${Date.now().toString(36)}`, name: "", price: "0.00", taxable: false, required: false, default: false }])}
              >
                Add option
              </button>
            </p>
          )}
        </section>
      )}

      {tab === "coverage" && (
        <section className="stack">
          <p className="muted">
            Coverage applies to work orders at a site under contract. The first rule that fits a line decides it. A limit counts work orders per contract term; a renewal starts fresh.
          </p>
          {rules.length === 0 && <p className="muted">No coverage rules: this plan covers nothing.</p>}
          {rules.map((r, i) => (
            <div key={i} className="card grid" data-testid="coverage-rule">
              <label>
                Name
                <input value={r.label} disabled={!builder} onChange={(e) => setRule(i, { label: e.target.value })} />
              </label>
              <label>
                Applies to
                <select value={r.matchKind} disabled={!builder} onChange={(e) => setRule(i, { matchKind: e.target.value as RuleRow["matchKind"] })}>
                  <option value="category">A kind of work</option>
                  <option value="item">One catalog item</option>
                </select>
              </label>
              {r.matchKind === "category" ? (
                <label>
                  Kind of work
                  <select value={r.category} disabled={!builder} onChange={(e) => setRule(i, { category: e.target.value as WorkCategory })}>
                    {WORK_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {WORK_CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label>
                  Catalog item
                  <select value={r.serviceItemId} disabled={!builder} onChange={(e) => setRule(i, { serviceItemId: e.target.value })}>
                    <option value="">Choose</option>
                    {items.data?.items.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Effect
                <select value={r.effect} disabled={!builder} onChange={(e) => setRule(i, { effect: e.target.value as CoverageEffect })}>
                  {COVERAGE_EFFECTS.map((e) => (
                    <option key={e} value={e}>
                      {EFFECT_LABELS[e]}
                    </option>
                  ))}
                </select>
              </label>
              {r.effect === "percent_off" && (
                <label>
                  Percent off
                  <input type="number" min={1} max={99} value={r.percentOff} disabled={!builder} onChange={(e) => setRule(i, { percentOff: e.target.value })} />
                </label>
              )}
              {r.effect !== "excluded" && (
                <label>
                  Work orders per term (blank: no limit)
                  <input type="number" min={1} max={1000} value={r.limit} disabled={!builder} onChange={(e) => setRule(i, { limit: e.target.value })} />
                </label>
              )}
              {builder && (
                <button className="link" onClick={() => setRules((rows) => rows.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {builder && (
            <p>
              <button
                className="secondary"
                onClick={() =>
                  setRules((rows) => [
                    ...rows,
                    { ruleKey: `rule-${Date.now().toString(36)}`, label: "", matchKind: "category", category: "repair", serviceItemId: "", effect: "included", percentOff: "", limit: "" },
                  ])
                }
              >
                Add rule
              </button>
            </p>
          )}
        </section>
      )}

      {tab === "versions" && (
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Made</th>
              <th>Price</th>
              <th>Terms</th>
              <th>Options</th>
              <th>Coverage rules</th>
              <th>Used by</th>
            </tr>
          </thead>
          <tbody>
            {plan.versions.map((v) => (
              <tr key={v.id}>
                <td>{v.version}</td>
                <td>{day(v.createdAt.slice(0, 10))}</td>
                <td>{money(v.priceCents)}</td>
                <td>{v.termsText ? "Its own" : "Company's"}</td>
                <td>{v.options.length}</td>
                <td>{v.coverage.length}</td>
                <td>
                  {v.contracts} contract{v.contracts === 1 ? "" : "s"}, {v.renewals} renewal{v.renewals === 1 ? "" : "s"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "preview" && (
        <section className="stack card" data-testid="agreement-preview">
          <p className="muted small">What a customer signs under version {plan.version} (saved changes only).</p>
          {plan.preview.options.length > 0 && (
            <>
              <h3>Options</h3>
              <ul className="plain">
                {plan.preview.options.map((o) => (
                  <li key={o.optionKey}>
                    {o.name} · {money(o.priceCents)}
                    {o.required ? " (always included)" : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Coverage</h3>
          {plan.preview.coverage.length ? (
            <ul className="plain">
              {plan.preview.coverage.map((c) => (
                <li key={c.ruleKey}>{c.summary}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No coverage rules.</p>
          )}
          <h3>Terms {plan.preview.termsSource === "organization" && <span className="muted small">(your company&apos;s)</span>}</h3>
          <div style={{ whiteSpace: "pre-wrap" }}>{plan.preview.terms}</div>
        </section>
      )}

      {builder && tab !== "versions" && tab !== "preview" && (
        <div className="row">
          <button onClick={() => void save()}>Save as version {plan.version + 1}</button>
          {saved && <span className="muted">{saved}</span>}
        </div>
      )}
      {problem && <p className="error">{problem}</p>}
    </div>
  );
}
