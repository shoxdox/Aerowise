"use client";

import Link from "next/link";
import { useFeature } from "@/lib/features";
import { useSession } from "@/lib/session";
import { SETTINGS_GROUPS, settingsPages } from "@/lib/settings-pages";

export default function SettingsIndexPage() {
  const me = useSession();
  const pages = settingsPages(me, { serviceItems: useFeature("service_items"), pumping: useFeature("pumping") });
  return (
    <div className="stack">
      <h1>Settings</h1>
      {pages.length === 0 ? (
        <p className="muted">Your role has no settings to change. Ask the company&apos;s owner or office.</p>
      ) : (
        <div className="stack settings-groups" data-testid="settings-list">
          {SETTINGS_GROUPS.map((group, i) => {
            const inGroup = pages.filter((p) => p.group === group);
            if (inGroup.length === 0) return null;
            return (
              <section key={group} className="stack" aria-labelledby={`settings-group-${i}`}>
                <h2 id={`settings-group-${i}`}>{group}</h2>
                <ul className="settings-list">
                  {inGroup.map((p) => (
                    <li key={p.href}>
                      <Link href={p.href} className="card link-card">
                        <strong>{p.label}</strong>
                        <span className="muted small">{p.about}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
