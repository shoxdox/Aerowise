"use client";

import { monthlyCharge, publicOverview, type CoverageItem, type PublicOverview } from "@aerowise/domain";
import Link from "next/link";
import { useEffect, useState } from "react";
import { VerifiedBadge } from "@/components/FilingBadges";
import { money } from "@/lib/format";
import { DemoRequestForm } from "./DemoRequestForm";
import { CONTACT, COVERAGE, DEMO, HERO, PRICING, PUBLIC_DEMO_URL, RESPONSIBILITY, STEPS, TRY_DEMO, TRY_IT } from "./copy";
import { TryIt } from "./TryIt";

const FILING_GROUPS = ["email", "portal", "prepared"] as const;
const WAIT_MS = 10_000;

/** Bounded reads, explicit retry and no invented fallback price. Independent of company/session data. */
function usePublicOverview() {
  const [data, setData] = useState<PublicOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), WAIT_MS);
    setLoading(true);
    setError(null);
    fetch("/api/public/overview", { credentials: "omit", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("unavailable");
        return publicOverview.parse(await res.json());
      })
      .then((value) => { if (active) setData(value); })
      .catch(() => { if (active) setError(controller.signal.aborted ? "The request took too long." : "The request failed."); })
      .finally(() => { clearTimeout(timer); if (active) setLoading(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [attempt]);
  return { data, error, loading, retry: () => setAttempt((v) => v + 1) };
}

/** Known staging entry remains usable if app-info cannot answer. Local/demo deployments use their own entry once confirmed. */
function useDemoEntry() {
  const [href, setHref] = useState(PUBLIC_DEMO_URL);
  const [state, setState] = useState<"checking" | "ready" | "unavailable">("checking");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), WAIT_MS);
    setState("checking");
    fetch("/api/app-info", { credentials: "same-origin", signal: controller.signal })
      .then(async (r) => { if (!r.ok) throw new Error("unavailable"); return r.json() as Promise<{ demo?: boolean }>; })
      .then((body) => { if (active) { setHref(body.demo ? "/demo" : PUBLIC_DEMO_URL); setState("ready"); } })
      .catch(() => { if (active) setState("unavailable"); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [attempt]);
  return { href, state, retry: () => setAttempt((v) => v + 1) };
}

function ReadState({ area, loading, error, hasData, retry }: { area: string; loading: boolean; error: string | null; hasData: boolean; retry: () => void }) {
  if (error) return <div className="card stack public-read-state" role="alert"><p>{hasData ? `${area} below is from the last successful read; it has not been refreshed.` : `${area} is temporarily unavailable.`} {error} Contact Justin directly for help.</p><button type="button" className="secondary" onClick={retry}>Retry {area.toLowerCase()}</button></div>;
  if (loading) return <p className="muted" role="status">{hasData ? `Refreshing ${area.toLowerCase()}…` : `Loading ${area.toLowerCase()}… Contact and the fictional demo are available while you wait.`}</p>;
  return null;
}

export function PublicHomepage() {
  const { data, error, loading, retry } = usePublicOverview();
  const demo = useDemoEntry();
  const groups = FILING_GROUPS.map((filing) => ({ filing, items: (data?.coverage ?? []).filter((c) => c.filing === filing) })).filter((g) => g.items.length);
  const price = data?.pricing;
  return <div className="marketing outreach-home">
    <header className="topbar"><strong>Aerowise</strong><span className="spacer" /><a href={demo.href}>{TRY_DEMO.button}</a><a href="#contact">Talk to Justin</a><Link href="/login">Sign in</Link></header>
    <main className="page stack">
      <section className="hero">
        <div className="hero-text stack"><p className="eyebrow">{HERO.eyebrow}</p><h1>{HERO.title}</h1><p className="lead">{HERO.body}</p>
          <div className="cta-row"><a className="button cta" href={demo.href} data-testid="try-demo">{TRY_DEMO.button}</a><a className="button secondary" href="#contact">Talk to Justin about a pilot</a><a href="#inspection-preview">Preview an inspection</a></div>
          <p className="muted small">Your own fictional company for 24 hours. No sign-up, real messages or charges. The public demo is on staging.deshain.com; sign-in stays on this deployment.</p>
          {demo.state === "checking" && <p className="muted small" role="status">Checking this deployment's demo availability… The staging demo link remains available.</p>}
          {demo.state === "unavailable" && <p className="muted small" role="status">Demo availability could not be checked. Use the staging demo link or <button className="link" onClick={demo.retry}>retry the availability check</button>.</p>}
          <ul className="facts" aria-label="In short">{HERO.facts.map((f) => <li key={f}>{f}</li>)}</ul>
        </div>
        <figure className="shot wide"><div className="readable-shot" tabIndex={0} role="region" aria-label="Scrollable fictional Due list screenshot"><img src={HERO.shot.src} alt={HERO.shot.alt} width={2560} height={1190} /></div><figcaption className="muted small">{HERO.shot.caption}</figcaption></figure>
      </section>
      <section className="stack" aria-labelledby="how"><h2 id="how">{STEPS.title}</h2><ol className="how-steps">{STEPS.items.map((s, i) => <li key={s.title} className="stack"><span className="step-number" aria-hidden="true">{i + 1}</span><strong>{s.title}</strong><span className="muted">{s.body}</span></li>)}</ol></section>
      <section className="card stack" aria-labelledby="pilot"><p className="eyebrow">Help shape the first real provider workflow</p><h2 id="pilot">A guided design-partner pilot</h2><p>Justin helps review your import, provider credentials, permits and filing process. Start with a small supervised group of sites alongside your existing process. No real provider or authority has validated Aerowise yet.</p><p>A pilot requires a conversation and an agreed scope. The fictional demo and public preview are available immediately; they do not start a trial or paid subscription.</p><a href="#contact">Discuss your company's pilot</a></section>
      <section className="stack" aria-labelledby="pricing"><h2 id="pricing">{PRICING.title}</h2><ReadState area="Pricing" loading={loading} error={error} hasData={!!data} retry={retry} />
        {price && <><div className="card price-card"><div className="price-main"><p className="price">{money(price.pricePerContractCents)} <span className="small">per active contract per month</span></p><p>{money(price.monthlyMinimumCents)} monthly minimum.</p><p className="muted">{PRICING.note}</p><p>An agreed design-partner pilot has a {price.designPartnerDays}-day free period. The separate ordinary trial is {price.trialDays} days. A company starts paying when its subscription moves to a paid state; its agreed dates and rates are shown in Subscription.</p></div><div className="price-founder"><span className="badge">{PRICING.founderLabel}</span><p>The first {price.founderCompanyLimit} eligible companies can receive {money(price.founderPricePerContractCents)} per active contract per month, with the same {money(price.monthlyMinimumCents)} minimum, for as long as they stay. Justin confirms eligibility and sets each company's agreed rate before payment begins.</p></div></div>
          <ul className="price-examples" aria-label="Example monthly prices">{[100, 300, 1000].map((n) => <li className="card stack" key={n}><strong>{n.toLocaleString()} active contracts</strong><span>List: {money(monthlyCharge(n, price).totalCents)}/month</span><span>Founder: {money(monthlyCharge(n, { ...price, pricePerContractCents: price.founderPricePerContractCents }).totalCents)}/month</span></li>)}</ul></>}
      </section>
      <section className="stack" aria-labelledby="coverage"><h2 id="coverage">{COVERAGE.title}</h2><p className="muted">{COVERAGE.intro}</p><ReadState area="Authority profiles" loading={loading} error={error} hasData={!!data} retry={retry} />
        {data && (data.coverage.length ? <><AuthorityFit coverage={data.coverage} /><details className="card"><summary>All {data.coverage.length} public authority profiles</summary><div className="coverage-groups" id="coverage-groups">{groups.map((g) => <div key={g.filing} className={`coverage-group stack ${g.filing}`}><h3>{COVERAGE.groups[g.filing].label} <span className="muted count">({g.items.length})</span></h3><p className="muted small">{COVERAGE.groups[g.filing].note}</p><ul className="coverage" aria-label={`Authorities covered: ${COVERAGE.groups[g.filing].label.toLowerCase()}`}>{g.items.map((c) => <CoverageRow key={c.key} item={c} />)}</ul></div>)}</div></details></> : <p>{COVERAGE.empty}</p>)}<p className="muted small">{COVERAGE.notYours}</p>
      </section>
      <section className="stack" id="inspection-preview" aria-labelledby="preview-title"><h2 id="preview-title">{TRY_IT.title}</h2><p>{TRY_IT.intro}</p><ReadState area="Inspection preview" loading={loading} error={error} hasData={!!data} retry={retry} />{data && data.coverage.length > 0 && <details className="card"><summary>Open the optional inspection preview</summary><TryIt coverage={data.coverage} /></details>}{data?.coverage.length === 0 && <p>No authority profiles are available for the preview. Contact Justin about your workflow.</p>}</section>
      <section className="stack demo-section" id="contact" aria-labelledby="contact-title"><h2 id="contact-title">{DEMO.title}</h2><p>{DEMO.intro}</p><div className="demo-grid"><div className="stack contact"><p>{CONTACT.line}</p><a className="button" href={`mailto:${CONTACT.email}`}>Email Justin: {CONTACT.email}</a><a className="button secondary" href={CONTACT.phoneHref}>Call {CONTACT.phone}</a><p className="muted small">The form saves to an admin queue. In a demo deployment its alert is simulated; it does not prove Justin received an email. Direct email/call is the dependable contact option.</p></div><DemoRequestForm /></div></section>
      <footer className="muted small stack"><span>{CONTACT.footer}</span><span>{RESPONSIBILITY}</span><span className="row"><Link href="/terms">Terms of service</Link><Link href="/privacy">Privacy policy</Link><Link href="/data-handling">How we handle your data</Link></span></footer>
    </main>
  </div>;
}

function AuthorityFit({ coverage }: { coverage: CoverageItem[] }) {
  const [key, setKey] = useState(coverage[0]?.key ?? "");
  const selected = coverage.find((c) => c.key === key) ?? coverage[0];
  if (!selected) return null;
  return <div className="card stack"><label>Authority fit lookup<select value={selected.key} onChange={(e) => setKey(e.target.value)}>{coverage.map((c) => <option key={c.key} value={c.key}>{c.authorityName} · {c.counties.join(", ")}</option>)}</select></label><strong>{selected.authorityName}</strong><ProfileStatus item={selected} /><p>Profile interval: {selected.rules.intervalMonths} months{selected.rules.monitoredIntervalMonths && selected.rules.monitoredIntervalMonths !== selected.rules.intervalMonths ? `; ${selected.rules.monitoredIntervalMonths} months with applicable recorded monitoring` : ""}. {COVERAGE.groups[selected.filing].note}</p><p className="muted small">Selecting an authority here assigns no real site. Check the permit and unresolved fields before live use.</p></div>;
}
function ProfileStatus({ item }: { item: CoverageItem }) { return item.verified ? <VerifiedBadge verified={item.verified} /> : <span className="badge warn" title={COVERAGE.draftNote}>{COVERAGE.draftLabel} · authority verification pending</span>; }
function CoverageRow({ item: c }: { item: CoverageItem }) {
  return <li data-key={c.key}><span className="county">{c.counties.join(", ")}</span><strong>{c.authorityName}</strong><ProfileStatus item={c} />{c.confirmedWithAuthority.length > 0 && <span className="small">{COVERAGE.confirmedLabel}: {c.confirmedWithAuthority.join(", ")}</span>}</li>;
}
