"use client";

import type { PublicOverview } from "@aerowise/domain";
import Link from "next/link";
import { VerifiedBadge } from "@/components/FilingBadges";
import { DemoRequestForm } from "@/components/marketing/DemoRequestForm";
import { ABOUT, COVERAGE, DEMO, HERO, PRICING, PROBLEM, RESPONSIBILITY, STEPS, TRY_DEMO } from "@/components/marketing/copy";
import { useLoad } from "@/components/useLoad";
import { useDemoMode } from "@/lib/demo";
import { money } from "@/lib/format";

// The public marketing page. Signed-in users go straight to /inbox from sign-in; anyone
// who lands here can reach the office with "Sign in". The county list and the prices come
// from the API, so the page never claims coverage or a price the deployment does not have.
export default function MarketingPage() {
  const { data, error } = useLoad<PublicOverview>("/public/overview");
  // /demo only answers on the demo deployment, so the link is shown only there, and first.
  const tryDemo = useDemoMode();
  const authorities = data?.coverage.length ?? 0;
  return (
    <div className="marketing">
      <header className="topbar">
        <strong>Aerowise</strong>
        <span className="spacer" />
        {tryDemo && <a href="/demo">{TRY_DEMO.button}</a>}
        <a href="#demo">{DEMO.button}</a>
        <Link href="/login">Sign in</Link>
      </header>
      <main className="page stack">
        <section className="hero stack">
          <p className="eyebrow">{HERO.eyebrow}</p>
          <h1>{HERO.title}</h1>
          <p className="lead">{HERO.body}</p>
          <div className="cta-row">
            {tryDemo && (
              <a className="button cta" href="/demo" data-testid="try-demo">
                {TRY_DEMO.button}
              </a>
            )}
            <a className={`button cta${tryDemo ? " secondary" : ""}`} href="#demo">
              {DEMO.button}
            </a>
          </div>
          <ul className="facts" aria-label="In short">
            {HERO.facts.map((f, i) => (
              <li key={f}>{i === 0 && authorities > 0 ? `${authorities} ${f}` : f}</li>
            ))}
          </ul>
        </section>

        <section className="stack" aria-labelledby="problem">
          <h2 id="problem">{PROBLEM.title}</h2>
          <div className="compare" role="table" aria-label={PROBLEM.title}>
            <div className="compare-head" role="row">
              <span role="columnheader">{PROBLEM.todayLabel}</span>
              <span role="columnheader">{PROBLEM.afterLabel}</span>
            </div>
            {PROBLEM.pairs.map((p) => (
              <div key={p.today} className="compare-row" role="row">
                <span role="cell" className="muted">
                  {p.today}
                </span>
                <span role="cell">{p.after}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="stack" aria-labelledby="how">
          <h2 id="how">{STEPS.title}</h2>
          <ol className="how-steps">
            {STEPS.items.map((s, i) => (
              <li key={s.title} className="card stack">
                <span className="step-number" aria-hidden="true">
                  {i + 1}
                </span>
                <strong>{s.title}</strong>
                <span>{s.body}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="stack" aria-labelledby="coverage">
          <h2 id="coverage">
            {COVERAGE.title}
            {authorities > 0 && <span className="muted count"> · {authorities} Texas authorities</span>}
          </h2>
          <p className="muted">{COVERAGE.intro}</p>
          {error && <p className="error">{error}</p>}
          {data && data.coverage.length === 0 && <p>{COVERAGE.empty}</p>}
          {data && data.coverage.length > 0 && (
            <ul className="coverage" aria-label="Authorities covered">
              {data.coverage.map((c) => (
                <li key={c.key} data-key={c.key}>
                  <span className="county">{c.counties.length === 1 ? `${c.counties[0]} County` : `${c.counties.join(", ")} counties`}</span>
                  <strong>{c.authorityName}</strong>
                  <span className="badges">
                    {c.verified ? (
                      <VerifiedBadge verified={c.verified} />
                    ) : (
                      <span className="badge warn" title={COVERAGE.draftNote}>
                        {COVERAGE.draftLabel}
                      </span>
                    )}
                  </span>
                  {c.confirmedWithAuthority.length > 0 && (
                    <span className="small">
                      {COVERAGE.confirmedLabel}: {c.confirmedWithAuthority.map((l, i) => (i === 0 ? l : l.toLowerCase())).join(", ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">{COVERAGE.notYours}</p>
        </section>

        <section className="stack" aria-labelledby="pricing">
          <h2 id="pricing">{PRICING.title}</h2>
          {data && (
            <div className="card price-card">
              <div className="price-main">
                <p className="price">Free for {data.pricing.designPartnerDays} days</p>
                <p>
                  After that, {money(data.pricing.pricePerContractCents)} per active contract per month, with a {money(data.pricing.monthlyMinimumCents)} monthly
                  minimum.
                </p>
                <p className="muted">{PRICING.note}</p>
              </div>
              <div className="price-founder">
                <span className="badge">{PRICING.founderLabel}</span>
                <p>{PRICING.founder}</p>
              </div>
            </div>
          )}
        </section>

        <section className="stack" aria-labelledby="about">
          <h2 id="about">{ABOUT.title}</h2>
          <div className="card stack about">
            <p>{ABOUT.body}</p>
            <p className="row">
              <a className="button secondary" href={ABOUT.phoneHref}>
                {ABOUT.phone}
              </a>
              <a className="button secondary" href={`mailto:${ABOUT.email}`}>
                {ABOUT.email}
              </a>
            </p>
          </div>
        </section>

        <section className="stack" id="demo" aria-labelledby="demo-title">
          <h2 id="demo-title">{DEMO.title}</h2>
          <p className="muted">{DEMO.intro}</p>
          <DemoRequestForm />
        </section>

        <footer className="muted small stack">
          <span>{RESPONSIBILITY}</span>
          <span className="row">
            <Link href="/terms">Terms of service</Link>
            <Link href="/privacy">Privacy policy</Link>
            <Link href="/data-handling">How we handle your data</Link>
          </span>
        </footer>
      </main>
    </div>
  );
}
