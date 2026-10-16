"use client";

import {
  BILLING_FREQUENCY_LABELS,
  COVERAGE_EFFECTS,
  CYCLE_SERVICE_TYPES,
  SERVICE_TYPE_LABELS,
  WORK_CATEGORIES,
  WORK_CATEGORY_LABELS,
  type CoverageEffect,
  type CycleServiceType,
  type FormTemplate,
  type PlanDetail,
  type ServiceItem,
  type WorkCategory,
  type WorkType,
} from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { LoadState } from "@/components/LoadState";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { useUnsavedChanges } from "@/components/useUnsavedChanges";
import { api } from "@/lib/api";
import { useFeature } from "@/lib/features";
import { dayOf, money, plural } from "@/lib/format";
import { canEdit, useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/title";

// The plan builder (SW-8): a plan's own agreement terms, the options offered with it at
// signing, and its coverage rules. Saving makes the next version; earlier versions, and the
// contracts made from them, never change.

type Tab = "terms" | "service" | "options" | "coverage" | "intake" | "versions" | "preview";
const TABS: [Tab, string][] = [
  ["terms", "Terms"],
  ["service", "Service"],
  ["options", "Options"],
  ["coverage", "Coverage"],
  ["intake", "Intake questions"],
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
/** A pumping or maintenance cycle (SW-9), with its numbers as typed. */
interface CycleRow {
  cycleKey: string;
  label: string;
  serviceType: CycleServiceType;
  workTypeId: string;
  everyMonths: string;
  windowDays: string;
  allowNoVisit: boolean;
}
interface QuestionRow {
  label: string;
  type: "text" | "boolean" | "select";
  /** Choices, one per line, for a select. */
  choices: string;
  required: boolean;
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

/** Everything the builder edits, as typed. */
interface Draft {
  ownTerms: boolean;
  terms: string;
  intakeId: string;
  aerobic: boolean;
  cycles: CycleRow[];
  options: OptionRow[];
  rules: RuleRow[];
}

/** What a save sends for the builder's rows. The same rows always make the same body, so an unchanged plan is seen as unchanged. */
function versionBody(d: Draft, cyclesOn: boolean) {
  return {
    termsText: d.ownTerms ? d.terms : null,
    intakeTemplateId: d.intakeId || null,
    ...(cyclesOn
      ? {
          aerobic: d.aerobic,
          serviceCycles: d.cycles.map((y) => ({
            cycleKey: y.cycleKey,
            label: y.label,
            serviceType: y.serviceType,
            workTypeId: y.workTypeId,
            schedule: { kind: "every_months", everyMonths: Number(y.everyMonths), windowDays: Number(y.windowDays) },
            allowNoVisit: y.allowNoVisit,
          })),
        }
      : {}),
    options: d.options.map((o) => ({ optionKey: o.optionKey, name: o.name, priceCents: Math.round(Number(o.price) * 100), taxable: o.taxable, required: o.required, default: o.required || o.default })),
    coverage: d.rules.map((r) => ({
      ruleKey: r.ruleKey,
      label: r.label,
      match: r.matchKind === "category" ? { category: r.category } : { serviceItemId: r.serviceItemId },
      effect: r.effect,
      percentOff: r.effect === "percent_off" ? Number(r.percentOff) : null,
      limit: r.effect !== "excluded" && r.limit ? { count: Number(r.limit), per: "term" } : null,
    })),
  };
}

/** Names for the fields a refused save points at ("/options/1/name" reads "Option 2: Name"). */
const FIELDS = { termsText: "Agreement terms", priceCents: "Price", ruleKey: "Rule", percentOff: "Percent off", workTypeId: "Kind of work", everyMonths: "Every (months)", windowDays: "Window", serviceCycles: "Cycles", coverage: "Rules" };

export default function PlanPage() {
  const { id } = useParams<{ id: string }>();
  const me = useSession();
  const builder = useFeature("plan_builder") && canEdit(me);
  const recordLoad = useLoad<PlanDetail>(`/plans/${id}`);
  const { data: plan, reload } = recordLoad;
  const items = useLoad<{ items: ServiceItem[] }>(builder ? "/service-items?active=all" : null);
  const intakeForms = useLoad<{ items: FormTemplate[] }>(builder ? "/form-templates?purpose=intake" : null);
  // Pumping and maintenance cycles (SW-9): only sent when service cycles are on, so a save
  // with them off keeps the current version's cycles as they are.
  const cyclesOn = useFeature("service_cycles");
  const workTypes = useLoad<{ items: WorkType[] }>(builder && cyclesOn ? "/work-types" : null);
  const [aerobic, setAerobic] = useState(true);
  const [cycles, setCycles] = useState<CycleRow[]>([]);
  const [intakeId, setIntakeId] = useState("");
  const [newForm, setNewForm] = useState<{ name: string; questions: QuestionRow[] } | null>(null);
  const [tab, setTab] = useState<Tab>("terms");
  const [ownTerms, setOwnTerms] = useState(false);
  const [terms, setTerms] = useState("");
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  // What the current version's rows make: a save with nothing changed would only stack an identical version.
  const [baseline, setBaseline] = useState<string | null>(null);
  usePageTitle(plan?.name);

  // The form starts from the current version.
  const current = plan?.versions[0];
  useEffect(() => {
    if (!current) return;
    const d: Draft = {
      ownTerms: current.termsText !== null,
      terms: current.termsText ?? plan!.preview.terms,
      intakeId: current.intake?.id ?? "",
      aerobic: current.aerobic,
      cycles: current.serviceCycles.map((y) => ({
        cycleKey: y.cycleKey,
        label: y.label,
        serviceType: y.serviceType,
        workTypeId: y.workTypeId,
        everyMonths: String(y.schedule.everyMonths),
        windowDays: String(y.schedule.windowDays),
        allowNoVisit: y.allowNoVisit,
      })),
      options: current.options.map((o) => ({ optionKey: o.optionKey, name: o.name, price: (o.priceCents / 100).toFixed(2), taxable: o.taxable, required: o.required, default: o.default })),
      rules: current.coverage.map((r) => ({
        ruleKey: r.ruleKey,
        label: r.label,
        matchKind: "category" in r.match ? "category" : "item",
        category: "category" in r.match ? r.match.category : "repair",
        serviceItemId: "serviceItemId" in r.match ? r.match.serviceItemId : "",
        effect: r.effect,
        percentOff: r.percentOff?.toString() ?? "",
        limit: r.limit?.count.toString() ?? "",
      })),
    };
    setOwnTerms(d.ownTerms);
    setTerms(d.terms);
    setIntakeId(d.intakeId);
    setAerobic(d.aerobic);
    setCycles(d.cycles);
    setOptions(d.options);
    setRules(d.rules);
    setBaseline(JSON.stringify(versionBody(d, cyclesOn)));
  }, [current?.id]);

  const body = versionBody({ ownTerms, terms, intakeId, aerobic, cycles, options, rules }, cyclesOn);
  const changed = baseline !== null && JSON.stringify(body) !== baseline;
  useUnsavedChanges(builder && changed);

  // Saved against the version on screen: if the plan moved on (a second click, someone else), the API refuses.
  const saving = useSubmit(
    async () => {
      setSaved(null);
      const next = await api<PlanDetail>(`/plans/${id}/versions`, { method: "POST", body: { ...body, expectedVersion: plan!.version } });
      setSaved(`Saved as version ${next.version}. New contracts and renewal offers take it from now on; existing contracts keep theirs.`);
      await reload();
    },
    { fallback: "Could not save the plan.", labels: FIELDS },
  );

  const savingForm = useSubmit(
    async () => {
      if (!newForm) return;
      const form = await api<FormTemplate>("/intake-forms", {
        method: "POST",
        body: {
          key: `intake-${Date.now().toString(36)}`,
          name: newForm.name,
          definition: {
            photos: [],
            fields: newForm.questions.map((q, i) => ({
              key: `q_${i + 1}`,
              label: q.label,
              section: "Before you sign",
              required: q.required,
              type: q.type,
              ...(q.type === "select"
                ? { options: q.choices.split("\n").map((c) => c.trim()).filter(Boolean).map((c, j) => ({ value: `c${j + 1}`, label: c })) }
                : {}),
            })),
          },
        },
      });
      setNewForm(null);
      setIntakeId(form.id);
      await intakeForms.reload();
    },
    { fallback: "Could not save the form." },
  );
  const problem = saving.error ?? savingForm.error;

  if (!plan || !current) return <LoadState load={recordLoad} label="plan" back={{ href: "/plans", label: "Plans" }} />;
  const setOption = (i: number, patch: Partial<OptionRow>) => setOptions((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setCycle = (i: number, patch: Partial<CycleRow>) => setCycles((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setRule = (i: number, patch: Partial<RuleRow>) => setRules((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="stack">
      <LoadState load={recordLoad} label="plan" back={{ href: "/plans", label: "Plans" }} />
      <p>
        <Link href="/plans">← Plans</Link>
      </p>
      <div className="row">
        <h1>{plan.name}</h1>
        <span className="muted">
          version {plan.version} · {plural(plan.termMonths, "month")} · {plural(plan.visitsPerTerm, "visit")} · {money(plan.priceCents)} billed {BILLING_FREQUENCY_LABELS[plan.billingFrequency]}
        </span>
      </div>
      <p className="muted">
        Basic, Gold or Platinum are only names: a plan covers exactly what its coverage rules say, and nothing when it has none. Each save is a new version; contracts keep the version they were made
        with.
      </p>
      <div className="row" role="tablist">
        {TABS.filter(([key]) => key !== "service" || cyclesOn || !aerobic || cycles.length > 0).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "" : "secondary"} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "terms" && (
        <section className="stack">
          <label className="check">
            <input type="checkbox" checked={ownTerms} disabled={!builder} onChange={(e) => setOwnTerms(e.target.checked)} />
            This plan has its own agreement terms
          </label>
          {ownTerms ? (
            <textarea rows={14} value={terms} disabled={!builder} onChange={(e) => setTerms(e.target.value)} aria-label="Agreement terms" />
          ) : (
            <p className="muted">
              Customers sign your company&apos;s agreement terms (Settings → Renewals).
            </p>
          )}
        </section>
      )}

      {tab === "service" && (
        <section className="stack">
          <p className="muted">
            What a contract on this plan includes. Pumping and maintenance visits are booked as work orders from the contract; they are never inspections and are never filed or reported to an
            authority.
          </p>
          <label className="check">
            <input type="checkbox" checked={aerobic} disabled={!builder || !cyclesOn} onChange={(e) => setAerobic(e.target.checked)} />
            Aerobic inspections ({plan.visitsPerTerm} visits per term, or more where the authority requires them)
          </label>
          {cycles.length === 0 && <p className="muted">No pumping or maintenance visits.</p>}
          {cycles.map((y, i) => (
            <div key={i} className="card grid" data-testid="plan-cycle">
              <label>
                Name
                <input value={y.label} disabled={!builder || !cyclesOn} onChange={(e) => setCycle(i, { label: e.target.value })} />
              </label>
              <label>
                Type
                <select value={y.serviceType} disabled={!builder || !cyclesOn} onChange={(e) => setCycle(i, { serviceType: e.target.value as CycleServiceType, workTypeId: "" })}>
                  {CYCLE_SERVICE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {SERVICE_TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Booked as
                <select value={y.workTypeId} disabled={!builder || !cyclesOn} onChange={(e) => setCycle(i, { workTypeId: e.target.value })}>
                  <option value="">Choose a kind of work</option>
                  {workTypes.data?.items
                    .filter((t) => (t.active && t.category === y.serviceType) || t.id === y.workTypeId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Every (months)
                <input type="number" min={1} max={120} value={y.everyMonths} disabled={!builder || !cyclesOn} onChange={(e) => setCycle(i, { everyMonths: e.target.value })} />
              </label>
              <label>
                Window (days either side of due)
                <input type="number" min={0} max={180} value={y.windowDays} disabled={!builder || !cyclesOn} onChange={(e) => setCycle(i, { windowDays: e.target.value })} />
              </label>
              {Number(y.everyMonths) > plan.termMonths && (
                <label className="check">
                  <input type="checkbox" checked={y.allowNoVisit} disabled={!builder || !cyclesOn} onChange={(e) => setCycle(i, { allowNoVisit: e.target.checked })} /> A term may pass with no visit
                </label>
              )}
              {builder && cyclesOn && (
                <button className="link danger" onClick={() => setCycles((rows) => rows.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          {builder && cyclesOn && (
            <p>
              <button
                className="secondary"
                onClick={() =>
                  setCycles((rows) => [
                    ...rows,
                    { cycleKey: `cycle-${Date.now().toString(36)}`, label: "Tank pumping", serviceType: "pumping", workTypeId: "", everyMonths: "12", windowDays: "30", allowNoVisit: false },
                  ])
                }
              >
                Add pumping or maintenance visits
              </button>
            </p>
          )}
          {!cyclesOn && (cycles.length > 0 || !aerobic) && <p className="muted small">Service cycles are switched off: saving keeps these as they are.</p>}
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
                <input value={o.name} required disabled={!builder} onChange={(e) => setOption(i, { name: e.target.value })} aria-invalid={saving.fieldError(`/options/${i}/name`) ? true : undefined} />
              </label>
              <label>
                Price ($)
                <input type="number" min={0} step="0.01" value={o.price} disabled={!builder} onChange={(e) => setOption(i, { price: e.target.value })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={o.taxable} disabled={!builder} onChange={(e) => setOption(i, { taxable: e.target.checked })} /> Taxable
              </label>
              <label className="check">
                <input type="checkbox" checked={o.required} disabled={!builder} onChange={(e) => setOption(i, { required: e.target.checked })} /> Always included
              </label>
              <label className="check">
                <input type="checkbox" checked={o.required || o.default} disabled={!builder || o.required} onChange={(e) => setOption(i, { default: e.target.checked })} /> Ticked to start
              </label>
              {builder && (
                <button className="link danger" onClick={() => setOptions((rows) => rows.filter((_, j) => j !== i))}>
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
                <button className="link danger" onClick={() => setRules((rows) => rows.filter((_, j) => j !== i))}>
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

      {tab === "intake" && (
        <section className="stack">
          <p className="muted">Questions the customer answers when signing a renewal online. The answers are kept in the signed agreement and never change afterwards.</p>
          {builder ? (
            <label>
              Intake form
              <select value={intakeId} onChange={(e) => setIntakeId(e.target.value)}>
                <option value="">No questions</option>
                {intakeForms.data?.items.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} (version {f.version})
                  </option>
                ))}
                {current.intake && !intakeForms.data?.items.some((f) => f.id === current.intake!.id) && (
                  <option value={current.intake.id}>
                    {current.intake.name} (version {current.intake.version})
                  </option>
                )}
              </select>
            </label>
          ) : (
            <p>{current.intake ? `${current.intake.name} (version ${current.intake.version})` : "No questions."}</p>
          )}
          {builder && !newForm && (
            <p>
              <button className="secondary" onClick={() => setNewForm({ name: "", questions: [{ label: "", type: "text", choices: "", required: false }] })}>
                New intake form
              </button>
            </p>
          )}
          {newForm && (
            <div className="card stack" data-testid="intake-form-editor">
              <label>
                Form name
                <input value={newForm.name} onChange={(e) => setNewForm({ ...newForm, name: e.target.value })} />
              </label>
              {newForm.questions.map((q, i) => {
                const setQ = (patch: Partial<QuestionRow>) => setNewForm({ ...newForm, questions: newForm.questions.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div key={i} className="grid" data-testid="intake-question">
                    <label>
                      Question
                      <input value={q.label} onChange={(e) => setQ({ label: e.target.value })} />
                    </label>
                    <label>
                      Answer
                      <select value={q.type} onChange={(e) => setQ({ type: e.target.value as QuestionRow["type"] })}>
                        <option value="text">Text</option>
                        <option value="boolean">Yes or no</option>
                        <option value="select">One of a list</option>
                      </select>
                    </label>
                    {q.type === "select" && (
                      <label>
                        Choices, one per line
                        <textarea rows={3} value={q.choices} onChange={(e) => setQ({ choices: e.target.value })} />
                      </label>
                    )}
                    <label className="row">
                      <input type="checkbox" checked={q.required} onChange={(e) => setQ({ required: e.target.checked })} /> Required
                    </label>
                    <button className="link" onClick={() => setNewForm({ ...newForm, questions: newForm.questions.filter((_, j) => j !== i) })}>
                      Remove
                    </button>
                  </div>
                );
              })}
              <div className="row">
                <button className="secondary" onClick={() => setNewForm({ ...newForm, questions: [...newForm.questions, { label: "", type: "text", choices: "", required: false }] })}>
                  Add question
                </button>
                <SubmitButton type="button" busy={savingForm.busy} onClick={() => void savingForm.run()}>
                  Save form
                </SubmitButton>
                <button className="link" onClick={() => setNewForm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {tab === "versions" && (
        <table className="stack">
          <thead>
            <tr>
              <th>Version</th>
              <th>Made</th>
              <th>Price</th>
              <th>Terms</th>
              <th>Options</th>
              <th>Coverage rules</th>
              <th>Intake</th>
              <th>Used by</th>
            </tr>
          </thead>
          <tbody>
            {plan.versions.map((v) => (
              <tr key={v.id}>
                <td data-label="Version">{v.version}</td>
                <td data-label="Made">{dayOf(v.createdAt)}</td>
                <td data-label="Price" className="num">
                  {money(v.priceCents)}
                </td>
                <td data-label="Terms">{v.termsText ? "Its own" : "Company's"}</td>
                <td data-label="Options">{v.options.length}</td>
                <td data-label="Coverage rules">{v.coverage.length}</td>
                <td data-label="Intake">{v.intake ? `${v.intake.name} v${v.intake.version}` : "None"}</td>
                <td data-label="Used by">
                  {plural(v.contracts, "contract")}, {plural(v.renewals, "renewal")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "preview" && (
        <section className="stack card" data-testid="agreement-preview">
          <p className="muted small">What a customer signs under version {plan.version} (saved changes only).</p>
          {plan.preview.cycles.length > 0 && (
            <>
              <h3>Service included</h3>
              <ul className="plain" data-testid="agreement-cycles">
                {plan.preview.cycles.map((c) => (
                  <li key={c.cycleKey}>
                    {c.label}: {c.summary}
                  </li>
                ))}
              </ul>
            </>
          )}
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
          {plan.preview.intake && (
            <>
              <h3>Questions before signing: {plan.preview.intake.name}</h3>
              <ul className="plain">
                {plan.preview.intake.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}
          <h3>Terms {plan.preview.termsSource === "organization" && <span className="muted small">(your company&apos;s)</span>}</h3>
          <div style={{ whiteSpace: "pre-wrap" }}>{plan.preview.terms}</div>
        </section>
      )}

      {builder && tab !== "versions" && tab !== "preview" && (
        <div className="row">
          <SubmitButton type="button" busy={saving.busy} disabled={!changed} onClick={() => void saving.run()}>
            Save as version {plan.version + 1}
          </SubmitButton>
          {saved && !changed && <span className="muted">{saved}</span>}
          {!changed && !saved && <span className="muted small">No changes to save yet.</span>}
        </div>
      )}
      <FormError error={problem} />
    </div>
  );
}
