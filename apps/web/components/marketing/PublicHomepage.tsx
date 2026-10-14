"use client";

import { monthlyCharge, publicOverview, type CoverageItem, type PublicOverview } from "@aerowise/domain";
import Link from "next/link";
import { useEffect, useState } from "react";
import { money } from "@/lib/format";
import { DemoRequestForm } from "./DemoRequestForm";
import { CONTACT, COUNTIES, FEATURES, FOOTER, HERO, PRICING, PUBLIC_DEMO_URL, SHOTS, WALKTHROUGH } from "./copy";

const WAIT_MS = 10_000;

/** Bounded read with an explicit retry; the page never invents a price or an authority list. */
function usePublicOverview() {
  const [data, setData] = useState<PublicOverview | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timer = setTimeout(() => controller.abort(), WAIT_MS);
    setError(false);
    fetch("/api/public/overview", { credentials: "omit", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error("unavailable");
        return publicOverview.parse(await res.json());
      })
      .then((value) => { if (active) setData(value); })
      .catch(() => { if (active) setError(true); })
      .finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [attempt]);
  return { data, error, retry: () => setAttempt((v) => v + 1) };
}

/** A demo deployment opens its own demo; anywhere else (or if app-info cannot answer) the known staging entry. */
function useDemoHref() {
  const [href, setHref] = useState(PUBLIC_DEMO_URL);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WAIT_MS);
    fetch("/api/app-info", { credentials: "same-origin", signal: controller.signal })
      .then(async (r) => { if (!r.ok) throw new Error("unavailable"); return r.json() as Promise<{ demo?: boolean }>; })
      .then((body) => setHref(body.demo ? "/demo" : PUBLIC_DEMO_URL))
      .catch(() => {})
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, []);
  return href;
}

/** "Williamson County", "City of Denton", "LCRA": what a provider calls the authority, with the full name on hover. */
function shortName(c: CoverageItem): string {
  if (c.type === "city") return `City of ${c.counties[0]}`;
  if (c.type === "river_authority") {
    const acronym = c.authorityName.match(/\(([A-Z]{3,})\)/)?.[1];
    if (acronym) return acronym;
    return (c.authorityName.split(",")[0] ?? c.authorityName).split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join("");
  }
  return `${c.counties[0]} County`;
}

function Unavailable({ what, retry }: { what: string; retry: () => void }) {
  return <p className="home-unavailable" role="alert">Couldn&apos;t load {what}. <button type="button" className="link" onClick={retry}>Try again</button></p>;
}

export function PublicHomepage() {
  const { data, error, retry } = usePublicOverview();
  const demoHref = useDemoHref();
  return (
    <div className="home">
      <header className="home-nav">
        <div className="home-wrap home-nav-inner">
          <Link href="/" className="home-logo"><img src="/icons/icon.svg" alt="" width={28} height={28} />Aerowise</Link>
          <nav aria-label="On this page"><a href="#how">How it works</a><a href="#counties">Counties</a><a href="#pricing">Pricing</a></nav>
          <span className="spacer" />
          <Link href="/login" className="home-signin">Sign in</Link>
          <a className="home-btn home-btn-sm" href={demoHref}>{HERO.primary}</a>
        </div>
      </header>

      <main>
        <section className="home-hero">
          <div className="home-wrap home-hero-grid">
            <div className="home-hero-text">
              <p className="home-eyebrow">{HERO.eyebrow}</p>
              <h1>{HERO.title}</h1>
              <p className="home-lead">{HERO.body}</p>
              <div className="home-ctas">
                <a className="home-btn" href={demoHref} data-testid="try-demo">{HERO.primary}<span aria-hidden="true"> →</span></a>
                <a className="home-btn home-btn-ghost" href="#walkthrough">{HERO.secondary}</a>
              </div>
              <p className="home-note">{HERO.note}</p>
            </div>
            <div className="home-hero-art">
              <figure className="home-browser">
                <div className="home-browser-bar" aria-hidden="true"><span /><span /><span /></div>
                <img src={HERO.office.src} alt={HERO.office.alt} width={HERO.office.width} height={HERO.office.height} />
              </figure>
              <figure className="home-phone home-phone-float">
                <img src={HERO.phone.src} alt={HERO.phone.alt} width={HERO.phone.width} height={HERO.phone.height} />
              </figure>
            </div>
          </div>
        </section>

        <section id="how" className="home-section" aria-labelledby="how-title">
          <div className="home-wrap">
            <h2 id="how-title" className="home-h2">One record from the contract to the county</h2>
            <ol className="home-features">
              {FEATURES.map((f) => (
                <li key={f.key} className="home-feature">
                  <p className="home-label">{f.label}</p>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                  <ul className="home-checks">{f.points.map((p) => <li key={p}>{p}</li>)}</ul>
                </li>
              ))}
            </ol>
            <div className="home-showcase">
              <figure>
                <div className="home-phone"><img src={SHOTS.inspection.src} alt={SHOTS.inspection.alt} width={SHOTS.inspection.width} height={SHOTS.inspection.height} loading="lazy" /></div>
                <figcaption>{SHOTS.inspectionCaption}</figcaption>
              </figure>
              <figure>
                <div className="home-papers">
                  <img className="home-paper" src={SHOTS.report.src} alt={SHOTS.report.alt} width={SHOTS.report.width} height={SHOTS.report.height} loading="lazy" />
                  <img className="home-paper home-paper-front" src={SHOTS.cover.src} alt={SHOTS.cover.alt} width={SHOTS.cover.width} height={SHOTS.cover.height} loading="lazy" />
                </div>
                <figcaption>{SHOTS.reportCaption}</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section id="counties" className="home-section home-tint" aria-labelledby="counties-title">
          <div className="home-wrap home-narrow">
            <h2 id="counties-title" className="home-h2">{COUNTIES.title}</h2>
            {data && <p className="home-sub">{COUNTIES.intro(data.coverage.length)}</p>}
            {error && !data && <Unavailable what="the list of authorities" retry={retry} />}
            {data && (
              <>
                <ul className="home-chips" aria-label="Authorities">
                  {data.coverage.map((c) => (
                    <li key={c.key} title={c.authorityName} className={c.filing === "email" ? "emailed" : undefined}>{shortName(c)}</li>
                  ))}
                </ul>
                <p className="home-legend"><span className="home-dot" aria-hidden="true" /> {COUNTIES.emailed} <span className="home-legend-sep" aria-hidden="true">·</span> <span className="home-dot hollow" aria-hidden="true" /> {COUNTIES.prepared}</p>
              </>
            )}
            <p className="home-fine">{COUNTIES.note} {COUNTIES.missing} <a href="#walkthrough">{COUNTIES.ask}</a>.</p>
          </div>
        </section>

        <section id="pricing" className="home-section" aria-labelledby="pricing-title">
          <div className="home-wrap home-narrow">
            <h2 id="pricing-title" className="home-h2">{PRICING.title}</h2>
            {error && !data && <Unavailable what="pricing" retry={retry} />}
            {data && <PriceCard pricing={data.pricing} />}
          </div>
        </section>

        <section id="walkthrough" className="home-section home-tint" aria-labelledby="walkthrough-title">
          <div className="home-wrap home-contact">
            <div className="home-contact-text">
              <h2 id="walkthrough-title" className="home-h2">{WALKTHROUGH.title}</h2>
              <p className="home-sub">{WALKTHROUGH.body}</p>
            </div>
            <DemoRequestForm />
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <div className="home-wrap home-footer-inner">
          <div>
            <p className="home-logo"><img src="/icons/icon.svg" alt="" width={22} height={22} />Aerowise</p>
            <p>{FOOTER.tagline}</p>
          </div>
          <div className="home-footer-links">
            <a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a>
            <a href={CONTACT.phoneHref}>{CONTACT.phone}</a>
          </div>
          <div className="home-footer-links">
            <Link href="/terms">Terms of service</Link>
            <Link href="/privacy">Privacy policy</Link>
            <Link href="/data-handling">How we handle your data</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function PriceCard({ pricing }: { pricing: PublicOverview["pricing"] }) {
  const [contracts, setContracts] = useState("300");
  const n = Math.max(0, Math.min(100_000, Math.floor(Number(contracts) || 0)));
  return (
    <div className="home-price">
      <div className="home-price-main">
        <p className="price"><strong>{money(pricing.pricePerContractCents)}</strong> {PRICING.unit}</p>
        <p className="home-fine">{PRICING.minimum(money(pricing.monthlyMinimumCents))}</p>
        <ul className="home-checks">{PRICING.points(pricing.designPartnerDays).map((p) => <li key={p}>{p}</li>)}</ul>
      </div>
      <div className="home-price-calc">
        <label>
          {PRICING.calc}
          <input type="number" inputMode="numeric" min={0} max={100000} step={10} value={contracts} onChange={(e) => setContracts(e.target.value)} />
        </label>
        <p className="home-price-total" aria-live="polite"><strong>{money(monthlyCharge(n, pricing).totalCents)}</strong> {PRICING.perMonth}</p>
        <a className="home-btn" href="#walkthrough">{HERO.secondary}</a>
      </div>
    </div>
  );
}
