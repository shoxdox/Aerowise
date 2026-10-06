# Aerowise — Demo and Pilot Brief

Oct 6, 2026 · @Justin

> Written from Justin's kickoff of October 6, 2026 (`Aerowise-Next-Phases-2026-10-06.md`, in the Septic project's shared files) after checking it against `main` at `39298979` (PR #79). It replaces the earlier "Demo and Pilot Readiness Brief" proposal, which is kept unchanged as history in [the research packet's inputs](jurisdictions/research/2026-10-06/inputs/claude-demo-pilot-brief.txt). Where that proposal and this brief differ, this brief wins. The tasks, owners and status live in [the roadmap](engineering/ROADMAP.md#demo-and-pilot-readiness-w10w12).

## How to use this doc

The [Pilot Build Brief](PILOT-BUILD-BRIEF.md) and its workstreams W1–W8 are done. This brief adds three workstreams:

- **W10. Demo experience:** a fictional demo a prospect can use alone.
- **W11. Walkthrough and polish:** fix what an owner, office user or technician would trip on.
- **W12. County evidence and verification:** turn the new research into source-backed corrections, and record what authorities and providers actually confirm.

Every rule of the first brief still applies: lint, typecheck, tests, build and e2e stay green; no test is weakened; a draft ruleset never sends on its own; county rules come only from cited sources; synthetic data only; tenant tables are organization-owned with composite foreign keys and isolation tests; migrations are forward-only; open choices go in [DECISIONS.md](DECISIONS.md).

This kickoff authorizes coding, review and PRs. Deploys, contact with counties or prospects, real filings and real charges each need Justin's separate approval.

## Where things stand on October 6

- **Code:** `main` at `39298979` (PR #79). GitHub `main` is the authority for code; the uploaded source zip is a snapshot of that commit.
- **Rulesets:** 22 ruleset files in `packages/compliance/rulesets/`: 21 real authorities, all `draft`, plus the fictional `tx-example-county`. No real authority is verified.
- **Yesterday's county round is done.** The ten research packets the earlier proposal wanted turned into rulesets (Bell, Bastrop, Brazoria, Grimes, Hill, Kaufman, McLennan, Montgomery, SJRA and the Ellis addendum) are already merged as drafts in #75 and #77–#79, alongside the other county drafts from #68–#76. Kaufman has a draft (#77); it is not "unreadable". Only Harris County v2 (W6.C16) and LCRA's verification (W6.C19) are still blocked, on the authority's own confirmation.
- **Test counts:** the earlier proposal's "13 rulesets" and "670 tests" describe an older commit. They are not evidence for anything now. Each PR reports the checks it ran on its own head commit.
- **New research:** an eight-authority original-source pass, committed in [docs/jurisdictions/research/2026-10-06](jurisdictions/research/2026-10-06/ARCHIVE.md) with its source manifest. It has 57 source records and 34 findings, all unimplemented and none confirmed by an authority.

## Three kinds of evidence

Keep these apart in code, docs and copy:

1. **Public rules:** an order, form or county page says it. This supports a draft ruleset, with a citation.
2. **Implemented behavior:** a test shows Aerowise does it.
3. **Acceptance:** the authority, or a provider's previously accepted filing, shows the authority takes it. Only this supports "verified", and only through the existing W6.5 record of who confirmed it, when and how.

A downloaded order is not a verified profile. An email that left Aerowise, or a portal upload, is not acceptance.

## What already exists

Checked in the code before writing the tasks. The roadmap marks each task that this covers.

| Proposed | Already in `main` | Where |
| --- | --- | --- |
| Every outside service uses its stand-in in demo mode | Yes, but per deployment: `DEMO_MODE=true` switches the whole environment. `DEMO_LIVE_SERVICES` can switch Stripe (test key), QuickBooks (sandbox) and SMS (one test phone) back on for staging. | `packages/tasks/src/providers.ts`, `apps/api/test/demo-mode.test.ts` (W1.2, #31; W7.3, #63) |
| Banner on every screen | Yes: "Demo data. Nothing is sent." | `apps/web/lib/demo.tsx`, `apps/web/e2e/demo.spec.ts` |
| Nightly reset | Yes: `pnpm db:reseed-demo` empties every tenant table and reseeds; refused in production unless `DEMO_MODE=true` | `packages/db/src/reseed.ts`, `packages/db/src/cli.ts` |
| A fictional demo company | Yes: "Hill Country Aerobic Services (demo)", about 50 customers in the fictional Example and Sample counties, two plans, contracts and a week of jobs. No inspections, filings, renewals or invoices are seeded. | `packages/db/src/seed.ts` |
| Demo sign-ins | Shared owner, office and technician logins with one fixed password, shown on the sign-in page in demo mode | `apps/web/app/login/page.tsx` |
| First-run checklist | Yes, computed from real data, for a new company | W2.5 (#51) |
| County panel on sites and filings | Mostly: the site page shows the authority, draft or "Verified with … on …", the assignment evidence and the open questions; the filing page adds the deadline and its basis, the channel, fees and proof | `apps/web/components/SiteAuthority.tsx`, `apps/web/app/(office)/filings/[id]/page.tsx` |
| Verified badge and record | Yes: `profile.verification` in the ruleset JSON (who, when, how); drafts never auto-send | W6.5 (#36), `packages/domain/src/filings.ts` |
| Coverage page with open questions | Yes: `/admin/rulesets` | W6.6 (#42) |
| Marketing page with honest coverage, demo request form | Yes; coverage is read from the rulesets with verified ones marked. No "Try the demo" link yet. | W8.1 (#37), W8.2 (#40) |
| Ten packets become draft rulesets | Done | #75, #77–#79 |
| Recording a county answer | Only by editing the ruleset JSON in a PR. No dated evidence log, no partial confirmation, no call sheet. | — |
| Per-organization demo isolation, contact validation, export watermark, guided tour, prospect demos | Not built | — |

## W10. Demo experience

Owner: the "Demo experience" thread.

**Goal:** a stranger opens the demo, signs in as a fictional owner, office user or technician, and walks the five-minute path (inbox, a site, a due inspection, a filing and its proof, a renewal, an invoice) without an empty screen, an error or anything leaving the system.

**Isolation is enforced on the server and in the worker, for each demo organization, whatever the keys or deployment.** Today isolation is a deployment setting, and staging's `DEMO_LIVE_SERVICES` can turn real test-mode accounts back on. A public or prospect demo organization must never send real email, SMS, an authority filing, a payment or anything to a live company's accounting, even on a deployment where those services are live. `DEMO_LIVE_SERVICES` stays for the separately controlled staging integration tests and never applies to a demo organization. Contact details saved in a demo organization must be synthetic (reserved example domains and 555-01xx numbers). Exports and PDFs are watermarked as demo data. The banner says the data resets and nothing is sent, on every screen. Tests cover synchronous routes, queued jobs, tenant isolation and attempts to get around the UI.

**Public access** runs on a dedicated, isolated demo deployment, never on a production organization with publicly shared owner or admin credentials. Public demo accounts never get platform-admin access. All homeowners and sites are fictional and labeled so; synthetic county placement never claims a real permit assignment. The thread chooses the reset, session and abuse approach and records it in DECISIONS.md. Default: each visitor gets a fresh fictional demo company from one "Try the demo" step, with no shared password, a short expiry and a per-address limit on new demos.

**Seed size:** fill the flows that are empty today; there is no 300-contract target.

**After the core demo works:** first-run guidance for owner, office and technician, explanatory empty states, and a county panel with draft or verified status and open questions on sites and filings (most of which exists).

**Personalized prospect demos** come last and depend on the core demo: admin-created isolated organizations with a prospect's name and counties, safe expiring access, synthetic data only, a lifecycle audit, and a conversion to trial that removes every synthetic customer. Built behind stand-ins. Deploying it, domains and inviting prospects are outside this kickoff.

## W11. Walkthrough and polish

Owner: the "Walkthrough and polish" thread.

Walk the current demo as owner, office and technician, on desktop and phone sizes. File a short issue list with screenshots and steps, grouped as broken, confusing and cosmetic. Fix broken, then confusing.

Check specifically: Central Time dates; consistent money; provider wording instead of engineering words; validation next to the field; role access; PDF rendering with and without a logo; the technician app offline (close, reopen, reconnect) with visible sync state; keyboard navigation, labels, contrast and tap targets.

Change only what the walkthrough found. Marketing copy describes what exists and shows honest coverage: a draft must never look county-approved. "Try the demo" goes on the marketing page only once the demo route works. Record performance and accessibility measurements and fix material problems; a score is not pilot readiness.

## W12. County evidence and verification

Two groups, so two threads can work without colliding.

### Corrections (W12.C), owner: the "County rules engine" thread

Map each finding in the research to the actual rule, schedule, required field, report PDF or open question before changing anything. Changes to a published ruleset go in a new immutable version with an applicability review. Batch related corrections into one PR to avoid repeating the full suite per authority; there is no PR per county just to repeat work that has landed.

In priority order:

1. **Hays** (W12.C2): contract-anchored first, subsequent and last visits; provider changes; annual county registration; prior reports at renewal; a corrective report within ten days of the previous report that does not reset the ordinary schedule. Four months unless a permit says otherwise. The current draft's generic six-month monitored schedule is not supported by the local order.
2. **Required data in the rendered PDF** (W12.C3): Williamson pump-tank sludge and applicable spray conditions; Grimes sludge, pH and spray conditions; Travis unauthorized alterations, provider contacts and addresses, and site and permit details. Keep units and applicability. No invented pH thresholds, and no extending single-family rules to every commercial site.
3. **Jurisdiction evidence** (W12.C4): replace the Travis draft's 1,000-foot Lake Travis claim with LCRA's documented restricted zone (2,000 horizontal feet from the 691-foot contour, within the drainage area). The permit or map decision still controls assignment. Review city agreements and SJRA's scope; a county name alone does not establish authority.
4. **Montgomery** (W12.C5): annual BOD/TSS for commercial and multifamily is in the local order. The older commercial-food initial contract says monthly; the general initial contract says every four months. Model use category and initial versus renewal terms separately; keep the food form's applicability and renewal interval open.
5. **Sources, dates and contacts** (W12.C6): correct the readable Comal, Brazoria and Montgomery orders. Brazoria's page names a report and contract inbox; that is a published channel, not acceptance. Hays's address is an inquiry contact and Montgomery's `mc.maint` address is for record requests; neither is filing authorization. Grimes's final TCEQ approval is still missing. Williamson's future-dated affidavit and differing deadline anchors stay a recorded conflict. Hays's $50 maintenance-contract late fee needs its trigger confirmed; permit renewal fees are separate.
6. **Denton and SJRA reconciliation** (W12.C7): the new Denton `access_blocked` entries are failed fresh retrieval. Reconcile the saved form (`4eafacc1-Homeowners-Inspection-Form-PDF.pdf`) with the current draft and keep PR #76's split between the report channel and the contract channel. Acceptance of Aerowise's layout stays open. Visually review SJRA's signed order for the handwritten order number and the decisive report-field pages, with page citations; `384053.4` is a footer. Preserve any character or requirement that stays ambiguous.

Done when decisive claims carry source and page citations, supported corrections have meaningful regression tests and rendered-report evidence where relevant, and the remaining unknowns are accurate and visible. Harris and LCRA acceptance stay open where outside confirmation is required.

### Verification capture and call sheet (W12.V), owner: the "Verification capture and call sheet" thread

Start from W6.5 and W6.6. Add the smallest admin flow for dated evidence from an authority or provider: who (contact identity), the exact question, the answer, and attachments or source references. A call is one kind of evidence; a county email, a published rule or a previously accepted report can answer a particular question too. Confirmation is per field and can be partial. Acceptance evidence and public-rule evidence are labeled differently.

Saving evidence never rewrites a rule and never verifies a whole authority. Applying answers needs a diff, authorization, a new immutable ruleset version, the right platform-admin permission and the existing full verification requirements. Show what is still open: format, signatures, contract destination, and receipt or acceptance. One answered question never makes a profile "verified".

Generate a short call sheet from the remaining questions, pilot authority first. Mark the questions a provider's current permit, signed contract or accepted report could answer, so Justin is not asked to call eight counties for what a provider already has. This thread sends no calls or emails.

## Coordination

- `ROADMAP.md` and this brief belong to the coordinator's docs PR until it merges; afterwards each thread updates only its own rows.
- Shared files are changed one thread at a time, in roadmap order: migrations, `packages/domain` schemas, `packages/db/src/seed.ts`, the report builders in `packages/reports` and `packages/compliance`, and `/admin` pages. The roadmap's dependency column names who goes first.
- Merges are serialized through the coordinator under the local-checks rule while GitHub Actions minutes are exhausted: full local checks on the exact integrated head, recorded on the PR, then a squash merge.

## Needs from Justin

Nothing is needed to start coding. Later, in this order:

1. Choose the pilot provider and authority, and get a few real (redacted) artifacts: a current permit, a signed contract and a previously accepted report. These answer more questions than a county call.
2. Approve a demo deployment, domain and reset approach once W10's core demo works.
3. Approve any contact with the pilot authority, using the W12.V call sheet.
4. Approve sending a personalized demo to any prospect.
