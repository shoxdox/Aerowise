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
          Finished inspections are prepared for office review and the maintenance provider&apos;s signature. <Link href="/filings">Filings</Link> shows the actual email, manual or CSV submission method and its evidence. Record acknowledgment where the authority has a published process; submission alone does not prove acceptance.
        </li>
        <li>
          <Link href="/renewals">Renewals</Link> and <Link href="/invoices">invoices</Link> can be sent to homeowners after review. Online payment is optional; checks and manual payments are supported.
        </li>
        <li>This inbox lists current alerts. Due, Filings and the site record retain the full operating and evidence history.</li>
      </ol>
    ),
  },
  technician: {
    title: "Your day in Aerowise",
    body: (
      <ol className="intro-steps">
        <li>Open a stop for access, system, permit and office notes.</li>
        <li>Arrive starts or resumes its inspection. Location can be declined.</li>
        <li>The form shows Saving locally until the phone saves, then Saved on this phone. Waiting work sends when signal returns.</li>
        <li>Review photos before finishing. Finished inspections stay read-only; the maintenance provider reviews and signs the report in the office.</li>
      </ol>
    ),
  },
};

export function IntroCard({ intro, me }: { intro: Intro; me: Me }) {
  // Work comes first; brief help stays available on every account.
  const [dismissed, setDismissed] = useState(() => true);
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
