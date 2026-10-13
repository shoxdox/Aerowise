"use client";

import { applyRequirements, DEFAULT_TEMPLATE, validateInspection, visibleFields, type CoverageItem, type InspectionValue, type InspectionValues } from "@aerowise/domain";
import { useMemo, useState } from "react";
import { TemplateSections } from "@/components/forms/TemplateFields";
import { COVERAGE, TRY_IT } from "./copy";

const PREFERRED = "tx-williamson-county";
/** The form opens a few answers in, as a technician partway through a stop, not as a blank wall of fields. */
const STARTED: InspectionValues = { aerator: "pass", air_pressure: 4 };

/**
 * The inspection form and a county's rules, live on the marketing page: the same template the
 * phone runs and the same ruleset the office applies, with nothing sent anywhere. Photos and GPS
 * are left out, because they are taken on the phone.
 */
export function TryIt({ coverage }: { coverage: CoverageItem[] }) {
  const [key, setKey] = useState(() => (coverage.some((c) => c.key === PREFERRED) ? PREFERRED : coverage[0]?.key) ?? "");
  const [values, setValues] = useState<InspectionValues>(STARTED);
  const county = coverage.find((c) => c.key === key) ?? coverage[0];
  const def = useMemo(
    () => applyRequirements({ ...DEFAULT_TEMPLATE.definition, photos: [] }, county ? { requiredFields: county.rules.requiredFields, requiredPhotos: [] } : null),
    [county],
  );
  const fields = visibleFields(def, values);
  const problems = validateInspection(def, values, {});
  const labelOf = (fieldKey: string) => def.fields.find((f) => f.key === fieldKey)?.label ?? fieldKey;
  const onChange = (fieldKey: string, value: InspectionValue) => setValues((v) => ({ ...v, [fieldKey]: value }));
  if (!county) return null;
  const r = county.rules;
  const countyLabel = county.authorityName;
  const extra = r.requiredFields.map(labelOf);

  return (
    <div className="try">
      <div className="try-rules stack">
        <label>
          {TRY_IT.pick}
          <select value={county.key} onChange={(e) => setKey(e.target.value)} aria-label={TRY_IT.pick}>
            {coverage.map((c) => (
              <option key={c.key} value={c.key}>
                {c.authorityName} · {c.counties.join(", ")}
              </option>
            ))}
          </select>
        </label>
        <p className="badge warn">{county.status === "draft" ? "Public-source draft · authority verification pending" : "Authority-verified profile"}</p>
        <p className="muted small">{county.status === "draft" ? COVERAGE.draftNote : "The site's permit and system still determine applicability."} Unresolved requirements need confirmation; the values below do not establish acceptance of a report.</p>
        <dl className="rule-card" aria-label={`${countyLabel} rules`}>
          <dt>{TRY_IT.authority}</dt>
          <dd>{county.authorityName}</dd>
          <dt>{TRY_IT.visits}</dt>
          <dd>
            Every {r.intervalMonths} months
            {r.monitoredIntervalMonths && r.monitoredIntervalMonths !== r.intervalMonths ? `; every ${r.monitoredIntervalMonths} with electronic monitoring on record` : ""}
            {r.contractVisits ? "; counted from the contract's start date" : ""}.
          </dd>
          <dt>{TRY_IT.report}</dt>
          <dd>Profile value: within {r.reportDeadlineDays} days of the test. Confirm permit applicability before live use.</dd>
          <dt>{TRY_IT.goes}</dt>
          <dd>
            {county.filing === "email" && `Published inbox: ${r.destination}. Provider review and confirmed delivery configuration are required before sending.`}
            {county.filing === "portal" && "Prepared for you to upload on the authority's own page; Aerowise records the upload."}
            {county.filing === "prepared" && "No provider channel is published, so it is prepared for you to send as you do today, and the record is kept."}
          </dd>
          {extra.length > 0 && (
            <>
              <dt>{TRY_IT.extra}</dt>
              <dd>{extra.join(", ")}.</dd>
            </>
          )}
          {r.renewalDaysBeforePreviousEnd !== null && (
            <>
              <dt>{TRY_IT.renewal}</dt>
              <dd>{r.renewalDaysBeforePreviousEnd} days before the previous contract ends.</dd>
            </>
          )}
          {r.correctiveReportDays !== null && (
            <>
              <dt>{TRY_IT.corrective}</dt>
              <dd>A retest report within {r.correctiveReportDays} days.</dd>
            </>
          )}
        </dl>
        <div className={`card stack try-status${problems.length === 0 ? " ready" : ""}`} aria-live="polite" data-testid="try-status">
          {problems.length === 0 ? (
            <>
              <strong>{TRY_IT.ready(countyLabel)}</strong>
              <span className="muted small">{TRY_IT.readyNote}</span>
            </>
          ) : (
            <>
              <strong>{TRY_IT.needs(problems.length, countyLabel)}</strong>
              <ul>
                {problems.map((p) => (
                  <li key={p.key}>{p.label}</li>
                ))}
              </ul>
            </>
          )}
        </div>
        <p className="muted small">
          {TRY_IT.note}{" "}
          <button type="button" className="link" onClick={() => setValues(STARTED)}>
            {TRY_IT.reset}
          </button>
        </p>
      </div>
      <div className="phone-frame" aria-label={TRY_IT.formLabel}>
        <div className="tech-bar">
          <strong>Inspection</strong>
          <span className="spacer" />
          <span className="muted small">{countyLabel}</span>
        </div>
        <div className="tech-page inspection stack" data-testid="try-form">
          <TemplateSections fields={fields} values={values} problemFor={() => undefined} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}
