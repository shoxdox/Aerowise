"use client";

import type { PublicOverview } from "@aerowise/domain";
import Link from "next/link";
import { VerifiedBadge } from "@/components/FilingBadges";
import { DemoRequestForm } from "@/components/marketing/DemoRequestForm";
import { COVERAGE, DEMO, HERO, PRICING, PROBLEM, RESPONSIBILITY, STEPS } from "@/components/marketing/copy";
import { useLoad } from "@/components/useLoad";
import { money } from "@/lib/format";

// The public marketing page. Signed-in users go straight to /inbox from sign-in; anyone
// who lands here can reach the office with "Sign in".
export default function MarketingPage() {
  const { data, error } = useLoad<PublicOverview>("/public/overview");
  return (
    <div className="marketing">
      <header className="topbar">
        <strong>Aerowise</strong>
        <span className="spacer" />
        <a href="#demo">{DEMO.button}</a>
        <Link href="/login">Sign in</Link>
      </header>
      <main className="page stack">
        <section className="hero stack">
          <h1>{HERO.title}</h1>
          <p className="lead">{HERO.body}</p>
          <a className="button cta" href="#demo">
            {DEMO.button}
          </a>
        </section>

        <section className="stack" aria-labelledby="problem">
          <h2 id="problem">{PROBLEM.title}</h2>
          <ul className="points">
            {PROBLEM.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>

        <section className="stack" aria-labelledby="how">
          <h2 id="how">{STEPS.title}</h2>
          <ol className="how-steps">
            {STEPS.items.map((s) => (
              <li key={s.title} className="card stack">
                <strong>{s.title}</strong>
                <span>{s.body}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="stack" aria-labelledby="coverage">
          <h2 id="coverage">{COVERAGE.title}</h2>
          <p className="muted">{COVERAGE.intro}</p>
          {error && <p className="error">{error}</p>}
          {data && data.coverage.length === 0 && <p>{COVERAGE.empty}</p>}
          {data && data.coverage.length > 0 && (
            <ul className="coverage" aria-label="Authorities covered">
              {data.coverage.map((c) => (
                <li key={c.key} className="card tight" data-key={c.key}>
                  <strong>{c.authorityName}</strong>
                  <span className="muted small">{c.counties.length === 1 ? `${c.counties[0]} County` : `${c.counties.join(", ")} counties`}</span>
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
        </section>

        <section className="stack" aria-labelledby="pricing">
          <h2 id="pricing">{PRICING.title}</h2>
          {data && (
            <div className="card stack">
              <p className="price">Free for {data.pricing.designPartnerDays} days</p>
              <p>
                After that, {money(data.pricing.pricePerContractCents)} per active contract per month, with a {money(data.pricing.monthlyMinimumCents)} monthly
                minimum.
              </p>
            </div>
          )}
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
