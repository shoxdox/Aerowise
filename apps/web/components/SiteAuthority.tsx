"use client";

import type { Jurisdiction, SiteJurisdiction } from "@aerowise/domain";
import { useState } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";

/** Which authority the site's inspections are filed with, and a way to choose it by hand. */
export function SiteAuthority({ siteId, county, editable }: { siteId: string; county: string | null; editable: boolean }) {
  const { data, reload } = useLoad<SiteJurisdiction>(`/sites/${siteId}/jurisdiction`);
  const [editing, setEditing] = useState(false);
  const list = useLoad<{ items: Jurisdiction[] }>(editing ? "/jurisdictions" : null);
  const [error, setError] = useState<string | null>(null);

  // Reload when the county changes on the page above.
  const [seenCounty, setSeenCounty] = useState(county);
  if (seenCounty !== county) {
    setSeenCounty(county);
    void reload();
  }

  async function choose(jurisdictionId: string | null) {
    setError(null);
    try {
      await api(`/sites/${siteId}/jurisdiction`, { method: "PUT", body: { jurisdictionId } });
      setEditing(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  if (!data) return null;
  return (
    <dl className="card details">
      <dt>Reports to</dt>
      <dd>
        {data.jurisdiction ? (
          <>
            {data.jurisdiction.authorityName}{" "}
            <span className="muted small">{data.source === "override" ? "(chosen by hand)" : `(from the county)`}</span>
          </>
        ) : (
          <span className="restriction">No authority matches{county ? ` ${county}` : " (no county set)"}. Filings for this site will need review.</span>
        )}
        {editable && !editing && (
          <>
            {" "}
            <button className="link" onClick={() => setEditing(true)}>
              Change
            </button>
          </>
        )}
        {editing && (
          <div className="row">
            <select
              aria-label="Reporting authority"
              defaultValue={data.source === "override" ? data.jurisdiction?.id : ""}
              onChange={(e) => void choose(e.target.value || null)}
            >
              <option value="">Match from the county</option>
              {list.data?.items.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.authorityName}
                </option>
              ))}
            </select>
            <button className="link" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </dd>
    </dl>
  );
}
