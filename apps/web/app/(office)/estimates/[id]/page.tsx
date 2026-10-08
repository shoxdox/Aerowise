"use client";

import { ESTIMATE_STATUS_LABELS, estimateTotals, isEstimateOpen, selectedLines, type EstimateDetail, type EstimateLine } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { DepositPanel } from "@/components/DepositPanel";
import { blankLine, estimateBadge, EstimateLineEditor, fromSaved, toInput, type DraftLine } from "@/components/EstimateLineEditor";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money, when } from "@/lib/format";
import { useFeature } from "@/lib/features";
import { canEdit, useSession } from "@/lib/session";

type Totals = EstimateDetail["draft"]["totals"];

function sourceHref(e: EstimateDetail) {
  if (e.source.kind === "inspection_issue") return "/inbox";
  if (e.source.kind === "portal_request") return `/sites/${e.site.id}`;
  return null;
}

const qty = (l: EstimateLine) => String(l.quantityMilli / 1000);

/** A sent version's lines and totals, read-only. */
function LinesTable({ lines, totals, chosen, depositCents }: { lines: EstimateLine[]; totals: Totals; chosen?: string[] | null; depositCents?: number | null }) {
  const included = new Set(selectedLines(lines, chosen).map((l) => l.id));
  return (
    <div className="table-scroll">
      <table className="compact">
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Unit price</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id} className={included.has(l.id) ? undefined : "muted"}>
              <td>
                {l.description}
                {l.optional && <span className="muted small"> · optional{chosen !== undefined ? (included.has(l.id) ? ", chosen" : ", left out") : l.selectedByDefault ? ", starts chosen" : ""}</span>}
                {l.taxable && <span className="muted small"> · taxable</span>}
              </td>
              <td className="num">{qty(l)}</td>
              <td className="num">{money(l.unitPriceCents)}</td>
              <td className="num">{money(l.amountCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {totals.discountCents > 0 && (
            <tr>
              <td colSpan={3}>Discount</td>
              <td className="num">−{money(totals.discountCents)}</td>
            </tr>
          )}
          {totals.taxCents > 0 && (
            <tr>
              <td colSpan={3}>Sales tax</td>
              <td className="num">{money(totals.taxCents)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={3}>
              <strong>Total{chosen === undefined ? " (with the options that start chosen)" : ""}</strong>
            </td>
            <td className="num">
              <strong data-testid="estimate-total">{money(totals.totalCents)}</strong>
            </td>
          </tr>
          {depositCents ? (
            <tr>
              <td colSpan={3}>Deposit on acceptance</td>
              <td className="num">{money(Math.min(depositCents, totals.totalCents))}</td>
            </tr>
          ) : null}
        </tfoot>
      </table>
    </div>
  );
}

function DraftEditor({ e, onSaved, onError }: { e: EstimateDetail; onSaved: () => Promise<void>; onError: (m: string | null) => void }) {
  const [lines, setLines] = useState<DraftLine[]>(() => (e.draft.lines.length ? e.draft.lines.map(fromSaved) : [blankLine()]));
  const [busy, setBusy] = useState(false);
  // An existing deposit stays editable (and clearable) with the feature off.
  const deposits = useFeature("deposits") || e.draft.depositCents !== null;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    const parsed = toInput(lines);
    if ("error" in parsed) return onError(parsed.error);
    setBusy(true);
    onError(null);
    try {
      await api(`/estimates/${e.id}`, {
        method: "PATCH",
        body: {
          title: v.title,
          lines: parsed.lines,
          discountCents: Math.round(Number(v.discount || "0") * 100),
          taxRateBps: Math.round(Number(v.taxRate || "0") * 100),
          termsText: v.terms ?? "",
          expiresOn: v.expiresOn || null,
          ...(deposits ? { depositCents: Number(v.deposit) > 0 ? Math.round(Number(v.deposit) * 100) : null } : {}),
        },
      });
      await onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Could not save the draft");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" onSubmit={save}>
      <h2>Draft{e.currentVersion > 1 ? ` of version ${e.currentVersion}` : ""}</h2>
      <label>
        Title
        <input name="title" defaultValue={e.title} required maxLength={200} />
      </label>
      <EstimateLineEditor lines={lines} onChange={setLines} />
      <div className="row">
        <label>
          Discount ($)
          <input name="discount" type="number" min="0" step="0.01" defaultValue={(e.draft.discountCents / 100).toFixed(2)} />
        </label>
        <label>
          Sales tax (%)
          <input name="taxRate" type="number" min="0" max="25" step="0.01" defaultValue={(e.draft.taxRateBps / 100).toFixed(2)} />
        </label>
        <label>
          Good until
          <input name="expiresOn" type="date" defaultValue={e.draft.expiresOn ?? ""} />
        </label>
        {deposits && (
          <label>
            Deposit ($) <span className="muted small">(paid on acceptance; blank for none)</span>
            <input name="deposit" type="number" min="0" step="0.01" defaultValue={e.draft.depositCents ? (e.draft.depositCents / 100).toFixed(2) : ""} />
          </label>
        )}
      </div>
      <label>
        Terms the customer agrees to
        <textarea name="terms" rows={4} maxLength={10000} defaultValue={e.draft.termsText} />
      </label>
      <div>
        <button type="submit" className="secondary" disabled={busy}>
          Save draft
        </button>
      </div>
    </form>
  );
}

export default function EstimatePage() {
  const { id } = useParams<{ id: string }>();
  const editable = canEdit(useSession());
  const { data: e, error, reload } = useLoad<EstimateDetail>(`/estimates/${id}`);
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [panel, setPanel] = useState<"void" | "record" | "cancel" | null>(null);
  const [recordChosen, setRecordChosen] = useState<string[] | null>(null);

  async function act(path: string, body: unknown) {
    setProblem(null);
    try {
      await api(path, { method: "POST", body });
      setPanel(null);
      await reload();
      return true;
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not save");
      return false;
    }
  }
  async function makeLink() {
    setProblem(null);
    try {
      const r = await api<{ url: string }>(`/estimates/${id}/link`, { method: "POST", body: {} });
      setLink(r.url);
      await navigator.clipboard?.writeText(r.url).catch(() => undefined);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : "Could not make a link");
    }
  }
  const submitWith = (fn: (v: Record<string, string | undefined>) => Promise<boolean>) => async (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    await fn(formValues(ev.currentTarget));
  };

  if (error) return <p className="error">{error}</p>;
  if (!e) return <p className="muted">Loading…</p>;
  const href = sourceHref(e);
  const latest = e.versions[e.versions.length - 1] ?? null;
  const open = isEstimateOpen(e.status);
  // What the office records the customer agreeing to: the version they were sent, or the draft.
  const recordLines = e.status === "draft" ? e.draft.lines : (latest?.lines ?? []);
  const recordDefault = recordLines.filter((l) => l.optional && l.selectedByDefault).map((l) => l.id);
  const chosenForRecord = recordChosen ?? recordDefault;
  const recordTotals = e.status === "draft" ? estimateTotals(recordLines, e.draft.discountCents, e.draft.taxRateBps, chosenForRecord) : latest ? estimateTotals(recordLines, latest.discountCents, latest.taxRateBps, chosenForRecord) : null;

  return (
    <div className="stack">
      <p>
        <Link href="/estimates">← Estimates</Link>
      </p>
      <div className="row">
        <h1>
          {e.label} · {e.title}
        </h1>
        <span className={`badge ${estimateBadge(e.status)}`} data-testid="estimate-status">
          {ESTIMATE_STATUS_LABELS[e.status]}
        </span>
        {e.currentVersion > 1 && <span className="muted small">version {e.currentVersion}</span>}
      </div>
      <dl className="details">
        <dt>Customer</dt>
        <dd>{e.customer.displayName}</dd>
        <dt>Site</dt>
        <dd>
          <Link href={`/sites/${e.site.id}`}>
            {e.site.addressLine1}, {e.site.city}
          </Link>
        </dd>
        <dt>From</dt>
        <dd>{href ? <Link href={href}>{e.source.label}</Link> : e.source.label}</dd>
        {e.workType && (
          <>
            <dt>Kind of work</dt>
            <dd>{e.workType.name}</dd>
          </>
        )}
        {e.expiresOn && (
          <>
            <dt>Good until</dt>
            <dd>{day(e.expiresOn)}</dd>
          </>
        )}
        {e.workOrder && (
          <>
            <dt>Work order</dt>
            <dd>
              <Link href={`/work/${e.workOrder.id}`}>{e.workOrder.label}</Link> <span className="muted">· {e.workOrder.status}</span>
            </dd>
          </>
        )}
        {e.declinedReason && (
          <>
            <dt>Declined</dt>
            <dd>{e.declinedReason}</dd>
          </>
        )}
        {e.voidReason && (
          <>
            <dt>Withdrawn</dt>
            <dd>{e.voidReason}</dd>
          </>
        )}
        {e.cancelReason && (
          <>
            <dt>Cancelled</dt>
            <dd>{e.cancelReason}</dd>
          </>
        )}
      </dl>

      {problem && <p className="error">{problem}</p>}

      {e.acceptance && (
        <div className="card stack" data-testid="estimate-acceptance">
          <h2>Accepted</h2>
          {e.acceptance.kind === "signature" ? (
            <p>
              Signed by {e.acceptance.signerName} ({e.acceptance.signatureKind === "drawn" ? "drawn signature" : "typed name"}) on {when(e.acceptance.at)}, version {e.acceptance.version}, for{" "}
              {money(e.acceptance.totals.totalCents)}.
            </p>
          ) : (
            <p>
              Recorded by {e.acceptance.recordedByName ?? "the office"} on {when(e.acceptance.at)}, version {e.acceptance.version}, for {money(e.acceptance.totals.totalCents)}. Not an e-signature:{" "}
              {e.acceptance.evidence}
            </p>
          )}
          {e.acceptance.documentSha256 && <p className="muted small">Signed record fingerprint {e.acceptance.documentSha256.slice(0, 16)}…</p>}
          {(() => {
            const v = e.versions.find((x) => x.version === e.acceptance!.version);
            return v ? <LinesTable lines={v.lines} totals={e.acceptance.totals} chosen={e.acceptance.selectedOptionalLineIds} /> : null;
          })()}
        </div>
      )}

      {e.deposit && <DepositPanel deposit={e.deposit} onChange={reload} />}

      {e.status === "draft" && editable && <DraftEditor key={JSON.stringify(e.draft)} e={e} onSaved={reload} onError={setProblem} />}
      {e.status === "draft" && !editable && <LinesTable lines={e.draft.lines} totals={e.draft.totals} />}

      {!e.acceptance && e.status !== "draft" && latest && (
        <div className="card stack">
          <h2>
            Version {latest.version}, sent {when(latest.sentAt)}
          </h2>
          <LinesTable lines={latest.lines} totals={latest.totals} depositCents={latest.depositCents} />
        </div>
      )}

      {editable && (
        <div className="row">
          {e.status === "draft" && (
            <>
              <button onClick={() => void act(`/estimates/${e.id}/send`, { email: true })} disabled={!e.canEmail}>
                Send by email
              </button>
              <button className="secondary" onClick={() => void act(`/estimates/${e.id}/send`, { email: false })}>
                Mark sent (share the link yourself)
              </button>
            </>
          )}
          {open && (
            <>
              <button className="secondary" onClick={() => void act(`/estimates/${e.id}/send`, { email: true })} disabled={!e.canEmail}>
                Email it again
              </button>
              <button className="secondary" onClick={() => void makeLink()}>
                Copy a link
              </button>
              <button className="secondary" onClick={() => void act(`/estimates/${e.id}/revise`, {})}>
                Revise
              </button>
            </>
          )}
          {(e.status === "draft" || open) && (
            <>
              <button className="secondary" onClick={() => setPanel(panel === "record" ? null : "record")}>
                Record acceptance
              </button>
              <button className="secondary" onClick={() => setPanel(panel === "void" ? null : "void")}>
                Withdraw
              </button>
            </>
          )}
          {e.status === "accepted" && (
            <button className="secondary" onClick={() => setPanel(panel === "cancel" ? null : "cancel")}>
              Cancel the work
            </button>
          )}
        </div>
      )}
      {editable && (e.status === "draft" || open) && !e.canEmail && <p className="muted small">No email on file for this customer: mark it sent and share the link yourself, or add an email to the customer.</p>}
      {link && (
        <p className="small">
          Link for the customer (copied): <code data-testid="estimate-link">{link}</code>
        </p>
      )}

      {panel === "void" && (
        <form className="card stack" onSubmit={submitWith((v) => act(`/estimates/${e.id}/void`, { reason: v.reason }))}>
          <label>
            Why withdraw it?
            <input name="reason" required maxLength={2000} />
          </label>
          <div>
            <button type="submit">Withdraw the estimate</button>
          </div>
        </form>
      )}
      {panel === "record" && recordTotals && (
        <form
          className="card stack"
          onSubmit={submitWith((v) =>
            act(`/estimates/${e.id}/record-acceptance`, { version: e.status === "draft" ? undefined : latest?.version, selectedOptionalLineIds: chosenForRecord, evidence: v.evidence }),
          )}
        >
          <h2>Record the customer&apos;s acceptance</h2>
          <p className="muted small">For a paper signature or a phone approval. It is recorded as the office&apos;s note, never shown as the customer&apos;s e-signature.</p>
          {recordLines
            .filter((l) => l.optional)
            .map((l) => (
              <label key={l.id} className="check">
                <input
                  type="checkbox"
                  checked={chosenForRecord.includes(l.id)}
                  onChange={(ev) => setRecordChosen(ev.target.checked ? [...chosenForRecord, l.id] : chosenForRecord.filter((x) => x !== l.id))}
                />
                {l.description} · {money(l.amountCents)}
              </label>
            ))}
          <p>
            Total accepted: <strong>{money(recordTotals.totalCents)}</strong>
          </p>
          {selectedLines(recordLines, chosenForRecord).length === 0 && <p className="error">Choose at least one item: the customer has to accept something.</p>}
          <label>
            How did they accept? (who, when, how)
            <textarea name="evidence" required rows={3} maxLength={4000} />
          </label>
          <div>
            <button type="submit" disabled={selectedLines(recordLines, chosenForRecord).length === 0}>
              Record acceptance and make the work order
            </button>
          </div>
        </form>
      )}
      {panel === "cancel" && (
        <form className="card stack" onSubmit={submitWith((v) => act(`/estimates/${e.id}/cancel`, { reason: v.reason }))}>
          <p className="muted small">Cancels the work order and its open visit. Work that has started or been invoiced cannot be cancelled here.</p>
          <label>
            Why cancel?
            <input name="reason" required maxLength={2000} />
          </label>
          <div>
            <button type="submit">Cancel the accepted work</button>
          </div>
        </form>
      )}

      {e.versions.length > 1 && (
        <section className="stack">
          <h2>Versions</h2>
          {e.versions.map((v) => (
            <div key={v.version} className="card tight">
              <strong>Version {v.version}</strong> · sent {when(v.sentAt)} · {money(v.totals.totalCents)}
              {v.expiresOn && <span className="muted"> · good until {day(v.expiresOn)}</span>}
            </div>
          ))}
        </section>
      )}

      <section className="stack">
        <h2>History</h2>
        <ul className="timeline">
          {e.events.map((ev) => (
            <li key={ev.id}>
              <span className="muted small">{when(ev.occurredAt)}</span> {ev.summary}
              {ev.actorName && <span className="muted small"> · {ev.actorName}</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
