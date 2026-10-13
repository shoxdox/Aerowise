"use client";

import type { InspectionValues, TemplateField } from "@aerowise/domain";

export type LocalSaveState = "saving" | "saved" | "failed";
export function LocalSaveStatus({ state, retry }: { state: LocalSaveState; retry: () => void }) {
  return <p className={`small ${state === "failed" ? "error" : "muted"}`} role="status" aria-live="polite" data-testid="local-save-status">
    {state === "saving" ? "Saving locally… Keep this screen open until saved." : state === "failed" ? "Latest edits are not saved on this phone. Keep this screen open and retry." : "Saved on this phone. Office delivery is shown above."}
    {state === "failed" && <> <button type="button" className="link" onClick={retry}>Retry local save</button></>}
  </p>;
}
export const sectionId = (section: string) => `form-section-${section.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
export function FormNavigation({ fields, values, photoRequired, photoDone, actionLabel }: { fields: TemplateField[]; values: InspectionValues; photoRequired: number; photoDone: number; actionLabel: string }) {
  const required = fields.filter(f => f.required);
  const answered = required.filter(f => values[f.key] !== undefined && values[f.key] !== null && values[f.key] !== "").length;
  const sections = [...new Set(fields.map(f => f.section))];
  return <nav className="card stack form-navigation" aria-label="Form sections">
    <p className="small" role="status">{answered} of {required.length} required answers entered · {photoDone} of {photoRequired} required photos saved. Finish checks answer validity.</p>
    <div className="row">{[...sections, "Photos", actionLabel].map(section => <a key={section} href={`#${sectionId(section)}`} onClick={() => document.getElementById(sectionId(section))?.focus()}>{section}</a>)}</div>
  </nav>;
}
export function focusProblems() {
  const problems = document.querySelector<HTMLElement>(".problems");
  problems?.focus();
  problems?.scrollIntoView({ behavior: "smooth", block: "start" });
}
