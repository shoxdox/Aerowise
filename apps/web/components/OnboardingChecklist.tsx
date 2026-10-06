"use client";

import type { OnboardingChecklist as Checklist } from "@aerowise/domain";
import Link from "next/link";

/**
 * The first-run checklist on the office home. Hidden once every required step is done. The
 * inbox loads it with its own data so the page appears whole instead of jumping down.
 */
export function OnboardingChecklist({ data }: { data: Checklist | null }) {
  if (!data || data.complete) return null;
  const required = data.items.filter((i) => !i.optional);
  const done = required.filter((i) => i.done).length;
  return (
    <section className="card stack onboarding" aria-labelledby="onboarding-title">
      <div className="row">
        <h2 id="onboarding-title">Get set up</h2>
        <span className="spacer" />
        <span className="muted small">
          {done} of {required.length} done
        </span>
      </div>
      <ul className="onboarding-items">
        {data.items.map((i) => (
          <li key={i.key} className={i.done ? "done" : ""} data-testid={`onboarding-${i.key}`}>
            <span aria-hidden="true">{i.done ? "✓" : "○"}</span>
            <div>
              {i.done ? <span>{i.label}</span> : <Link href={i.href}>{i.label}</Link>}
              {i.optional && <span className="muted small"> (optional)</span>}
              {i.detail && <div className="muted small">{i.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
