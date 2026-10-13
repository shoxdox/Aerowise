# Homeowner, payment and portability evidence

Implementation on the isolated outreach branch, October 13, 2026. No real provider, email, payment, authority submission, customer import or real-company erasure was performed.

## Finding 20 — confirmation and terminal recovery

Baseline: invoice return copy promised updates but had no polling; renewal polling was unbounded and required the paid query flag. Independent review additionally reproduced original-link ACH reservations disappearing at zero payable balance and failed bank attempts staying “Confirming”.

Implemented: public reads time out after 15 seconds, confirmation polls at three-second intervals for at most 20 completed reads, and manual Refresh restarts the bounded check. Actual paid/closed/failure/verification states stop inappropriate polling. A signed original renewal link exposes payment confirmation independently of payable amount, including actual pending cents and bank verification; a confirmed failed attempt has explicit recovery. Existing checkout/webhook idempotency and signatures remain unchanged.

Evidence: targeted API batch passed 50/50 (exports, invoices, renewals, portal, org-erase). The added original-link renewal test exercises actual stand-in ACH pending, verification metadata and terminal failure. Production-browser invoice regressions passed for delayed card webhook, pending bank→paid, bounded checks/manual refresh and failed bank recovery. Final rebuilt full suite also includes an actual original-renewal-link browser case. No real card or bank account was used.

## Finding 22 — public link classes

Baseline: invoice/renewal/estimate errors were called not-found and portal offered replacement links for every failure. Reads could stall indefinitely.

Implemented: same-token bounded reads retain safe provider contact context for temporary failures, clear data on access failure, and never redirect homeowners to staff sign-in. Shared recovery distinguishes offline, stalled, temporary/server, rate-limit, missing, expired and revoked states. Retry is offered for transient failures; replacement-link recovery appears for ended/invalid account access. Portal expired/revoked responses are distinguished only after a valid token lookup; invoice revocation is distinguished only after signed-token verification. Invalid guesses still get no customer information.

Evidence: production-browser failure classification passed on all four page types; an actual issued invoice survived a stalled read, offline refresh and retry. Existing API tests verify invalid guesses, tenant isolation, portal expiration/revocation, invoice revocation and rate limits. Renewal/estimate expired offer states preserve provider contact and agreement/offer protections.

## Finding 27 — complete inventory, raw files and honest deletion

Baseline: export omitted raw inspection/work photos and generated work/disposal documents. It listed only a subset of customer business tables. Public copy implied complete export and near-total erasure. Review additionally found verification URLs in payments and active pay links embedded in original invoice PDFs.

Implemented: retained raw inspection/work/disposal photos, company logo, report/signature/invoice/contract/signed-document records, generated work summaries and full disposal log are exported. Business import, message, accounting-map and subscription metadata are included with explicit sensitive-column exclusions and bearer-link redaction. Staff and referenced versioned templates are derived JSON. Every tenant table must be included, derived or explicitly excluded; unknown new tables fail the export with an actionable inventory error. Manifest includes row counts, file sizes/SHA-256, asset identities, missing entries, redactions and exclusions. Export-safe invoice PDFs come from the frozen snapshot without a bearer pay link, record their source checksum/rendition, and leave original issued bytes unchanged. Signed/filed artifacts are not rewritten.

Evidence: populated fixture reconciles every included table against actual SQL row counts, independently inventories all tenant tables from information_schema, matches original retained photo bytes, generates readable PDF headers, verifies every archive checksum, detects an unavailable object and confirms portable PDF text excludes the known token while the stored original remains byte-identical. Owner-only/tenant isolation/read-only export tests and demo watermark/import refusal remain enforced. Disposable org-erasure tests passed; no real organization/storage namespace was deleted.

Limits: export is sequential and currently assembled in memory; the tested fixtures are bounded, not a guarantee for arbitrarily large archives or a frozen live database. Pause writes for final reconciliation. Object cleanup can fail after operational records are deleted; access remains disabled and the failure is audited for operator cleanup. Public drafts say this explicitly. Company tombstone/platform metadata, shared/anonymized users, devices, recipients and backups have separate retention. Repository 14/35-day backup defaults are not newly verified live operations. Owner/counsel retention and restore/deletion policy review remains pending.

## Commands and fixes

- TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_root_test pnpm --filter @aerowise/api exec vitest run test/exports.test.ts test/renewals.test.ts test/invoices.test.ts test/portal.test.ts test/org-erase.test.ts — 50 passed.
- Scoped ESLint for root public hooks/pages, exports/shared renderers and regression files — passed.
- Web/API/tasks typechecks — passed during implementation; final whole-workspace run recorded in OUTREACH-READINESS-REVIEW.md.
- Focused browser batches and final whole suite use the production build and disposable outreach_e2e_test. First batch homeowner 7/7 passed; expanded second batch homeowner 9/9 passed, including bounded/failure checks. An original-link renewal case was added after that batch and remains part of final validation.
- Fixed fixture errors: disposal uses PUT /disposal/loads/sync and its client ID for photos; unavailable object is simulated through the test store; embedded PDF text is checked with the existing PDF text extractor rather than searching compressed bytes. One accidentally overlapping root test invocation caused a deadlock; it was stopped and the isolated sequential rerun passed. No product workaround was introduced for that test orchestration error.

Final verified status depends on the final candidate's integrated checks below; these implementation checks do not establish release, real-phone or real-provider acceptance.
