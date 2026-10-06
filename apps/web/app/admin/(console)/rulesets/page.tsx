"use client";

import type { RulesetCoverage, RulesetCoverageItem } from "@aerowise/domain";
import Link from "next/link";
import { VerifiedBadge } from "@/components/FilingBadges";
import { useLoad } from "@/components/useLoad";
import { day } from "@/lib/format";

function Status({ item }: { item: RulesetCoverageItem }) {
  if (item.verified) return <VerifiedBadge verified={item.verified} />;
  if (item.profileStatus === "draft") return <span className="badge warn">Draft</span>;
  return <span className="badge inactive">Example rules</span>;
}

/** Every reporting authority: how far its rules are checked, what is open, and who uses it. */
export default function RulesetCoveragePage() {
  const { data, error } = useLoad<RulesetCoverage>("/admin/rulesets");
  return (
    <div className="stack">
      <h1>Ruleset coverage</h1>
      <p className="muted">
        Sites are counted across every organization, as each would resolve today ({data ? day(data.today) : "…"}). A draft never sends on its own; a ruleset becomes verified only with a record of who confirmed it with the authority.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Authority</th>
              <th>Status</th>
              <th>Sources read</th>
              <th>Open questions</th>
              <th>Sites</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((i) => (
              <tr key={i.key}>
                <td>
                  <Link href={`/admin/rulesets/${i.key}`}>{i.authorityName}</Link>
                  <div className="muted small">
                    {i.key} · {i.rulesetVersion ? `v${i.rulesetVersion} in force` : "no version in force today"}
                    {i.versions > 1 ? ` · ${i.versions} versions` : ""}
                    {i.active ? "" : " · inactive"}
                  </div>
                </td>
                <td>
                  <Status item={i} />
                  {!i.verified && i.profileStatus !== "fictional" && <div className="muted small">{i.confirmation}</div>}
                </td>
                <td>{i.sourcesCheckedOn ? `${day(i.sourcesCheckedOn)} (${i.sourceCount} source${i.sourceCount === 1 ? "" : "s"})` : <span className="muted">—</span>}</td>
                <td>
                  {i.unresolved.length === 0 ? (
                    <span className="muted">None</span>
                  ) : (
                    <details>
                      <summary className="small">{i.unresolved.length} open</summary>
                      <ul className="small">
                        {i.unresolved.map((u) => (
                          <li key={u}>{u}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
                <td>
                  {i.sites} in {i.organizations} organization{i.organizations === 1 ? "" : "s"}
                  {i.sitesToDecide > 0 && <div className="muted small">{i.sitesToDecide} more to decide</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && (
        <p className="muted small">
          {data.sitesWithoutAuthority} active site{data.sitesWithoutAuthority === 1 ? " has" : "s have"} no authority: no county, or a county no ruleset covers yet.
        </p>
      )}
    </div>
  );
}
