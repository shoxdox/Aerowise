"use client";

import Link from "next/link";
import { OnboardingSummary } from "@/components/OnboardingSummary";

export default function OnboardingSummaryPage() {
  return (
    <div className="stack">
      <h1>Your book at a glance</h1>
      <p className="muted">
        Every customer and site in Aerowise, whether imported or added by hand. <Link href="/import">Import more</Link>.
      </p>
      <OnboardingSummary />
    </div>
  );
}
