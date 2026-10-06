"use client";

import type { Intro } from "@aerowise/domain";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import type { Me } from "@/lib/session";

// The first-run intros (W10.4). Shown until the person closes one; it then folds into a
// link in the same place that opens it again. Kept on the person's account, so it stays
// closed on every device.

const CONTENT: Record<Intro, { title: string; body: ReactNode }> = {
  office: {
    title: "How Aerowise runs the work",
    body: (
      <ol className="intro-steps">
        <li>
          <Link href="/due">Due</Link> lists every visit your contracts and the county&apos;s rules call for, with its deadline.
        </li>
        <li>
          <Link href="/schedule">Schedule</Link> puts visits on a technician&apos;s day. They inspect on their phone, with photos, even without signal.
        </li>
        <li>
          Each finished inspection becomes a signed report that Aerowise files with the site&apos;s authority. <Link href="/filings">Filings</Link> counts it done once the authority acknowledges it.
        </li>
        <li>
          <Link href="/renewals">Renewals</Link> and <Link href="/invoices">invoices</Link> go to homeowners by email, and they can sign and pay online.
        </li>
        <li>This inbox lists whatever needs you today. When it is empty, everything is on track.</li>
      </ol>
    ),
  },
  technician: {
    title: "Your day in Aerowise",
    body: (
      <ol className="intro-steps">
        <li>Your route lists today&apos;s visits in order. Open one for the address, access notes and what was found last time.</li>
        <li>Start the inspection when you arrive: it records the time and place.</li>
        <li>Fill in the readings and take the photos it asks for. Everything is kept on this phone and sent when you have signal.</li>
        <li>Finish, and the office gets the report to sign and file.</li>
      </ol>
    ),
  },
};

export function IntroCard({ intro, me }: { intro: Intro; me: Me }) {
  // An account cached on a phone before intros existed has no list: show it once more.
  const [dismissed, setDismissed] = useState(() => me.introsDismissed?.includes(intro) ?? false);
  // Support looks around read-only and cannot record anything.
  if (me.support) return null;
  const { title, body } = CONTENT[intro];

  function choose(next: boolean) {
    setDismissed(next);
    // Offline, it stays as chosen on this screen and shows again next time; nothing is lost.
    api(`/auth/me/intros/${intro}`, { method: "PUT", body: { dismissed: next } }).catch(() => {});
  }

  if (dismissed) {
    return (
      <button className="link small intro-reopen" onClick={() => choose(false)}>
        Show the introduction
      </button>
    );
  }
  return (
    <section className="card stack intro" aria-labelledby={`intro-${intro}`} data-testid={`intro-${intro}`}>
      <h2 id={`intro-${intro}`}>{title}</h2>
      {body}
      <div className="row">
        <span className="spacer" />
        <button onClick={() => choose(true)}>Got it</button>
      </div>
    </section>
  );
}
