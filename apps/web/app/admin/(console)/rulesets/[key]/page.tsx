"use client";

import {
  ANSWER_OUTCOME_LABELS,
  ANSWER_OUTCOMES,
  EVIDENCE_CLASS_LABELS,
  EVIDENCE_KIND_LABELS,
  EVIDENCE_KINDS,
  QUESTION_STATE_LABELS,
  QUESTION_TOPIC_LABELS,
  QUESTION_TOPICS,
  VERIFICATION_METHODS,
  type EvidenceAnswer,
  type QuestionState,
  type RulesetEvidencePage,
  type RulesetProposal,
} from "@aerowise/domain";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { VerifiedBadge } from "@/components/FilingBadges";
import { useLoad } from "@/components/useLoad";
import { api, ApiError } from "@/lib/api";
import { day } from "@/lib/format";

const STATE_BADGE: Record<QuestionState, string> = {
  authority_confirmed: "ok",
  authority_partial: "upcoming",
  conflict: "danger",
  public_rule_settled: "completed",
  provider_evidence: "inactive",
  public_rule: "inactive",
  open: "warn",
};

function StateBadge({ state }: { state: QuestionState }) {
  return <span className={`badge ${STATE_BADGE[state]}`}>{QUESTION_STATE_LABELS[state]}</span>;
}

/** One recorded answer, with where it came from. Optionally selectable for a proposal. */
function Answer({ a, selected, onToggle }: { a: EvidenceAnswer; selected?: boolean; onToggle?: () => void }) {
  return (
    <li className="small">
      {onToggle && (
        <label className="check">
          <input type="checkbox" checked={selected} onChange={onToggle} /> Use in the next version
        </label>
      )}
      <strong>{ANSWER_OUTCOME_LABELS[a.outcome]}</strong> · {EVIDENCE_CLASS_LABELS[a.evidenceClass]} ({EVIDENCE_KIND_LABELS[a.kind].toLowerCase()}, {day(a.obtainedOn)}
      {a.contactName ? `, ${a.contactName}` : ""}
      {a.contactOrganization ? `, ${a.contactOrganization}` : ""})<div className="muted">Asked: {a.question}</div>
      <div>{a.answer}</div>
      {a.field && <div className="muted">Rule field: {a.field}</div>}
    </li>
  );
}

const blankAnswer = { question: "", unresolvedItem: "", topic: "report_channel", field: "", answer: "", outcome: "partial" };

function RecordEvidence({ page, onSaved }: { page: RulesetEvidencePage; onSaved: () => Promise<void> }) {
  const [answers, setAnswers] = useState([{ ...blankAnswer }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (i: number, k: keyof typeof blankAnswer, v: string) => setAnswers((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const get = (k: string) => String(f.get(k) ?? "").trim() || null;
    setError(null);
    setSaving(true);
    try {
      await api(`/admin/rulesets/${page.key}/evidence`, {
        method: "POST",
        body: {
          kind: get("kind"),
          obtainedOn: get("obtainedOn"),
          contactName: get("contactName"),
          contactRole: get("contactRole"),
          contactOrganization: get("contactOrganization"),
          contactDetail: get("contactDetail"),
          references: String(f.get("references") ?? "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          note: get("note"),
          answers: answers.map((a) => ({ ...a, unresolvedItem: a.unresolvedItem || null, field: a.field || null })),
        },
      });
      form.reset();
      setAnswers([{ ...blankAnswer }]);
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the evidence");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card stack" onSubmit={submit} aria-label="Record evidence">
      <h2>Record evidence</h2>
      <p className="muted small">Saving records what was said or read. It never changes the rules or marks the authority verified.</p>
      <div className="grid">
        <label>
          Kind
          <select name="kind" defaultValue="call">
            {EVIDENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {EVIDENCE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input name="obtainedOn" type="date" required max={page.today} />
        </label>
        <label>
          Contact name
          <input name="contactName" />
        </label>
        <label>
          Their title or office
          <input name="contactRole" />
        </label>
        <label>
          Authority or company they speak for
          <input name="contactOrganization" />
        </label>
        <label>
          Phone or email used
          <input name="contactDetail" />
        </label>
        <label className="wide">
          Where it is kept (one per line: URL and page, file name, email subject and date)
          <textarea name="references" rows={2} required />
        </label>
        <label className="wide">
          Note
          <textarea name="note" rows={2} />
        </label>
      </div>
      {answers.map((a, i) => (
        <fieldset key={i} className="stack answer-fields">
          <legend>Question {i + 1}</legend>
          <label>
            Question, exactly as asked or read
            <textarea rows={2} required value={a.question} onChange={(e) => set(i, "question", e.target.value)} />
          </label>
          <label>
            Open question it answers
            <select value={a.unresolvedItem} onChange={(e) => set(i, "unresolvedItem", e.target.value)}>
              <option value="">None of the listed ones</option>
              {page.unresolved.map((u) => (
                <option key={u.item} value={u.item}>
                  {u.item.length > 120 ? `${u.item.slice(0, 117)}…` : u.item}
                </option>
              ))}
            </select>
          </label>
          <div className="grid">
            <label>
              Topic
              <select value={a.topic} onChange={(e) => set(i, "topic", e.target.value)}>
                {QUESTION_TOPICS.map((t) => (
                  <option key={t} value={t}>
                    {QUESTION_TOPIC_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Rule field (optional)
              <input value={a.field} placeholder="e.g. filing.deadlineDays" onChange={(e) => set(i, "field", e.target.value)} />
            </label>
            <label>
              Outcome
              <select value={a.outcome} onChange={(e) => set(i, "outcome", e.target.value)}>
                {ANSWER_OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {ANSWER_OUTCOME_LABELS[o]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Answer
            <textarea rows={2} required value={a.answer} onChange={(e) => set(i, "answer", e.target.value)} />
          </label>
          {answers.length > 1 && (
            <button type="button" className="link" onClick={() => setAnswers((xs) => xs.filter((_, j) => j !== i))}>
              Remove question {i + 1}
            </button>
          )}
        </fieldset>
      ))}
      <div className="row">
        <button type="button" className="secondary" onClick={() => setAnswers((xs) => [...xs, { ...blankAnswer }])}>
          Add another question
        </button>
        <span className="spacer" />
        <button type="submit" disabled={saving}>
          Save evidence
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Proposal({ page, selected }: { page: RulesetEvidencePage; selected: string[] }) {
  const [verify, setVerify] = useState(false);
  const [result, setResult] = useState<RulesetProposal | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? "").trim();
    setError(null);
    try {
      setResult(
        await api<RulesetProposal>(`/admin/rulesets/${page.key}/proposal`, {
          method: "POST",
          body: {
            answerIds: selected,
            effectiveFrom: get("effectiveFrom"),
            verification: verify ? { confirmedWith: get("confirmedWith"), confirmedBy: get("confirmedBy"), confirmedOn: get("confirmedOn"), method: get("method"), evidence: get("evidence") } : null,
          },
        }),
      );
    } catch (err) {
      setResult(null);
      setError(err instanceof ApiError ? err.message : "Could not prepare the next version");
    }
  }

  return (
    <form className="card stack" onSubmit={submit} aria-label="Prepare the next version">
      <h2>Prepare the next version</h2>
      <p className="muted small">
        Builds v{page.version + 1} from the answers ticked above ({selected.length} ticked) and shows the diff. Nothing is published: the file goes into a pull request that Justin reviews. An
        open question closes on the authority&apos;s own settling answer, or on a cited published rule for a question about what the rules say (never an acceptance question). The version is proposed as verified only when nothing is left open and the authority has confirmed every acceptance question.
      </p>
      <label>
        Starts applying on
        <input name="effectiveFrom" type="date" required defaultValue={page.today} min={page.effectiveFrom} />
      </label>
      <label className="check">
        <input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> Propose as verified (needs the full verification record)
      </label>
      {verify && (
        <div className="grid">
          <label>
            Confirmed with (name and title at the authority)
            <input name="confirmedWith" required />
          </label>
          <label>
            Confirmed by
            <input name="confirmedBy" required />
          </label>
          <label>
            Confirmed on
            <input name="confirmedOn" type="date" required max={page.today} />
          </label>
          <label>
            How
            <select name="method" defaultValue="email">
              {VERIFICATION_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="wide">
            Where the confirmation is kept
            <input name="evidence" required />
          </label>
        </div>
      )}
      <button type="submit">Prepare v{page.version + 1}</button>
      {error && <p className="error">{error}</p>}
      {result && (
        <section className="stack" aria-label="Proposed version">
          <p>
            <strong>{result.filePath}</strong> — {result.verified ? <span className="badge ok">Proposed as verified</span> : <span className="badge warn">Stays a draft</span>}
          </p>
          {result.closes.length > 0 && (
            <div>
              Closes:
              <ul className="small">
                {result.closes.map((c) => (
                  <li key={c.item}>{c.item}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            Still open: {result.stillOpen.length === 0 && <span className="muted">none</span>}
            <ul className="small">
              {result.stillOpen.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </div>
          {result.ruleChanges.length > 0 && (
            <div>
              Rules to change by hand in the pull request:
              <ul className="small">
                {result.ruleChanges.map((c) => (
                  <li key={c.answerId}>
                    {c.field ?? "(no field named)"}: {c.answer}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.refusals.length > 0 && (
            <ul className="small error">
              {result.refusals.map((r, i) => (
                <li key={i}>{r.reason}</li>
              ))}
            </ul>
          )}
          {result.diff ? <pre className="diff small">{result.diff}</pre> : <p className="muted">No change from v{result.fromVersion}.</p>}
          <details>
            <summary className="small">The whole v{result.version} file</summary>
            <pre className="file small">{result.json}</pre>
          </details>
        </section>
      )}
    </form>
  );
}

/** One authority: what is still open, what has been answered and by whom, and the next version. */
export default function AuthorityEvidencePage() {
  const { key } = useParams<{ key: string }>();
  const { data, error, reload } = useLoad<RulesetEvidencePage>(`/admin/rulesets/${key}`);
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <p className="small">
        <Link href="/admin/rulesets">← Ruleset coverage</Link>
      </p>
      <h1>{data.authorityName}</h1>
      <p className="row">
        {data.verified ? (
          <VerifiedBadge verified={data.verified} />
        ) : data.profileStatus === "draft" ? (
          <span className="badge warn">Draft</span>
        ) : (
          <span className="badge inactive">Example rules</span>
        )}
        <span className="muted small">
          {data.key} · newest v{data.version} from {day(data.effectiveFrom)} · {data.versionInForce ? `v${data.versionInForce} in force today` : "no version in force today"}
        </span>
      </p>
      {data.profileStatus !== "fictional" && (
        <p className="row">
          <a className="button secondary" href={`/api/admin/rulesets/${data.key}/call-sheet.pdf`} target="_blank" rel="noreferrer">
            Call sheet (PDF)
          </a>
          <span className="muted small">Open and acceptance questions with the dated evidence below, and room for who was asked, when and what they said. Use only when this authority governs a selected pilot&apos;s permits; it adds no contact details and confirms nothing.</span>
        </p>
      )}

      <section className="card stack" aria-label="Acceptance questions">
        <h2>Acceptance questions</h2>
        <p className="muted small">Only the authority can answer these. A published rule or a provider&apos;s past accepted report is shown as support, never as the authority&apos;s acceptance.</p>
        <table>
          <tbody>
            {data.acceptance.map((x) => (
              <tr key={x.topic}>
                <td>{x.label}</td>
                <td>
                  <StateBadge state={x.state} />
                </td>
                <td className="small">{x.answers[0] ? `${x.answers[0].answer} (${day(x.answers[0].obtainedOn)})` : <span className="muted">Nothing recorded</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="stack" aria-label="Open questions">
        <h2>Open questions in v{data.version}</h2>
        {data.unresolved.length === 0 && <p className="muted">None.</p>}
        {data.unresolved.map((u) => (
          <article key={u.item} className="card stack">
            <div className="row">
              <StateBadge state={u.state} />
            </div>
            <p>{u.item}</p>
            {u.answers.length > 0 && (
              <ul className="stack">
                {u.answers.map((a) => (
                  <Answer key={a.id} a={a} selected={selected.includes(a.id)} onToggle={() => toggle(a.id)} />
                ))}
              </ul>
            )}
          </article>
        ))}
        {data.otherAnswers.length > 0 && (
          <details className="card">
            <summary>
              {data.otherAnswers.length} answer{data.otherAnswers.length === 1 ? "" : "s"} not tied to a current open question
            </summary>
            <ul className="stack">
              {data.otherAnswers.map((a) => (
                <Answer key={a.id} a={a} selected={selected.includes(a.id)} onToggle={() => toggle(a.id)} />
              ))}
            </ul>
          </details>
        )}
      </section>

      {data.profileStatus !== "fictional" && <Proposal page={data} selected={selected} />}

      <RecordEvidence page={data} onSaved={reload} />

      <section className="stack" aria-label="Evidence">
        <h2>Evidence recorded</h2>
        {data.evidence.length === 0 && <p className="muted">Nothing recorded yet.</p>}
        {data.evidence.map((e) => (
          <article key={e.id} className="card stack">
            <div className="row">
              <strong>{EVIDENCE_KIND_LABELS[e.kind]}</strong>
              <span className="badge inactive">{EVIDENCE_CLASS_LABELS[e.evidenceClass]}</span>
              <span className="spacer" />
              <span className="muted small">
                {day(e.obtainedOn)} · recorded by {e.recordedBy} against v{e.rulesetVersion}
              </span>
            </div>
            {(e.contactName || e.contactOrganization) && <p className="small">{[e.contactName, e.contactRole, e.contactOrganization, e.contactDetail].filter(Boolean).join(" · ")}</p>}
            <ul className="small">
              {e.references.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            {e.note && <p className="small">{e.note}</p>}
            <p className="muted small">
              {e.answers.length} question{e.answers.length === 1 ? "" : "s"}: {e.answers.map((a) => QUESTION_TOPIC_LABELS[a.topic]).join(", ")}
            </p>
          </article>
        ))}
      </section>
    </div>
  );
}
