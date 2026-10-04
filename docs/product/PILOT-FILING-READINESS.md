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
| Signing the authority report (a licensed MP; required before the package is made) | Yes |
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

Superseded by section 3 below: each kind of contract now has its own deadline.

- **Six-month monitoring:** the six-month schedule, for systems with electronic monitoring and automatic notification, is not offered. `intervalMonths` stays 4 until the qualifying conditions can be recorded and checked.

### Official LCRA cover sheet

The cover sheet now uses LCRA's own fillable PDF, filled with pdf-lib and flattened, with the field mapping in the ruleset. Whether LCRA accepts a typed and flattened copy by email has not been confirmed. It stays the first open question in the profile.

## 3. Follow-up after merge (30 TAC 285.7)

Codex's merge review found the full rule text and raised one new blocker. This round covers both. On 2026-10-04 the text of §285.7(b), (c) and (d) was read from Cornell LII's republished copy, through a fetch tool asked for verbatim quotes. It matches the (d)(2) quote from TCEQ's 2022 adoption cited in review.

### Maintenance provider signature (285.7(b)(3))

"The maintenance provider must sign all maintenance reports."

- An inspection filing for a real authority profile does not become Ready until the latest authority report version is signed. Until then it shows "Waiting for a licensed maintenance provider to sign…" and an inbox item, "Authority report waiting for the provider's signature".
- Only someone with their own MP license can sign. The license must be active, unexpired and checked against TCEQ's license search. They sign by typing their name as it appears on the license. Office staff, technicians without an MP license and read-only users cannot sign.
- When someone else inspected, that technician's registration must have been valid on the inspection date. The signer attests that the technician is employed by the provider and works under their direct supervision (285.7(b)(1), 285.2). Aerowise checks the registration. Employment and supervision are only attested.
- The signature row is immutable, one per report version. It holds the signer, the license, the typed name, the statement, the time, the hash of the unsigned report it covers, and a signed copy (the report plus a signature block). The unsigned report is never changed. The package sends the signed copy, named `inspection-report-vN-signed.pdf`.
- A corrected version, or one redrawn with complaint responses, needs a new signature.
- Fictional demo rulesets (no profile, never loaded in production) skip the signature, so demo data and the older tests are unchanged.

### Contract deadline by kind (285.7(c), (d)(2), (d)(3)(C))

| Kind | Deadline |
|---|---|
| Initial two-year service policy | Before the system is approved for use. No date is set because Aerowise does not know it. |
| First contract after the initial policy | 30 days before the policy expires |
| Renewal | At least 30 days before the current contract expires. A contract renewed in Aerowise is treated as this automatically. |
| Replacement after a discontinued contract | No later than 30 days after termination |

A first contract in Aerowise has no deadline until the office records which kind it is. Aerowise does not guess. Changing the kind updates a filing that has not gone out yet. A filing already sent keeps its deadline.

### Ending a contract (285.7(d)(3)(A), (B))

Cancelling a contract now asks who ended it and the last day of service. The provider must write to the permitting authority and the manufacturer at least 30 days before service stops, and to the owner too when the provider ended the contract. The inbox shows the notice as due, or as late. The office records when it was sent and to whom. Aerowise does not send the notice.

### Harris and Brazoria (from the merge review, not read by Claude)

- **Harris County:** the testing acknowledgment form names Engineering–Permits as the recipient. It requires quarterly visits for residential systems and monthly visits for commercial systems of the listed types, plus annual BOD/TSS tests. Harris inspection reports stay disabled. They need a v2 profile with those schedules and a confirmed submission channel. The PDF is blocked to the fetch tool by robots.txt.
- **Brazoria County:** the county's contact page names ehmaintenance@brazoriacountytx.gov for contracts and reports. That is the recipient only, so there is still no ruleset. The page still returns 403.

## 4. Open questions and blockers

1. Confirm with LCRA that a filled and flattened copy of their cover sheet is accepted by email, using a synthetic sample.
2. Ask the authorities whether a typed-name signature on the report, plus an attestation block, satisfies 285.7(b)(3). Some authorities may want a handwritten or digital certificate signature.
3. Find out how Harris County takes inspection reports, and model its quarterly and monthly schedules and annual tests before enabling them.
4. Brazoria County: the recipient is known, but nothing else is, so there is no ruleset.
5. Email: Resend is a candidate. Its idempotency keys last 24 hours, so a send whose outcome is uncertain must be reconciled before any retry after that window. Domain verification and delivery handling are also needed. Filing mail currently goes to `.eml` files.
6. Storage: a private S3-compatible bucket (for example Cloudflare R2), with access controls and recovery checks.
7. Assign each pilot site by hand using LCRA's map, and record its application number.
8. Enter real MP and MT credentials, checked against TCEQ's license search, and record which MP signs.
9. Neither authority publishes an acknowledgment process.
10. The ruleset notes for v1 still say the 285.7 timing was read through a summarizer, because published v1 files cannot change. Update them in a v2 profile.
11. Technicians who hold an MP license can sign through the API, but they cannot open the filing screen (it needs filings access), so signing from the technician app is not built.

## 5. Needs independent review

- The complaint period starts at the previous inspection, or the day before the contract started. Check this against how the authorities define the reporting period.
- Carry-over: unresolved requests repeat on every report until resolved.
- Replacing an unsent Ready package when responses change.
- The draft send guard in `packages/compliance/src/filings.ts` (`submitFiling`).
- The signing rules in `packages/compliance/src/signatures.ts`: who may sign, the attestation wording, typed-name matching, and requiring a signature only for profiled rulesets.
- Whether any MP in the organization may sign, or only the responsible MP named on the contract (285.7(d)(1)(C)). Aerowise currently allows any MP with their own valid, checked license.
- The contract-kind deadlines and the replacement date (termination date + 30) in `contractDeadline`.
- The discontinuation notice: Aerowise only records it. Recipients come from 285.7(d)(3)(A) and (B).
- The LCRA form field mapping. Field names like `Textfield-0` were matched to labels by position on the page.
- Migration 0016 (report signatures and contract columns).

## 6. How to verify

You need Node 22, pnpm and Docker.

```sh
pnpm install --frozen-lockfile
docker run -d --name aw-pg -e POSTGRES_USER=aerowise -e POSTGRES_PASSWORD=aerowise -e POSTGRES_DB=aerowise_test -p 5432:5432 postgres:16-alpine
export TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:5432/aerowise_test   # disposable database only

pnpm lint && pnpm typecheck
pnpm test                                              # all packages
pnpm --filter @aerowise/api exec vitest run test/readiness.test.ts   # filing readiness, signatures, contract deadlines
pnpm build
(cd apps/web && pnpm e2e)                              # Playwright; set CHROMIUM_PATH if Chromium is preinstalled
./scripts/compose-smoke.sh                             # Docker Compose smoke test, as CI runs it
```

All data in the tests is synthetic. Never point `TEST_DATABASE_URL` at a database you need, because the tests truncate tables.
