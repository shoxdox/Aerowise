"use client";

import { AUTHORITY_EVIDENCE_KINDS, AUTHORITY_EVIDENCE_LABELS, type Jurisdiction, type SiteJurisdiction } from "@aerowise/domain";
import { useState } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { day, when } from "@/lib/format";

type EvidenceKind = (typeof AUTHORITY_EVIDENCE_KINDS)[number];

/**
 * Which authority the site's filings go to, why, and the site's numbers with that
 * authority. Choosing one by hand records what it was based on (a map lookup, the
 * authority's answer, a permit record); nothing is matched by guessing.
 */
export function SiteAuthority({ siteId, county, editable }: { siteId: string; county: string | null; editable: boolean }) {
  const { data, reload } = useLoad<SiteJurisdiction>(`/sites/${siteId}/jurisdiction`);
  const [editing, setEditing] = useState(false);
  const list = useLoad<{ items: Jurisdiction[] }>(editing ? "/jurisdictions" : null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState("");
  const [evidenceKind, setEvidenceKind] = useState<EvidenceKind>("authority_map");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");

  // Reload when the county changes on the page above.
  const [seenCounty, setSeenCounty] = useState(county);
  if (seenCounty !== county) {
    setSeenCounty(county);
    void reload();
  }

  async function save(jurisdictionId: string | null) {
    setError(null);
    try {
      await api(`/sites/${siteId}/jurisdiction`, {
        method: "PUT",
        body: jurisdictionId ? { jurisdictionId, evidenceKind, evidenceReference, evidenceNote: evidenceNote || null } : { jurisdictionId: null },
      });
      setEditing(false);
      setEvidenceReference("");
      setEvidenceNote("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  async function saveIdentifier(key: string, value: string) {
    if (!data?.jurisdiction) return;
    setError(null);
    try {
      await api(`/sites/${siteId}/authority-identifiers/${key}`, { method: "PUT", body: { jurisdictionId: data.jurisdiction.id, value: value.trim() || null, sourceNote: null } });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    }
  }

  if (!data) return null;
  const startEditing = () => {
    setChoice(data.source === "override" ? (data.jurisdiction?.id ?? "") : (data.candidates[0]?.id ?? ""));
    setEditing(true);
  };
  const chosen = list.data?.items.find((j) => j.id === choice) ?? data.candidates.find((j) => j.id === choice);
  return (
    <dl className="card details">
      <dt>Reports to</dt>
      <dd>
        {data.jurisdiction ? (
          <>
            {data.jurisdiction.authorityName}{" "}
            <span className="muted small">{data.source === "override" ? "(chosen by hand)" : "(from the county)"}</span>
            {data.profile?.status === "draft" && (
              <>
                {" "}
                <span className="badge warn" title="This authority's requirements are written from public pages and have open questions. Nothing is sent automatically.">
                  Draft requirements
                </span>
              </>
            )}
            {data.profile?.status === "fictional" && (
              <>
                {" "}
                <span className="badge inactive">Example rules</span>
              </>
            )}
          </>
        ) : (
          <span className="restriction">{data.reviewReason ?? `No authority matches${county ? ` ${county}` : " (no county set)"}.`} Filings for this site will need review.</span>
        )}
        {editable && !editing && (
          <>
            {" "}
            <button className="link" onClick={startEditing}>
              {data.jurisdiction ? "Change" : "Choose"}
            </button>
          </>
        )}
          {data.profile?.sourcesCheckedOn && (
            <p className="muted small">
              Requirements read from the authority&apos;s public sources on {day(data.profile.sourcesCheckedOn)}.{" "}
              {data.profile.requirementEffective?.date ? `In effect since ${day(data.profile.requirementEffective.date)}.` : "The authority does not publish when its requirement took effect."}
            </p>
          )}
        {data.assignment && (
          <p className="muted small">
            Based on: {AUTHORITY_EVIDENCE_LABELS[data.assignment.evidenceKind]}, {data.assignment.evidenceReference}
            {data.assignment.evidenceNote ? ` (${data.assignment.evidenceNote})` : ""}. {data.assignment.assignedBy ?? "Someone"}, {when(data.assignment.assignedAt)}.
          </p>
        )}
        {editing && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void save(choice || null);
            }}
          >
            <select aria-label="Reporting authority" value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Match from the county</option>
              {(list.data?.items ?? data.candidates).map((j) => (
                <option key={j.id} value={j.id}>
                  {j.authorityName}
                  {j.profileStatus === "draft" ? " (draft requirements)" : j.profileStatus === "fictional" ? " (example rules)" : ""}
                </option>
              ))}
            </select>
            {choice && (
              <>
                {chosen?.howToDecide && <p className="muted small">{chosen.howToDecide}</p>}
                <label>
                  What this is based on
                  <select value={evidenceKind} onChange={(e) => setEvidenceKind(e.target.value as EvidenceKind)}>
                    {AUTHORITY_EVIDENCE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {AUTHORITY_EVIDENCE_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  What you checked
                  <input required value={evidenceReference} onChange={(e) => setEvidenceReference(e.target.value)} placeholder="e.g. LCRA OSSF map, address inside the red area, checked today" />
                </label>
                <label>
                  Note (optional)
                  <input value={evidenceNote} onChange={(e) => setEvidenceNote(e.target.value)} />
                </label>
              </>
            )}
            <div className="row">
              <button type="submit" className="primary">
                Save
              </button>
              <button type="button" className="link" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
        {!data.jurisdiction && data.candidates.length > 0 && !editing && (
          <p className="muted small">May be: {data.candidates.map((c) => c.authorityName).join(", ")}. Check the authority&apos;s map or ask it, then choose it here with what you checked.</p>
        )}
        {error && <p className="error">{error}</p>}
      </dd>
      {data.identifiers.map((i) => (
        <IdentifierRow key={i.key} identifier={i} editable={editable} onSave={(v) => void saveIdentifier(i.key, v)} />
      ))}
      {data.profile && data.profile.unresolved.length > 0 && (
        <>
          <dt>Open questions</dt>
          <dd>
            <details>
              <summary className="small">{data.profile.unresolved.length} unresolved about this authority&apos;s requirements</summary>
              <ul className="small">
                {data.profile.unresolved.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </details>
          </dd>
        </>
      )}
    </dl>
  );
}

function IdentifierRow({ identifier: i, editable, onSave }: { identifier: SiteJurisdiction["identifiers"][number]; editable: boolean; onSave: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(i.value ?? "");
  return (
    <>
      <dt>{i.label}</dt>
      <dd>
        {editing ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              onSave(value);
              setEditing(false);
            }}
          >
            <input aria-label={i.label} value={value} onChange={(e) => setValue(e.target.value)} />
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" className="link" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            {i.value ?? <span className="restriction">Not recorded{i.required ? " (required for filing)" : ""}</span>}
            {editable && (
              <>
                {" "}
                <button className="link" onClick={() => setEditing(true)}>
                  {i.value ? "Change" : "Add"}
                </button>
              </>
            )}
          </>
        )}
        {i.problem && i.value && <p className="error small">{i.problem}</p>}
        {i.help && <p className="muted small">{i.help}</p>}
      </dd>
    </>
  );
}
