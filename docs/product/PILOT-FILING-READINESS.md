# Pilot filing readiness

Date: 2026-10-04. Branch `claude/pilot-filing-readiness-yaswiy`.

**This is not production-ready, and no real filing has been made.** Everything here was checked locally and in CI with synthetic data. No email, text, filing or charge went anywhere. Passing tests show the code does what it is meant to do. They do not show that any authority will accept what it produces.

## 1. What this branch adds

| Area | What it does |
|---|---|
| Authority profiles | Each ruleset has a `profile`: draft or verified, the sources read, and open questions. Drafts never send automatically. Fictional rulesets are not loaded in production. New drafts: `tx-lcra-ossf` and `tx-harris-county-oce`. |
| Site assignment | Authorities marked `assignment: reviewed` never match by county. A person picks the authority and records evidence, and every choice is kept. Two whole-county matches also go to review. |
| Credentials | Per-person MP, MT, installer and other credentials, each with an expiry and a record of who checked it, when and where. A responsible MP for the organization. Per-site authority identifiers, such as the LCRA application number. |
| Packages | Each submission gets an immutable package: documents with SHA-256 hashes, cover sheet fields, recipient, subject, body and a manifest hash. Retries resend the same bytes. |
| LCRA cover sheet | Filled into LCRA's own fillable PDF (`packages/compliance/forms/tx-lcra-ossf/om-cover-sheet.pdf`, hash pinned in the ruleset). |
| Contract filings | Contract filings have their own deadline. They wait for a signed copy (signed online or uploaded as a PDF). A sweep opens any that were missed. |
| Complaints | The office logs owner complaints and monitoring notices. A person classifies each one and records the response and whether it is resolved or outstanding. Reports print each one with its status. |
| Corrections | After a rejection, a corrected report version names the version it replaces and the reason. The original is never edited. |
| Delivery | Customer delivery and authority delivery are recorded separately. Acknowledgment is entered by hand, with evidence. |

## 2. Changes made during review

### Complaint gating

- **Which requests count:** a requested inspection report covers the period since the previous completed inspection. With no previous inspection, the period starts the day before the contract in force began. Requests from before that period are left off, so old or unrelated history doesn't block a current filing. The one exception is a reportable request that is still unresolved.
- **Carry-over:** a complaint or notice that is still unresolved carries into later reports. It is labelled "from an earlier period, still open" until a response marks it resolved.
- **What holds a filing:** only an *unclassified* request in the period. A person has to decide whether it is reportable.
- **What doesn't hold a filing:** a missing response or an unfinished repair. The report prints "Status: outstanding (not yet resolved)", or "outstanding, no response recorded as of <date>". The exception inbox escalates every unresolved reportable request as high severity.
- **Changes after Ready:** if a response is recorded after a filing is Ready, the unsent package is replaced. The submission number goes up and a new report version is drawn. The old package is kept, labelled "Never sent (replaced)".

TCEQ's maintenance page says reports must include "responses to owner complaints and monitoring notices". It does not say a complaint must be resolved before reporting. The design follows that reading.

### Draft-profile restrictions

Draft profiles are guarded in `submitFiling`, so every path through the queue is checked. A draft filing is sent only when a person pressed Send now or Retry now for that exact submission number. Anything else moves the filing back to Ready and records a `filing_held` event.

| Action on a draft-profile filing | Allowed? |
|---|---|
| Preparing the package, cover sheet and report | Yes |
| **Send now** by a person | Yes |
| Queue retries of that same Send request (same submission number) | Yes |
| **Retry now** by a person after a failure | Yes |
| Filing by hand outside Aerowise, then recording it | Yes |
| Recording a rejection, correcting and resubmitting | Yes. The resubmission goes to Ready, and a person presses Send again. |
| Recording an acknowledgment, with evidence | Yes |
| Automatic send when a filing becomes Ready | **No** |
| Background sweeps (deadline, overdue, contract) sending anything | **No** |
| A queued task left over from before the profile was a draft | **No.** It is held and moved to Ready. |

Tests in `apps/api/test/readiness.test.ts`:
- "are never sent by the background: not on ready, not by sweeps, not by a stray queued task"
- "are sent when a person presses Send, and the queue may retry that same request"
- "can always be filed by hand, with the package the office downloads"

The complaint scenarios are in the same file:
- "asks only about requests in this reporting period"
- "reports an unanswered or unfinished complaint as outstanding without holding the filing, and escalates it"
- "carries an unresolved complaint onto the next report until it is resolved"

### Dates

Profiles now keep two dates apart:

- `sourcesCheckedOn` is when the sources were read.
- `requirementEffective` is the legal effective date. It is `null` with a basis when no source publishes one.

`effectiveFrom` remains only the date Aerowise starts applying the ruleset.

- **Harris County:** the legal effective date is not published (`null`). Aerowise applies the ruleset from 2026-10-04 only because that is when the profile was written. The ruleset, the screens and the docs all say so.
- **LCRA:** the legal effective date is 2010-04-05, from the LCRA OSSF order.

### Contract-submission deadline

- **Governing rule:** 30 TAC §285.7(d)(2). A renewal contract must reach the permitting authority at least 30 days before the current contract expires.
- **Exception:** §285.7(d)(4), for an owner who maintains their own system. Aerowise doesn't support that case.
- **Corroboration:** Fort Bend County's OSSF page cites (d)(2) and the 30-day requirement.
- Aerowise computes the deadline only when the previous contract's end date is known. For a first contract it shows no deadline and explains that the initial two-year service policy covers that period. It never invents one.
- **Caveat:** the rule text was read through a summarizer of TCEQ's adoption PDF. Cornell LII could not be fetched from this environment. Someone should read the rule text directly.
- **Six-month monitoring:** the six-month schedule, for systems with electronic monitoring and automatic notification, is not offered. `intervalMonths` stays 4 until the qualifying conditions can be recorded and checked.

### Official LCRA cover sheet

The cover sheet now uses LCRA's own fillable PDF, filled with pdf-lib and flattened, with the field mapping in the ruleset. Whether LCRA accepts a typed and flattened copy by email has not been confirmed. It stays the first open question in the profile.

## 3. Open questions and blockers

1. Confirm with LCRA that a filled and flattened copy of their cover sheet is accepted by email.
2. Read 30 TAC §285.7(d) directly, rather than through a summarizer.
3. Find out how Harris County takes inspection reports. Until then, Harris filings are held for review and only contracts apply.
4. Brazoria County: every fetch returned 403, so there is no ruleset.
5. Choose a real mail provider with idempotency keys. Filing mail currently goes to `.eml` files.
6. Set up production file storage (S3-compatible) for packages and reports.
7. Assign each pilot site by hand using LCRA's map, and record its application number.
8. Enter real MP and MT credentials, checked against TCEQ's license search.
9. Neither authority publishes an acknowledgment process.

## 4. Needs independent review

- The complaint period starts at the previous inspection, or the day before the contract started. Check this against how the authorities define the reporting period.
- Carry-over: unresolved requests repeat on every report until resolved.
- Replacing an unsent Ready package when responses change.
- The draft send guard in `packages/compliance/src/filings.ts` (`submitFiling`).
- The reading of §285.7(d)(2) and (d)(4).
- The LCRA form field mapping. Field names like `Textfield-0` were matched to labels by position on the page.
- The new dependency: `pdf-lib` in `packages/reports`.
- `tx-lcra-ossf` v1 and migration 0015 changed during review. Both are unreleased and have only been applied to disposable databases. A database that synced the earlier v1 must drop it.

## 5. How to verify

You need Node 22, pnpm and Docker.

```sh
pnpm install --frozen-lockfile
docker run -d --name aw-pg -e POSTGRES_USER=aerowise -e POSTGRES_PASSWORD=aerowise -e POSTGRES_DB=aerowise_test -p 5432:5432 postgres:16-alpine
export TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:5432/aerowise_test   # disposable database only

pnpm lint && pnpm typecheck
pnpm test                                              # all packages
pnpm --filter @aerowise/api exec vitest run test/readiness.test.ts   # this branch's scenarios
pnpm build
(cd apps/web && pnpm e2e)                              # Playwright; set CHROMIUM_PATH if Chromium is preinstalled
./scripts/compose-smoke.sh                             # Docker Compose smoke test, as CI runs it
```

All data in the tests is synthetic. Never point `TEST_DATABASE_URL` at a database you need, because the tests truncate tables.
