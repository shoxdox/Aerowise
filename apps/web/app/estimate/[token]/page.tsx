"use client";

import { estimateTotals, selectedLines, type PublicEstimate } from "@aerowise/domain";
import { useParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { SignaturePad } from "@/components/forms/SignaturePad";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money, when } from "@/lib/format";

type Version = NonNullable<PublicEstimate["version"]>;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="pay">
      <div className="pay-card">{children}</div>
    </main>
  );
}

function Totals({ totals, depositCents }: { totals: Version["totals"]; depositCents?: number | null }) {
  return (
    <dl className="details totals" style={{ marginLeft: 0 }}>
      <dt>Subtotal</dt>
      <dd>{money(totals.subtotalCents)}</dd>
      {totals.discountCents > 0 && (
        <>
          <dt>Discount</dt>
          <dd>−{money(totals.discountCents)}</dd>
        </>
      )}
      {totals.taxCents > 0 && (
        <>
          <dt>Sales tax</dt>
          <dd>{money(totals.taxCents)}</dd>
        </>
      )}
      <dt>
        <strong>Total</strong>
      </dt>
      <dd>
        <strong data-testid="estimate-total">{money(totals.totalCents)}</strong>
      </dd>
      {depositCents ? (
        <>
          <dt>Deposit due on acceptance</dt>
          <dd data-testid="estimate-deposit">{money(Math.min(depositCents, totals.totalCents))}</dd>
        </>
      ) : null}
    </dl>
  );
}

/** What a homeowner sees from the link in their estimate email. No sign-in: the link is the key. */
function EstimatePage() {
  const { token } = useParams<{ token: string }>();
  const { data: r, error, reload } = useLoad<PublicEstimate>(`/estimate/${token}`);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"typed" | "drawn">("typed");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [signer, setSigner] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);

  // Note the first time the link is opened (a person, not a mail scanner: this runs in the browser).
  useEffect(() => {
    void api(`/estimate/${token}/view`, { method: "POST", body: {} }).catch(() => undefined);
  }, [token]);

  if (error) {
    return (
      <Shell>
        <div className="card">
          <h1>Estimate not found</h1>
          <p>{error}</p>
        </div>
      </Shell>
    );
  }
  if (!r) return <p className="muted pad">Loading…</p>;

  const contact = [r.provider.phone, r.provider.email].filter(Boolean).join(" or ");
  const v = r.version;
  const optional = v?.lines.filter((l) => l.optional) ?? [];
  const picked = chosen ?? optional.filter((l) => l.selectedByDefault).map((l) => l.id);
  const totals = v ? estimateTotals(v.lines, v.discountCents, v.taxRateBps, picked) : null;
  // When every line is an option, at least one has to be chosen (the server refuses an empty one too).
  const nothingChosen = v ? selectedLines(v.lines, picked).length === 0 : false;
  const acceptable = (r.status === "sent" || r.status === "viewed") && v !== null;
  const reachUs = contact ? ` at ${contact}` : "";

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = formValues(event.currentTarget);
    if (mode === "drawn" && !drawn) {
      setFormError("Draw your signature in the box, or switch to typing your name.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await api(`/estimate/${token}/accept`, {
        method: "POST",
        body: {
          version: v!.version,
          selectedOptionalLineIds: picked,
          signerName: signer.trim(),
          signature: mode === "drawn" ? { kind: "drawn", image: drawn } : { kind: "typed" },
          agree: f.agree === "on",
        },
      });
      await reload();
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ApiError && (err.code === "estimate_revised" || err.code === "not_acceptable")) await reload();
      setFormError(err instanceof ApiError ? err.message : "Could not accept. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function decline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = formValues(event.currentTarget);
    setBusy(true);
    try {
      await api(`/estimate/${token}/decline`, { method: "POST", body: { reason: f.reason ?? null } });
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not send that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <div>
      <strong>{r.provider.name}</strong>
      <div className="muted small">
        Estimate {r.label} · {r.customerName} · {r.serviceAddress}
      </div>
    </div>
  );

  if (!acceptable) {
    const shown = r.accepted ? selectedLines(v?.lines ?? [], r.accepted.selectedOptionalLineIds) : [];
    return (
      <Shell>
        <div className="card stack" data-testid="estimate-outcome">
          {header}
          {r.status === "accepted" && r.accepted ? (
            <>
              <h1>Estimate accepted</h1>
              <p>
                Thank you{r.accepted.signerName ? `, ${r.accepted.signerName}` : ""}. You accepted {r.title} for {money(r.accepted.totals.totalCents)} on {when(r.accepted.at)}. {r.provider.name} will be in
                touch to schedule the work.
              </p>
              {r.deposit && (
                <p data-testid="estimate-deposit-status">
                  {r.deposit.payUrl ? (
                    <>
                      A deposit of {money(r.deposit.amountCents)} is due now; it comes off the final invoice.{" "}
                      <a className="button" href={r.deposit.payUrl}>
                        Pay the deposit
                      </a>
                    </>
                  ) : (
                    <>
                      {r.deposit.paymentStatus === "refunded"
                        ? `Your deposit of ${money(r.deposit.amountCents)} was refunded.`
                        : `Your deposit of ${money(r.deposit.amountCents)} is ${r.deposit.paymentStatus === "processing" ? "on its way" : "received"}. It comes off the final invoice.`}
                    </>
                  )}
                </p>
              )}
              <ul>
                {shown.map((l) => (
                  <li key={l.id}>
                    {l.description} · {money(l.amountCents)}
                  </li>
                ))}
              </ul>
            </>
          ) : r.status === "cancelled" ? (
            <>
              <h1>This work was cancelled</h1>
              <p>Contact {r.provider.name}{reachUs} with any questions.</p>
            </>
          ) : r.status === "declined" ? (
            <>
              <h1>Thanks for letting us know</h1>
              <p>You declined this estimate. If you change your mind, contact {r.provider.name}{reachUs}.</p>
            </>
          ) : r.status === "expired" ? (
            <>
              <h1>This estimate has expired</h1>
              <p>
                It was good until {v?.expiresOn ? day(v.expiresOn) : "its end date"}. Contact {r.provider.name}
                {reachUs} for an updated estimate.
              </p>
            </>
          ) : r.beingRevised ? (
            <>
              <h1>This estimate is being updated</h1>
              <p>{r.provider.name} is revising it. You will get a new link once it is ready.</p>
            </>
          ) : (
            <>
              <h1>This estimate was withdrawn</h1>
              <p>Contact {r.provider.name}{reachUs} with any questions.</p>
            </>
          )}
          {formError && <p className="error">{formError}</p>}
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="card stack">
        {header}
        <h1>{r.title}</h1>
        {v.expiresOn && <p>This estimate is good until {day(v.expiresOn)}.</p>}
        <div className="table-scroll">
          <table className="compact">
            <tbody>
              {v.lines
                .filter((l) => !l.optional)
                .map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.description}
                      {l.quantityMilli !== 1000 && (
                        <span className="muted small">
                          {" "}
                          · {l.quantityMilli / 1000} × {money(l.unitPriceCents)}
                        </span>
                      )}
                    </td>
                    <td className="num">{money(l.amountCents)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <form className="stack" onSubmit={accept}>
        {optional.length > 0 && (
          <div className="card stack">
            <h2>Options</h2>
            <p className="muted small">Tick the ones you want included.</p>
            {optional.map((l) => (
              <label key={l.id} className="addon">
                <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setChosen(e.target.checked ? [...picked, l.id] : picked.filter((x) => x !== l.id))} />
                <span>
                  {l.description} · {money(l.amountCents)}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="card stack">
          <h2>Total</h2>
          {totals && <Totals totals={totals} depositCents={v?.depositCents} />}
        </div>

        <div className="card stack">
          <h2>Accept this estimate</h2>
          <p className="agreement-text">{v.termsText}</p>
          <label>
            Your full name
            <input value={signer} onChange={(e) => setSigner(e.target.value)} required minLength={2} maxLength={200} autoComplete="name" />
          </label>
          <div className="choice-row" role="group" aria-label="How to sign">
            <button type="button" className={mode === "typed" ? undefined : "secondary"} onClick={() => setMode("typed")}>
              Type my name
            </button>
            <button type="button" className={mode === "drawn" ? undefined : "secondary"} onClick={() => setMode("drawn")}>
              Draw my signature
            </button>
          </div>
          {mode === "typed" ? (
            <div className="typed-signature" aria-label="Your signature">
              {signer}
            </div>
          ) : (
            <SignaturePad onChange={setDrawn} />
          )}
          <label className="check">
            <input type="checkbox" name="agree" required />
            {r.consentText}
          </label>
          {nothingChosen && <p className="error">Choose at least one item to accept this estimate.</p>}
          {formError && <p className="error">{formError}</p>}
          <button type="submit" className="big" disabled={busy || nothingChosen}>
            Accept for {totals ? money(totals.totalCents) : ""}
          </button>
        </div>
      </form>

      <div className="card stack">
        {declining ? (
          <form className="stack" onSubmit={decline}>
            <label>
              Not going ahead? Tell us why (optional)
              <input name="reason" maxLength={2000} />
            </label>
            <div className="row">
              <button type="submit" className="secondary" disabled={busy}>
                Decline the estimate
              </button>
              <button type="button" className="link" onClick={() => setDeclining(false)}>
                Never mind
              </button>
            </div>
          </form>
        ) : (
          <button className="link" onClick={() => setDeclining(true)}>
            I don&apos;t want this work
          </button>
        )}
      </div>
      {contact && (
        <p className="muted small">
          Questions? Contact {r.provider.name} at {contact}.
        </p>
      )}
    </Shell>
  );
}

export default function PublicEstimatePage() {
  return (
    <Suspense>
      <EstimatePage />
    </Suspense>
  );
}
