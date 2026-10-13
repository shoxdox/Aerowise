# Office, owner and private-demo implementation evidence

Work branch: `codex/aerowise-outreach-readiness`. Historical review checkpoint: `42b3834`. This file records the Office/Owner/demo portion; the integrated report owns the complete 28-row matrix, final tested commit, screenshots and release decision. No deployment, real providers, outbound messages, real signatures/payments or real company data were used.

## Baseline and implementation

- **9 — Guided journey.** The story had populated reports, filings, invoices, renewals and work; the visitor entry landed in the generic Inbox and homeowner access required copying portal links. Added an optional five-step journey using the private tenant's actual named case, completed filing, exact obligation, current Tess stop, provider signing UI, unpaid invoice and direct populated homeowner/renewal portal entry. Role and actual expiry are shown. Step context persists per expiry. Moving, reassigning or completing the case's current stop produces a truthful fallback to the completed result and Tess's current route; opening the journey does not mutate assignments. Portal creation is explicit, tenant checked, sends nothing and caps link lifetime at company expiry. Permanent shared and real companies cannot use these endpoints. Existing personalized, expiring prospect demos retain their supported role switching.
- **10 — First action/setup.** Visitor and personalized prospect demos show the walkthrough instead of the real-provider checklist. Fictional seed has service counties; real requirements remain accessible and unchanged in their server gates. Owner/Office/Technician help starts collapsed, expandable in place. An inspection follow-up and work stop connect completed demo records to today's workload. Demo entry distinguishes availability failure, preparing, return to existing private demo and the known staging destination. Access expires after 24 hours; cleanup is described as eligible, not instantaneous deletion.
- **11 — Filing language.** Intro, list tabs, badges, empty state and detail distinguish preparation/provider signature, actual email/manual/CSV submission and recorded evidence. Submitted no longer universally means unfinished. No-published-acknowledgment detail says to retain submission proof, and explicitly does not assert acceptance. Existing server exclusion of no-published-acknowledgment alerts remains intact. Signed reports, packages, status transitions and evidence are preserved.
- **13 — Handoffs.** Inbox Due-this-week links include range 7 and upcoming-only, matching the count's exclusion of overdue; overdue links preserve that filter. Due service type/range/filters/page and money/work/estimate/filing/renewal views are URL backed with back/forward support. Due rows select exact obligations in Schedule; a targeted read can find a visit beyond the default 30-day/first-page slice. The selected card is highlighted without assignment mutation. Sites-with-expiring-contracts count and its filtered site destination share one tenant-scoped query. Sign-in return URLs preserve query state.
- **14 — Loading/failure/partial/stale.** Key lists, details and independent customer/site/report modules use a common loading/refresh/error/retry state. Reads abort after 20 seconds. Failed reads cannot produce successful-empty/all-clear states. Same-query stale data retains a timestamped warning; partial route/authority/module failures do not erase independent records. A failed Schedule company-date probe offers Retry instead of indefinite Loading.
- **15 — Query races.** `useLoad` associates results with the full requested path, immediately hides data belonging to another path, aborts superseded requests and ignores earlier request IDs. Same-query reload keeps existing data with an accurate refreshing/stale state. Invoice and service-type filters therefore cannot relabel older data while delayed, failed or out of order.
- **16 — Operational onboarding.** Checklist covers company/provider, licensed inspectors, service counties, customer, site, current evidence-backed authority applicability, active contract, scheduled visit and reviewed/signed report. Stripe/QuickBooks are optional. Office receives owner-directed text for owner-only setup instead of inaccessible links. Current applicability requires the site's current assignment, matching jurisdiction, evidence and a currently resolved ruleset; historical/null/reset assignments do not count. Checklist changes do not alter account access or authorization.
- **17 — Atomic customer saves.** New customer form uses a single transaction for customer, optional contact/site, locating task and audit records. Immediate submit guard prevents duplicate taps. A stable client operation UUID plus transaction advisory lock makes parallel/lost-response retries return the same saved customer. Payload fingerprint rejects reuse for a different operation. Contact consent still respects STOP records. A later site validation failure rolls back customer/contact; failed confirmation offers retry and a link to review a possibly saved record.
- **18 — Labeled immutable correction.** Replaced internal key/value textarea with actual versioned-template labels, current readings, typed controls, field validation and a change preview. Correction reads/actions remain tenant/role authorized. Server rejects empty and unknown amendments and validates each changed answer even if conditional visibility would otherwise hide it. Previous signed versions and packages remain unchanged; the new version follows the existing provider signature/filing checks. Resubmit unchanged remains separate.
- **19 — Paging/totals.** Explicit 50-row pages for invoices, Due, work, estimates, filings, renewals, site work, compliance history and customer-next-actions; pumping/disposal current-offset navigation exposes existing next-page cursors. Customer owed is aggregated from the full selected ledger independently of displayed rows, using existing available-amount semantics (pending payments excluded). Due overdue totals are SQL aggregates independent of its displayed slice. Inbox filing risk and expiring-site counts are full queries; capped alert samples are labeled. Existing customer/site search pagination remains intact; no cap was merely increased.
- **26 — Hierarchy/navigation.** Site's first card shows current system, current contract, next visit/action, latest report/signature/filing link and all outstanding inspection issues. Customer's first operating card shows each site's next visit/unscheduled due date and issue count, with a direct next-action link and paging; full-ledger invoice balance follows. Active/upcoming contracts stay open, older contracts/history/monitoring expand in place, history retains record/page counts. Site-authority blockers and service requests remain visible. Desktop navigation headings and active account/demo role are legible; phone menu remains the existing accessible flow.

## Concrete failure found during integrated verification

The first production-build browser attempt correctly exposed a private-demo failure: historical replay submitted a newly/future-starting contract at a simulated future timestamp beyond the company's real 24-hour expiry. The worker refused expired-demo work; `playDemoStory` then waited 30 seconds on that queued task and failed. Database evidence showed `filings.submit`, attempts 0, not locked/failed/completed, with `run_at` beyond company expiry; stack was worker line 240, filing loop line 316/386 in that candidate. The fix preserves expiration/provider gates: replay only already-started contracts and bound the historical story clock at the visitor's actual arrival. Future-start contracts remain unfiled. A fixed-date morning-start regression covers this boundary, and normal moved/reassigned route tests cover journey fallback.

Browser suite's first three Office failures were test selector mistakes, not disguised UI passes: metric accessible names include the numeric count, and Next adds an empty live-region announcer with `role=alert`. Assertions now match the actual tile names and scope application alerts to `main`. The old failures remain in the integrated run record; the corrected candidate must be rerun.

## Targeted check record

All database checks use `postgres://aerowise:aerowise@localhost:55433/outreach_office_test`, inside the dedicated disposable container. Parent configured test-only fsync/synchronous-commit/full-page-writes off for speed; no shared/existing database was reset.

Executed:

```bash
pnpm --filter @aerowise/web typecheck
pnpm --filter @aerowise/api typecheck
pnpm --filter @aerowise/domain typecheck
pnpm --filter @aerowise/domain exec vitest run src/onboarding.test.ts
pnpm lint
TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_office_test pnpm --filter @aerowise/api exec vitest run test/onboarding.test.ts test/crm.test.ts test/readiness.test.ts test/report-templates.test.ts test/demo-isolation.test.ts
TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_office_test pnpm --filter @aerowise/api exec vitest run test/outreach-office.test.ts test/onboarding.test.ts test/demo-mode.test.ts test/demo-isolation.test.ts test/readiness.test.ts test/report-templates.test.ts
TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_office_test pnpm --filter @aerowise/api exec vitest run test/outreach-office.test.ts test/report-templates.test.ts test/renewals.test.ts test/contracts.test.ts
```

- Web/API/domain typechecks and lint passed before the last targeted regression additions; final candidate repeats belong in the integrated report.
- Domain operational onboarding: 7/7 passed.
- First focused API set: 73/73 passed.
- Expanded six-file API set: 88/88 passed. Covered atomic later-write rollback, parallel operation replay, foreign-tenant/technician refusal, 502 invoices/full ledger, 504 overdue obligations/future target, 202 work orders, 202 estimates and 201 history events.
- Follow-up four-file run: 48/49 passed; one test expected the report-layout label instead of the actual template label (`Air pressure`). That expectation was corrected. Renewal 501-row pagination passed in that run.
- Seven-file demo/lifecycle run exposed the clock/expiry problem above and was interrupted once diagnosed to rerun the corrected source; it is **not** recorded as passing.
- Additional tests now cover empty/unknown/invalid/hidden-field corrections, old/reset applicability, 501 filings/full risk count/explicit sample, future-start demo contracts, moved-stop fallback, homeowner link scope/expiry and current-date startup. Latest results are appended after completion.

Browser coverage prepared in `apps/web/e2e/outreach-office.spec.ts`: delayed/failed/out-of-order invoice queries, query/history restoration, service-type failure, exact scheduling target with no mutation, company-date failure/retry, partial map failure, fresh role/case journey, labeled correction preserving old report/package hashes and direct populated homeowner entry. Existing intro/onboarding/demo-path specs were updated for intentional labels and collapsed help. Parent runs the production-build suite and captures representative desktop/375px/wider-phone screenshots; this file does not substitute source edits for that evidence.

## Final status/dependencies

These findings are implemented. Verification status must use the integrated report's final run and commit; any unrun/failed checks above remain explicit. No new live-domain, real-provider or authority-acceptance claim is made. Staging release remains pending approval. Physical-device rerun of the technician changes belongs to the Technician/root evidence, not this Office browser work. Real provider authority-fit, operating acceptance, legal review and live integration decisions remain external.

## Final focused Office result before integration

```bash
TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_office_verify_test pnpm --filter @aerowise/api exec vitest run test/outreach-office.test.ts test/onboarding.test.ts test/report-templates.test.ts test/inbox.test.ts
```

**32/32 passed**, four files, 31.13 seconds. This includes the final 501-filing pagination/full-risk count/sample label, current/reset authority applicability, labeled immutable corrections (including hidden invalid values), atomic/repeated customer creation, beyond-cap ledger/work/estimate/renewal/history and original Inbox behavior. An initial new capacity fixture had an untyped timestamp parameter in `jsonb_build_object`; adding its explicit `timestamptz` cast fixed the test fixture. No product behavior was changed for that fixture error. API/web typecheck, lint and diff-check passed on the final Office source. The fixed-clock demo and corrected production-build browser regression results remain the integrated pipeline's responsibility.

A setup attempt using database name `outreach_office_verify` was rejected before tests by the repository's mandatory `test` name guard. The corrected disposable name above was used. The guard was preserved; no existing database was touched.

Report-signature module is keyed by the latest authority-report version after correction. Its independent signature read must refresh when a new immutable version replaces the current one; the browser regression asserts the new version in that module, not just the filing's history. This prevents an earlier version's signed status from remaining on a newly corrected report.

## Final independent-review closure — remaining exact targets, caps and detail failures

Review of candidate `89c4eec` found concrete residual acceptance gaps in findings 13, 14 and 19. Pumping/maintenance Due links dropped the obligation ID at the site's generic Contracts anchor. Customer service requests still stopped at 200 without paging; public portal invoices stopped at 50 by newest date and summed only that slice, so an older unpaid invoice could disappear behind recent paid rows. Work-order held records also applied a global 200-row cap before filtering in the component. Contract paperwork, plan coverage and work field/held records still hid failed reads.

The narrow correction retains a cycle obligation in the URL/hash, opens its authorized contract disclosure and focuses/highlights its exact row. Merely opening it books nothing; Book work remains explicit. Public invoice/request and Office customer-request lists now have pages and full counts. Portal balance is a full SQL ledger aggregate independent of invoice page, and outstanding invoices sort first so an older unpaid record is immediately reachable. Current pending-payment deductions remain unchanged. Held field records are filtered by work order before paging, with a full scoped count. Temporary links still use the same bounded public reader, token/expiry/revocation checks and existing rate limits; no staff redirect was added.

Contract paperwork, plan coverage and work field/held records now expose independent bounded loading, stale/error and Retry states. An actual field-record 404 says no record has been received; a 503 no longer silently removes the section. The contract acknowledgment row no longer universally says Not yet; it points to the actual authority process and existing evidence when no acknowledgment has been recorded.

Focused checks:

```bash
TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_office_verify_test pnpm --filter @aerowise/api exec vitest run test/outreach-office.test.ts test/work-sync.test.ts test/portal.test.ts
TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_office_verify_test pnpm --filter @aerowise/api exec vitest run test/outreach-office.test.ts
pnpm --filter @aerowise/web typecheck
pnpm --filter @aerowise/api typecheck
pnpm lint
```

The three-file API batch passed **42/42** in 33.79 seconds. The final strengthened Office file passed **8/8** in 13.64 seconds, additionally proving the full portal balance with 52 outstanding invoices across multiple pages. Fixtures cover 303 portal invoices, 251 customer requests beyond both old caps, 201 held work records, distinct final pages, tenant/role refusal, invalid offsets and revoked-link refusal. The initial new fixture attempted to backdate an already issued invoice and was correctly refused by the immutable-invoice trigger. The fixture now issues it through the API at its historical test clock; the protection was preserved.

The Office browser spec adds the actual Due-to-exact-cycle click/focus/no-mutation and controlled contract/coverage/field/held read failures. The existing fresh-visitor homeowner assertion was scoped to the visible main heading after its prior selector matched a hidden banner paragraph. These changed browser cases await the parent's final rebuilt suite; API passes and source changes are not recorded as browser verification.

## Deterministic regression fixtures after the preliminary full sweep

The first fixed-date demo test incorrectly assumed the random seed included a future-start contract. The seed's random contracts all start today or earlier; absence of a future record was a test precondition failure. The test now wraps the real seeder only within that test and inserts two complete fictional Travis sites/systems/contracts and their normal obligations before the actual `/demo/start` story runs: one starts on the morning arrival date, and one starts tomorrow. It proves successful demo startup, unchanged 24-hour expiry, the current-day contract's submission timestamp capped at arrival (the original next-day afternoon would be past expiry), no future-contract filing or uploaded document, and no due unfinished task. No production logic or gate changed.

```bash
TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_office_verify_test pnpm --filter @aerowise/api exec vitest run test/demo-visits.test.ts -t 'caps a current-day contract replay'
pnpm --filter @aerowise/api typecheck
pnpm exec eslint apps/api/test/demo-visits.test.ts apps/web/e2e/outreach-office.spec.ts
```

The targeted boundary regression passed **1/1**, with the file's other six tests intentionally skipped by `-t`, in 19.36 seconds. API typecheck, focused lint and diff-check passed. This is not a claim that the complete demo-visits file was rerun here.

The cycle browser regression also initially assumed a seed visit was both unbooked and due within 90 days; the default pumping case did not provide that combination. It now creates a named fictional pumping-only monthly plan/version, customer/site and contract through the real API, checks every response, then finds that exact generated obligation through the actual Due pages. The browser clicks its real Due action and asserts row focus/highlight/open disclosure and no work-order mutation. This test-only correction awaits the coordinated browser rerun.
