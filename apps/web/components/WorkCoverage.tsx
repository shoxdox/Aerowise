"use client";

import type { WorkOrderCoverage } from "@aerowise/domain";
import { useState, type FormEvent } from "react";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";

const STATE_LABELS = { reserved: "applied", consumed: "used on the bill", released: "given back" } as const;

/**
 * What the site's contract covers for a work order (SW-8): its frozen coverage rules, how
 * much of each this term has used, and applying, declining or restoring it. Office only.
 */
export function WorkCoverage({ workOrderId, onChange }: { workOrderId: string; onChange?: () => void }) {
  const { data: c, reload } = useLoad<WorkOrderCoverage>(`/work-orders/${workOrderId}/coverage`);
  const [asking, setAsking] = useState<"decline" | "restore" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function act(path: string, body: unknown) {
    setProblem(null);
    try {
      await api(`/work-orders/${workOrderId}/coverage/${path}`, { method: "POST", body });
      setAsking(null);
      await reload();
      onChange?.();
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save");
    }
  }
  const withReason = (path: "decline" | "restore") => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void act(path, { reason: formValues(e.currentTarget).reason });
  };

  if (!c) return null;
  const reserved = c.rules.some((r) => r.use?.state === "reserved");
  const consumed = c.rules.some((r) => r.use?.state === "consumed");
  return (
    <section className="stack" data-testid="work-coverage">
      <h2>Plan coverage</h2>
      {c.contract && (
        <p>
          <strong>{c.contract.planName}</strong>
          {c.contract.planVersion !== null && <span className="muted"> · version {c.contract.planVersion}</span>}
          <span className="muted">
            {" "}
            · {c.contract.startOn} to {c.contract.endOn}
          </span>
        </p>
      )}
      {c.notice && <p className="muted">{c.notice}</p>}
      {c.rules.length > 0 && (
        <ul className="plain">
          {c.rules.map((r) => (
            <li key={r.id} className={r.matches ? "" : "muted"}>
              {r.summary}
              {r.limit !== null && (
                <span className="muted">
                  {" "}
                  · {r.used} of {r.limit} used this term
                </span>
              )}
              {r.use && <span className={`badge ${r.use.state === "released" ? "inactive" : "active"}`}>{STATE_LABELS[r.use.state]}</span>}
              {!r.use && r.matches && r.limit !== null && r.used >= r.limit && <span className="badge danger">limit reached</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        {c.canApply && <button onClick={() => void act("apply", {})}>Apply coverage</button>}
        {reserved && !consumed && (
          <button className="secondary" onClick={() => setAsking(asking === "decline" ? null : "decline")}>
            Don&apos;t apply coverage
          </button>
        )}
        {consumed && (
          <button className="secondary" onClick={() => setAsking(asking === "restore" ? null : "restore")}>
            Restore benefit
          </button>
        )}
      </div>
      {c.canApply && <p className="muted">Apply coverage before creating the invoice: an invoice made earlier stays at full price.</p>}
      {asking && (
        <form className="card grid" onSubmit={withReason(asking)}>
          <label className="wide">
            {asking === "decline" ? "Why it does not apply" : "Why the benefit goes back (for example, a refund)"}
            <input name="reason" required maxLength={2000} />
          </label>
          <div className="wide">
            <button type="submit">{asking === "decline" ? "Don't apply coverage" : "Restore benefit"}</button>
          </div>
        </form>
      )}
      {problem && <p className="error">{problem}</p>}
    </section>
  );
}
