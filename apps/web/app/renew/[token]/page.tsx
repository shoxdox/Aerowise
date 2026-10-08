"use client";

import { invoiceTotals, validateInspection, visibleFields, type InspectionValues, type PublicRenewal, type ValidationProblem } from "@aerowise/domain";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { SignaturePad } from "@/components/forms/SignaturePad";
import { TemplateSections } from "@/components/forms/TemplateFields";
import { useLoad } from "@/components/useLoad";
import { api, ApiError, formValues } from "@/lib/api";
import { day, money, when } from "@/lib/format";

const FREQUENCY: Record<PublicRenewal["terms"]["billingFrequency"], string> = { annual: "once a year", semiannual: "twice a year", quarterly: "quarterly", monthly: "monthly" };

function Shell({ children, testMode }: { children: React.ReactNode; testMode?: boolean }) {
  return (
    <main className="pay">
      <div className="pay-card">
        {testMode && <p className="test-mode">Test mode: no real money moves.</p>}
        {children}
      </div>
    </main>
  );
}

/** What a homeowner sees from the link in their renewal email. No sign-in: the link is the key. */
function RenewPage() {
  const { token } = useParams<{ token: string }>();
  const justPaid = useSearchParams().get("paid") === "1";
  const { data: r, error, reload } = useLoad<PublicRenewal>(`/renew/${token}`);
  const [addonIds, setAddonIds] = useState<string[] | null>(null);
  const [optionKeys, setOptionKeys] = useState<string[] | null>(null);
  // Answers to the plan's intake questions (SW-8), checked like the API checks them.
  const [answers, setAnswers] = useState<InspectionValues>({});
  const [intakeProblems, setIntakeProblems] = useState<ValidationProblem[]>([]);
  const [mode, setMode] = useState<"typed" | "drawn">("typed");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [signer, setSigner] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);

  // Note the first time the link is opened (a person, not a mail scanner: this runs in the browser).
  useEffect(() => {
    void api(`/renew/${token}/view`, { method: "POST", body: {} }).catch(() => undefined);
  }, [token]);

  // After paying, the page waits for the payment to be confirmed.
  useEffect(() => {
    if (!justPaid || !r || r.status === "activated" || r.status === "needs_review") return;
    const timer = setTimeout(() => void reload(), 2000);
    return () => clearTimeout(timer);
  }, [justPaid, r, reload]);

  if (error) {
    return (
      <Shell>
        <div className="card">
          <h1>Renewal not found</h1>
          <p>{error}</p>
        </div>
      </Shell>
    );
  }
  if (!r) return <p className="muted pad">Loading…</p>;

  const contact = [r.provider.phone, r.provider.email].filter(Boolean).join(" or ");
  const chosen = addonIds ?? r.selectedAddonIds;
  const chosenAddons = r.addons.filter((a) => chosen.includes(a.id));
  // The plan's own options (SW-8): the required ones are always in.
  const picked = optionKeys ?? r.selectedOptionKeys;
  const chosenOptions = r.options.filter((o) => o.required || picked.includes(o.optionKey));
  const totals = invoiceTotals(
    [
      { quantity: 1, unitPriceCents: r.firstPaymentCents, taxable: false },
      ...[...chosenOptions, ...chosenAddons].map((a) => ({ quantity: 1, unitPriceCents: a.priceCents, taxable: a.taxable })),
    ],
    0,
    r.taxRateBps,
  );
  const signable = r.status === "upcoming" || r.status === "sent" || r.status === "viewed";

  async function sign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    if (mode === "drawn" && !drawn) {
      setFormError("Draw your signature in the box, or switch to typing your name.");
      return;
    }
    if (r!.intake) {
      const problems = validateInspection(r!.intake.definition, answers, {});
      setIntakeProblems(problems);
      if (problems.length) {
        setFormError("Answer the questions above before signing.");
        return;
      }
    }
    setBusy(true);
    setFormError(null);
    try {
      await api(`/renew/${token}/sign`, {
        method: "POST",
        body: {
          version: r!.version,
          contact: { email: v.email, phone: v.phone ?? null },
          addonIds: chosen,
          optionKeys: chosenOptions.map((o) => o.optionKey),
          intakeAnswers: answers,
          signerName: signer.trim(),
          signature: mode === "drawn" ? { kind: "drawn", image: drawn } : { kind: "typed" },
          agree: v.agree === "on",
        },
      });
      await reload();
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ApiError && err.code === "offer_changed") await reload();
      setFormError(err instanceof ApiError ? err.message : "Could not sign. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    setBusy(true);
    setFormError(null);
    try {
      const { url } = await api<{ url: string }>(`/renew/${token}/checkout`, { method: "POST", body: {} });
      window.location.href = url;
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Could not start the payment. Try again.");
      setBusy(false);
    }
  }

  async function decline(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const v = formValues(event.currentTarget);
    setBusy(true);
    try {
      await api(`/renew/${token}/decline`, { method: "POST", body: { reason: v.reason ?? null } });
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
        Maintenance plan renewal · {r.customerName} · {r.serviceAddress}
      </div>
    </div>
  );

  if (!signable) {
    return (
      <Shell testMode={r.testMode}>
        <div className="card stack">
          {header}
          {r.status === "activated" ? (
            <>
              <h1>You&apos;re renewed</h1>
              <p>
                Thank you, {r.signed?.signerName ?? r.customerName}. Your {r.terms.planName} plan continues from {day(r.newTermStartsOn ?? r.terms.startOn)} to {day(r.terms.endOn)}. We will be in touch
                to schedule your visits.
              </p>
              {r.pay && <p>Your invoice for {money(r.pay.amountDueCents)} is due on its terms. You can pay it any time from the invoice email.</p>}
            </>
          ) : r.pay ? (
            <>
              <h1>{justPaid ? "Confirming your payment" : "One last step"}</h1>
              {justPaid ? (
                <p>
                  Thanks! Your payment is being confirmed. This page updates once it is; bank transfers can take a few business days. If you paid by bank and are asked to
                  verify your account, <a href={r.pay.invoiceUrl}>your invoice page</a> shows how.
                </p>
              ) : (
                <>
                  <p>Your agreement is signed. Pay to start your new term on {day(r.terms.startOn)}.</p>
                  <div className="amount">{money(r.pay.amountDueCents)}</div>
                  {r.pay.canPayOnline ? (
                    <button className="big" onClick={() => void pay()} disabled={busy}>
                      Pay {money(r.pay.amountDueCents)} by card or bank
                    </button>
                  ) : (
                    <p className="muted">Online payment is not available.{contact && ` To pay, contact ${r.provider.name} at ${contact}.`}</p>
                  )}
                </>
              )}
            </>
          ) : r.status === "declined" ? (
            <>
              <h1>Thanks for letting us know</h1>
              <p>You chose not to renew. If you change your mind, contact {r.provider.name}{contact && ` at ${contact}`}.</p>
            </>
          ) : r.status === "expired" ? (
            <>
              <h1>This offer has ended</h1>
              <p>Contact {r.provider.name}{contact && ` at ${contact}`} to renew your plan.</p>
            </>
          ) : (
            <>
              <h1>Thank you</h1>
              <p>Your renewal is signed. {r.provider.name} will be in touch to finish it.</p>
            </>
          )}
          {formError && <p className="error">{formError}</p>}
          {r.signed && (
            <p className="muted small">
              Signed by {r.signed.signerName} on {when(r.signed.signedAt)}.{" "}
              {r.signed.pdfReady ? (
                <a href={`/api/renew/${token}/agreement.pdf`} target="_blank" rel="noreferrer">
                  Download your signed agreement
                </a>
              ) : (
                "A signed copy will be emailed to you."
              )}
            </p>
          )}
        </div>
      </Shell>
    );
  }

  return (
    <Shell testMode={r.testMode}>
      <div className="card stack">
        {header}
        <h1>Renew your maintenance plan</h1>
        <p>
          Your {r.currentTerm.planName} plan ends on {day(r.currentTerm.endOn)}. Renewing keeps your aerobic system inspected on schedule and your reports filed with the county.
        </p>
        <dl className="details">
          <dt>New term</dt>
          <dd>
            {day(r.terms.startOn)} to {day(r.terms.endOn)}
          </dd>
          <dt>Visits</dt>
          <dd>
            {r.terms.visitsPerTerm} maintenance visit{r.terms.visitsPerTerm === 1 ? "" : "s"}
          </dd>
          <dt>Price</dt>
          <dd>
            {money(r.terms.priceCents)} for the term
            {r.installments > 1 ? `, paid ${FREQUENCY[r.terms.billingFrequency]} (${money(r.firstPaymentCents)} each)` : ""}
          </dd>
        </dl>
      </div>

      <form className="stack" onSubmit={sign}>
        <div className="card stack">
          <h2>Your contact details</h2>
          <label>
            Email
            <input name="email" type="email" required defaultValue={r.contact.email ?? ""} autoComplete="email" />
          </label>
          <label>
            Phone
            <input name="phone" type="tel" defaultValue={r.contact.phone ?? ""} autoComplete="tel" />
          </label>
        </div>

        {r.cycles.length > 0 && (
          <div className="card stack" data-testid="renewal-cycles">
            <h2>Service included</h2>
            <ul className="plain">
              {r.cycles.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        {r.coverage.length > 0 && (
          <div className="card stack" data-testid="renewal-coverage">
            <h2>What your plan covers</h2>
            <ul className="plain">
              {r.coverage.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        {r.intake && signable && (
          <div className="stack" data-testid="renewal-intake">
            <h2>{r.intake.name}</h2>
            <TemplateSections
              fields={visibleFields(r.intake.definition, answers)}
              values={answers}
              problemFor={(key) => intakeProblems.find((p) => p.key === key)}
              onChange={(key, value) => setAnswers((a) => ({ ...a, [key]: value }))}
            />
          </div>
        )}

        {r.options.length > 0 && (
          <div className="card stack">
            <h2>Plan options</h2>
            {r.options.map((o) => (
              <label key={o.optionKey} className="addon">
                <input
                  type="checkbox"
                  checked={o.required || picked.includes(o.optionKey)}
                  disabled={o.required || !signable}
                  onChange={(e) => setOptionKeys(e.target.checked ? [...picked, o.optionKey] : picked.filter((x) => x !== o.optionKey))}
                />
                <span className="stack" style={{ gap: 0 }}>
                  <span>
                    {o.name} · {money(o.priceCents)}
                    {o.required ? " (included with this plan)" : ""}
                  </span>
                  {o.description && <span className="muted small">{o.description}</span>}
                </span>
              </label>
            ))}
          </div>
        )}

        {r.addons.length > 0 && (
          <div className="card stack">
            <h2>Add to your plan</h2>
            {r.addons.map((a) => (
              <label key={a.id} className="addon">
                <input
                  type="checkbox"
                  checked={chosen.includes(a.id)}
                  onChange={(e) => setAddonIds(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))}
                />
                <span className="stack" style={{ gap: 0 }}>
                  <span>
                    {a.name} · {money(a.priceCents)}
                  </span>
                  {a.description && <span className="muted small">{a.description}</span>}
                </span>
              </label>
            ))}
          </div>
        )}

        <div className="card stack">
          <h2>{r.payment === "pay_to_activate" ? "Due today" : "Your first invoice"}</h2>
          <dl className="details totals" style={{ marginLeft: 0 }}>
            <dt>{r.installments > 1 ? "First payment" : "Plan"}</dt>
            <dd>{money(r.firstPaymentCents)}</dd>
            {chosenOptions.map((o) => (
              <span key={o.optionKey} style={{ display: "contents" }}>
                <dt>{o.name}</dt>
                <dd>{money(o.priceCents)}</dd>
              </span>
            ))}
            {chosenAddons.map((a) => (
              <span key={a.id} style={{ display: "contents" }}>
                <dt>{a.name}</dt>
                <dd>{money(a.priceCents)}</dd>
              </span>
            ))}
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
              <strong>{money(totals.totalCents)}</strong>
            </dd>
          </dl>
        </div>

        <div className="card stack">
          <h2>Agreement</h2>
          <p className="agreement-text">{r.agreementText}</p>
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
          {mode === "typed" ? <div className="typed-signature" aria-label="Your signature">{signer}</div> : <SignaturePad onChange={setDrawn} />}
          <label className="check">
            <input type="checkbox" name="agree" required />
            {r.consentText}
          </label>
          {formError && <p className="error">{formError}</p>}
          <button type="submit" className="big" disabled={busy}>
            {r.payment === "pay_to_activate" && totals.totalCents > 0 ? "Sign and continue to payment" : "Sign and renew"}
          </button>
        </div>
      </form>

      <div className="card stack">
        {declining ? (
          <form className="stack" onSubmit={decline}>
            <label>
              Not renewing? Tell us why (optional)
              <input name="reason" maxLength={2000} />
            </label>
            <div className="row">
              <button type="submit" className="secondary" disabled={busy}>
                I don&apos;t want to renew
              </button>
              <button type="button" className="link" onClick={() => setDeclining(false)}>
                Never mind
              </button>
            </div>
          </form>
        ) : (
          <button className="link" onClick={() => setDeclining(true)}>
            I don&apos;t want to renew
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

export default function PublicRenewPage() {
  return (
    <Suspense>
      <RenewPage />
    </Suspense>
  );
}
