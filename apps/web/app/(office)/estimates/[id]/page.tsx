"use client";

import { estimateTotals, isEstimateOpen, selectedLines, type EstimateDetail, type EstimateLine } from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useImperativeHandle, useRef, useState, type FormEvent, type Ref } from "react";
import { DepositPanel } from "@/components/DepositPanel";
import { blankLine, EstimateLineEditor, fromSaved, toInput, type DraftLine } from "@/components/EstimateLineEditor";
import { LoadState } from "@/components/LoadState";
import { StatusBadge } from "@/components/StatusBadge";
import { FormError, SubmitButton } from "@/components/SubmitButton";
import { useLoad } from "@/components/useLoad";
import { useSubmit } from "@/components/useSubmit";
import { useUnsavedChanges } from "@/components/useUnsavedChanges";
import { api, formValues, Refusal } from "@/lib/api";
import { day, money, quantity, when } from "@/lib/format";
import { useFeature } from "@/lib/features";
import { canEdit, useSession } from "@/lib/session";
import { usePageTitle } from "@/lib/title";

type Totals = EstimateDetail["draft"]["totals"];

function sourceHref(e: EstimateDetail) {
  if (e.source.kind === "inspection_issue") return "/inbox";
  if (e.source.kind === "portal_request") return `/sites/${e.site.id}`;
  return null;
}

const qty = (l: EstimateLine) => quantity(l.quantityMilli / 1000);

/** A sent version's lines and totals, read-only. */
function LinesTable({ lines, totals, chosen, depositCents }: { lines: EstimateLine[]; totals: Totals; chosen?: string[] | null; depositCents?: number | null }) {
  const included = new Set(selectedLines(lines, chosen).map((l) => l.id));
  return (
    <div className="table-scroll">
      <table className="compact stack">
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
              <td data-label="Description">
                {l.description}
                {l.optional && <span className="muted small"> · optional{chosen !== undefined ? (included.has(l.id) ? ", chosen" : ", left out") : l.selectedByDefault ? ", starts chosen" : ""}</span>}
                {l.taxable && <span className="muted small"> · taxable</span>}
              </td>
              <td data-label="Qty" className="num">
                {qty(l)}
              </td>
              <td data-label="Unit price" className="num">
                {money(l.unitPriceCents)}
              </td>
              <td data-label="Amount" className="num">
                {money(l.amountCents)}
              </td>
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

/** What the page asks of the open draft before sending it: save what is typed, or say why not. */
interface DraftHandle {
  /** Saves the edits on screen, if there are any. False when the form refuses them (the reason is shown). */
  saveEdits: () => Promise<boolean>;
}

/**
 * The draft as typed. Sending, marking sent and recording acceptance act on what is on screen:
 * the page asks this editor to save its edits first, so nothing typed is ever left out of what
 * the customer gets.
 */
function DraftEditor({ e, onSaved, handle, onDirty }: { e: EstimateDetail; onSaved: () => Promise<void>; handle: Ref<DraftHandle>; onDirty: (dirty: boolean) => void }) {
  const [lines, setLinesState] = useState<DraftLine[]>(() => (e.draft.lines.length ? e.draft.lines.map(fromSaved) : [blankLine()]));
  const [dirty, setDirtyState] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  // An existing deposit stays editable (and clearable) with the feature off.
  const deposits = useFeature("deposits") || e.draft.depositCents !== null;
  useUnsavedChanges(dirty);
  const setDirty = (next: boolean) => {
    setDirtyState(next);
    onDirty(next);
  };
  const setLines = (next: DraftLine[]) => {
    setLinesState(next);
    setDirty(true);
  };

  /** PATCHes the draft from the form; throws what the API refused. */
  async function persist(): Promise<boolean> {
    const f = form.current!;
    if (!f.reportValidity()) return false;
    const parsed = toInput(lines);
    if ("error" in parsed) throw new Refusal(parsed.error);
    const v = formValues(f);
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
    setDirty(false);
    return true;
  }

  const save = useSubmit(
    async () => {
      if (await persist()) await onSaved();
    },
    { fallback: "Could not save the draft." },
  );
  useImperativeHandle(handle, () => ({ saveEdits: async () => (dirty ? persist() : true) }));

  return (
    <form ref={form} className="card stack" onSubmit={(ev) => (ev.preventDefault(), void save.run())} onChange={() => setDirty(true)}>
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
      <FormError error={save.error} />
      <div className="row">
        <SubmitButton className="secondary" busy={save.busy}>
          Save draft
        </SubmitButton>
        {dirty && (
          <span className="muted small" data-testid="draft-unsaved">
            Not saved yet. Sending saves these changes first.
          </span>
        )}
      </div>
    </form>
  );
}

export default function EstimatePage() {
  const { id } = useParams<{ id: string }>();
  const editable = canEdit(useSession());
  const recordLoad = useLoad<EstimateDetail>(`/estimates/${id}`);
  const { data: e, reload } = recordLoad;
  const [link, setLink] = useState<string | null>(null);
  const [panel, setPanel] = useState<"void" | "record" | "cancel" | null>(null);
  const [recordChosen, setRecordChosen] = useState<string[] | null>(null);
  const draft = useRef<DraftHandle>(null);
  usePageTitle(e ? `${e.label} · ${e.title}` : null);

  /** Saves the draft's edits first when it is a draft, so what goes out is what is on screen. */
  async function saveDraftFirst() {
    return e?.status !== "draft" || !draft.current || (await draft.current.saveEdits());
  }
  // Which button is on its way, so only that one says so.
  const [pending, setPending] = useState<string | null>(null);
  const action = useSubmit(
    async (path: string, body: unknown, saveFirst = false) => {
      // Withdrawing or cancelling never needs the draft's edits (and a half-typed line must not block it).
      if (saveFirst && !(await saveDraftFirst())) return false;
      try {
        await api(path, { method: "POST", body });
        setPanel(null);
        return true;
      } finally {
        // The draft may have been saved even when the action was refused.
        await reload();
      }
    },
    { fallback: "Could not save." },
  );
  const linking = useSubmit(
    async () => {
      const r = await api<{ url: string }>(`/estimates/${id}/link`, { method: "POST", body: {} });
      setLink(r.url);
      await navigator.clipboard?.writeText(r.url).catch(() => undefined);
    },
    { fallback: "Could not make a link." },
  );
  // Recording acceptance on a draft records the saved lines, so it saves the edits first too.
  const openRecord = useSubmit(
    async () => {
      if (panel === "record") return setPanel(null);
      if (!(await saveDraftFirst())) return;
      if (e?.status === "draft") await reload();
      setRecordChosen(null);
      setPanel("record");
    },
    { fallback: "Could not save the draft." },
  );
  const busy = action.busy || openRecord.busy;
  const problem = action.error ?? linking.error ?? openRecord.error;

  if (!e) return <LoadState load={recordLoad} label="estimate" back={{ href: "/estimates", label: "Estimates" }} />;
  const href = sourceHref(e);
  const latest = e.versions[e.versions.length - 1] ?? null;
  const open = isEstimateOpen(e.status);
  // What the office records the customer agreeing to: the version they were sent, or the draft.
  const recordLines = e.status === "draft" ? e.draft.lines : (latest?.lines ?? []);
  const recordDefault = recordLines.filter((l) => l.optional && l.selectedByDefault).map((l) => l.id);
  const chosenForRecord = recordChosen ?? recordDefault;
  const recordTotals = e.status === "draft" ? estimateTotals(recordLines, e.draft.discountCents, e.draft.taxRateBps, chosenForRecord) : latest ? estimateTotals(recordLines, latest.discountCents, latest.taxRateBps, chosenForRecord) : null;
  /** Sending acts on what is on screen, so it saves the draft's edits first. */
  const send = (email: boolean) => () => {
    setPending(email ? "email" : "mark");
    void action.run(`/estimates/${e.id}/send`, { email }, true);
  };
  const act = (path: string, body: unknown) => () => {
    setPending(path);
    void action.run(path, body);
  };
  const submitWith = (fn: (v: Record<string, string | undefined>) => unknown) => (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    fn(formValues(ev.currentTarget));
  };

  return (
    <div className="stack">
      <LoadState load={recordLoad} label="estimate" back={{ href: "/estimates", label: "Estimates" }} />
      <p>
        <Link href="/estimates">← Estimates</Link>
      </p>
      <div className="row">
        <h1>
          {e.label} · {e.title}
        </h1>
        <StatusBadge of="estimate" value={e.status} data-testid="estimate-status" />
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
            <dd className="row">
              <Link href={`/work/${e.workOrder.id}`}>{e.workOrder.label}</Link> <StatusBadge of="workOrder" value={e.workOrder.status} />
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

      <FormError error={problem} />

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

      {e.status === "draft" && editable && (
        <DraftEditor
          key={JSON.stringify(e.draft)}
          e={e}
          onSaved={reload}
          handle={draft}
          // A changed draft is not what the open acceptance form would record: ask again.
          onDirty={(dirty) => dirty && setPanel((p) => (p === "record" ? null : p))}
        />
      )}
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
              <SubmitButton type="button" busy={action.busy && pending === "email"} busyLabel="Sending…" onClick={send(true)} disabled={!e.canEmail || busy}>
                Send by email
              </SubmitButton>
              <SubmitButton type="button" className="secondary" busy={action.busy && pending === "mark"} busyLabel="Saving…" onClick={send(false)} disabled={busy}>
                Mark sent (share the link yourself)
              </SubmitButton>
            </>
          )}
          {open && (
            <>
              <SubmitButton type="button" className="secondary" busy={action.busy && pending === "email"} busyLabel="Sending…" onClick={send(true)} disabled={!e.canEmail || busy}>
                Email it again
              </SubmitButton>
              <SubmitButton type="button" className="secondary" busy={linking.busy} busyLabel="Making a link…" onClick={() => void linking.run()}>
                Copy a link
              </SubmitButton>
              <SubmitButton type="button" className="secondary" busy={action.busy && pending === `/estimates/${e.id}/revise`} onClick={act(`/estimates/${e.id}/revise`, {})} disabled={busy}>
                Revise
              </SubmitButton>
            </>
          )}
          {(e.status === "draft" || open) && (
            <>
              <SubmitButton type="button" className="secondary" busy={openRecord.busy} onClick={() => void openRecord.run()} disabled={action.busy}>
                Record acceptance
              </SubmitButton>
              <button type="button" className="secondary danger" disabled={busy} onClick={() => setPanel(panel === "void" ? null : "void")}>
                Withdraw
              </button>
            </>
          )}
          {e.status === "accepted" && (
            <button type="button" className="secondary danger" onClick={() => setPanel(panel === "cancel" ? null : "cancel")}>
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
        <form className="card stack" onSubmit={submitWith((v) => void action.run(`/estimates/${e.id}/void`, { reason: v.reason }))}>
          <label>
            Why withdraw it?
            <input name="reason" required maxLength={2000} />
          </label>
          <div>
            <SubmitButton className="danger" busy={action.busy}>
              Withdraw the estimate
            </SubmitButton>
          </div>
        </form>
      )}
      {panel === "record" && recordTotals && (
        <form
          className="card stack"
          onSubmit={submitWith((v) =>
            void action.run(`/estimates/${e.id}/record-acceptance`, { version: e.status === "draft" ? undefined : latest?.version, selectedOptionalLineIds: chosenForRecord, evidence: v.evidence }, true),
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
            Total accepted: <strong data-testid="record-total">{money(recordTotals.totalCents)}</strong>
          </p>
          {selectedLines(recordLines, chosenForRecord).length === 0 && <p className="error">Choose at least one item: the customer has to accept something.</p>}
          <label>
            How did they accept? (who, when, how)
            <textarea name="evidence" required rows={3} maxLength={4000} />
          </label>
          <div>
            <SubmitButton busy={action.busy} disabled={selectedLines(recordLines, chosenForRecord).length === 0}>
              Record acceptance and make the work order
            </SubmitButton>
          </div>
        </form>
      )}
      {panel === "cancel" && (
        <form className="card stack" onSubmit={submitWith((v) => void action.run(`/estimates/${e.id}/cancel`, { reason: v.reason }))}>
          <p className="muted small">Cancels the work order and its open visit. Work that has started or been invoiced cannot be cancelled here.</p>
          <label>
            Why cancel?
            <input name="reason" required maxLength={2000} />
          </label>
          <div>
            <SubmitButton className="danger" busy={action.busy}>
              Cancel the accepted work
            </SubmitButton>
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
