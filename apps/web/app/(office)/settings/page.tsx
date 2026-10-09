"use client";

import Link from "next/link";
import { useFeature } from "@/lib/features";
import { useSession } from "@/lib/session";
import { settingsPages } from "@/lib/settings-pages";

export default function SettingsIndexPage() {
  const me = useSession();
  const pages = settingsPages(me, { serviceItems: useFeature("service_items"), pumping: useFeature("pumping") });
  return (
    <div className="stack">
      <h1>Settings</h1>
      {pages.length === 0 ? (
        <p className="muted">Your role has no settings to change. Ask the company&apos;s owner or office.</p>
      ) : (
        <ul className="settings-list" data-testid="settings-list">
          {pages.map((p) => (
            <li key={p.href} className="card tight">
              <Link href={p.href}>{p.label}</Link>
              <span className="muted small">{p.about}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
