# Aerowise — current demo and pilot handoff

## Catalog release live — October 8, 2026, morning

**Staging https://staging.deshain.com is on `c004148e9b23f3c2d01cbc9f79f7a57c7827c303`**, with merged #101/#102/#104/#105 and staging flags `work_orders,service_items`. Enter through **Try the demo → Start my demo**, then Owner / Office / Technician; no password. DEMO_MODE=true, live overrides empty, Twilio/Resend absent. Production identity/start time is unchanged.

Passed: #105's exact-head full local check (719 API, 145 domain, 61 browser tests, build and upgrade), Codex rereview of both requested corrections, manual Docker build/deploy, migrations 0049–0052, API/queue/worker health, public demo reseed preserving seven other organizations, and a bounded live catalog → fractional work order → scheduled visit → office completion → edited/saved invoice → issue → void → replacement check. Backup restored into scratch Postgres: 79 tables, 3,283 rows, migration 0052, 71 stored files. [Repeatable steps and screenshots](engineering/RUNBOOK.md#catalog-review-deploy-and-claude-handoffs--october-8-2026-morning).

**Expansion remains incomplete.** #106/#109 offline work, #107 estimates and #108 plans are unmerged and not deployed. Four Claude workers were resumed with integration and follow-up assignments; [draft #110](https://github.com/shoxdox/Aerowise/pull/110) now collects the combined candidate and is not approved for merge. Codex found two P2 estimate bugs: empty optional selection crashes acceptance; cancellation misses invoices linked directly to work orders. Both are assigned back for fixes/regressions before merge. Deposits, office contract options/intake/demo tiers, later pumping/install/cycle/map work, combined review and the final full walkthrough remain open. QuickBooks mapping has local stand-in tests; no new live browser mapping or real Intuit round trip was performed in this bounded check.

**P1 operations:** [Actions run 37796390295](https://github.com/shoxdox/Aerowise/actions/runs/37796390295) did not start its checks due to the account billing/spending restriction; manual deployment works. Existing P2 county-demo/ruleset behavior gaps, physical-phone/provider/authority validation and moderate dependency advisories remain; P3 wording/offline banner/tombstone issues remain in the walkthrough. Justin needs no new DNS, accounts or keys for this release. Guided fictional demos remain the supported prospect use; do not claim the whole Fieldbase expansion or a real field pilot is ready.

## Four-worker review — October 7, 2026, late evening

**Staging remains https://staging.deshain.com on application `79b3c12`**, with password-free **Try the demo → Start my demo** and Owner / Office / Technician switching. Read-only runtime verification confirms healthy API, DEMO_MODE=true, only work_orders enabled, no live-service overrides and no Twilio/Resend credentials. No new application was deployed during this review.

Codex reviewed all four Claude handoffs and merged CSV exports #102, QuickBooks tax/quarantine #101 and work forms #104 into main `c89d0db`. Independent merged-main typecheck passed all 16 tasks. These three pieces have their recorded individual local validation; the final combined application/build/browser/upgrade run is still required before the combined release is deployed. Hosted Actions never ran because of the existing account restriction.

**Open P2 in unmerged #105:** an existing fractional invoice draft cannot save through the office editor after the service_items flag is switched off. Its promised QuickBooks service-item mapping/default fallback is also unfinished. Codex sent both back with regression requirements. Claude's four workers have resumed catalog corrections/integration, offline work on the technician phone (SW-2), estimates/deposits (SW-5) and plans/coverage (SW-8). The whole Fieldbase expansion and its final walkthrough remain incomplete. Justin has no pending approval, account, key or DNS action for this work; physical-device, real-provider and authority-acceptance gates stay open. [Review and merge record](engineering/RUNBOOK.md#four-worker-review-and-serialized-merges--october-7-2026-late-evening).

The dated sections below record earlier deployments; use the current status above for what is actually live.

## Work-order foundation live — October 7, 2026

**Staging https://staging.deshain.com is on `79b3c122ec686fbafb677914c219d4b1dceb37b6`**, merged #100, with work_orders enabled only in staging. Enter through **Try the demo → Start my demo**, then Owner / Office / Technician. The demo now includes open, scheduled and completed work orders. Live owner scheduling, office completion/cancellation and the existing technician inspection route passed a bounded browser check; API/worker health and a scratch backup restore (78 tables, migration 0048, stored files) passed. Personalized demos/trials survived reseeding. [Deployment record and screenshots](engineering/RUNBOOK.md#work-foundation-review-and-staging-deployment--october-7-2026).

The full reviewed build passed 673 API and 59 browser tests, including concurrency, phone compatibility and shared forms. **Fieldbase expansion remains incomplete:** work capture on the technician's phone, fractional work invoicing/catalog and forms part 2 are still being built. QuickBooks #101 and CSV #102 fixes passed review and are running combined integration checks; neither is deployed. Hosted Actions remain blocked by account billing/spending restrictions. Physical-phone/provider/authority acceptance and the final full expansion walkthrough remain open; no new P1/P2 product issue was found in this bounded live check. Test providers remain enabled, Twilio/Resend absent, production untouched. Justin needs no new account, keys or DNS change for this release. Application rollback must stay at/after this work foundation now that work records exist.

## Shared forms staging update — October 7, 2026

**Staging https://staging.deshain.com is on `4d3fdadd4f202d29118c82e3a1322518e06350e3`**, merged #103 (shared form/signature foundation). Demo entry remains **Try the demo → Start my demo**, then Owner / Office / Technician. This release preserves the deployed street map and phone rollback floor. Configuration, migration/seed and API/web/database/worker health passed; live inspection fields retained the earlier fictional draft. Independent lint, full typecheck and 143 domain tests passed. [Deployment record and screenshot](engineering/RUNBOOK.md#shared-forms-review-and-staging-deploy--october-7-2026).

**Fieldbase expansion is still incomplete.** #100 is fixing P2 scheduling concurrency/partial-update issues; #102 is fixing P2 CSV corruption of date-looking identifiers. #101's earlier payment/refund hold and concurrent-review fixes passed rereview but still need combined integration checks. Those three PRs and shared forms part 2 are not deployed. Hosted Actions still cannot start because of account billing/spending restrictions; manual deploy works. Existing provider/authority acceptance and physical-device gates remain open. Test stand-ins remain enabled, Twilio/Resend absent, production untouched. Justin needs no new account, keys or DNS change for this release.

## Phone compatibility staging update — October 7, 2026

**Staging is now on `a39e875023abe72b1e8ae237f3fdd2ee53dff2bd`**, the merged phone compatibility release (#99). This is the phone rollback floor: do not deploy an earlier application commit once offline work is introduced. API/web/database/worker health passed. A 390×844 browser retained an inspection draft and its answers through offline reload, sent one sync request on reconnect, and kept exactly one server inspection after another online reload. This was a draft regression check, not a physical-phone camera or full completed-photo inspection test. [Deployment record and screenshots](engineering/RUNBOOK.md#phone-compatibility-review-and-staging-deploy--october-7-2026).

The Fieldbase expansion remains incomplete. Work-order foundation #100 is retesting with the merged phone code; QuickBooks #101 is addressing payment/refund hold and concurrent-review findings; export framework #102 is running checks; forms/signatures preparation has started. These unmerged features are not on staging. Test providers remain enabled, Twilio off, production untouched. No new account, keys or DNS change is required for this release.

## Street map staging update — October 7, 2026

**Real street maps are live at https://staging.deshain.com** in the office Schedule and technician List/Map views. PR #97 is merged; staging application commit `220b4e747d34b23d7a6dc9451f0a16df35dacafc` passed API/worker health and browser checks with an actual 154 MB Central Texas OpenStreetMap extract. Numbering, selection, phone stop opening, offline list fallback and reconnect map recovery passed. All 13 requests in the observed map retry stayed on staging. [Screenshots and deployment record](engineering/RUNBOOK.md#street-map-review-and-staging-deployment--october-7-2026).

Demo entry remains password-free: **Try the demo → Start my demo**, then Owner / Office / Technician. Maps cover the configured Central Texas box; demo locations remain fictional and visit lines remain straight. No guaranteed offline basemap or physical-phone validation. A P3 demo quirk: role-switch buttons disappear while offline and require an online reload to return. Test providers remain enabled, Twilio off, production untouched. No new DNS, account or keys are needed for this map.

The street map release is preserved in the newer phone build above. Existing provider/authority acceptance and hosted Actions limits below remain open.

## Live staging result — October 6 local / October 7 UTC, 2026

**Ready for guided public and personalized fictional demos.** Send https://staging.deshain.com. **Try the demo → Start my demo** is password-free; switch Owner / Office / Technician in the banner. Personalized owner links are created in `/admin/prospect-demos` and support the same role switch. Admin credentials and private entry links remain outside Git.

**#93–96 are merged and deployed.** The live walkthrough found and fixed two more races: demo setup skipping an acknowledgement while the worker was busy, and online technician sync overwriting newer edits/photos. Application source `5e491a0` includes both; the documentation handoff deploy carries the same application code.

Passed: marketing/request/outbox, owner pages and filing proof, office scheduling/import/summary/undo, online and offline photo inspections with reload and exactly-once retry, private prospect entry/name/logo, clean trial conversion, ended-demo link/cache cleanup, two nightly reseeds preserving prospects/trials, marked exports, in-app call-sheet PDF, invite/reset outbox and scratch backup restore. DEMO_MODE remains on; all providers are test stand-ins, Twilio off. Production was untouched.

Open **P1 operations**: hosted Actions jobs cannot start under the account quota/billing restriction; manual deploy works. Open **P2**: sites still use fictional Example County (Comal/Hays are company metadata), ruleset v2 is a reviewed proposal rather than live apply/revert, physical-phone camera/close/reopen/reconnect is untested, real-company/deactivated-tech cache cleanup needs separate work, and two moderate dependency advisories remain. Open **P3**: some invoice/renewal/portal wording still says Emailed for stand-ins, and ended tombstones accumulate in admin lists.

Justin: no DNS, paid account or new keys are needed to show this staging demo. Resolve the GitHub limit to restore automatic CI, and arrange a physical-phone test; that test does not require Twilio. Personalized links are now safe for fictional prospect walkthroughs, with their configured expiry. Do not promise county-specific records, authority acceptance or field-pilot readiness. [Walkthrough/screenshots](engineering/STAGING-WALKTHROUGH-2026-10.md), [repeatable deploy record](engineering/RUNBOOK.md#merge-deploy-and-fixed-build-walkthrough--october-6-local--october-7-utc-2026), [clean printable call sheet](engineering/staging-fixed-2026-10/bastrop-call-sheet.pdf).

## What we completed

1. **Original-source research:** eight-authority review covering Williamson, Comal, Hays, Travis, Brazoria, Grimes, Montgomery and a blocked fresh Denton retrieval. We preserved official documents, hashes, extracted text/OCR, page citations, conflicts and unavailable sources. The packet contains 57 source records, 34 findings and dispositions for 56 baseline questions. These counts are research records, not accepted counties.
2. **Research applied to code:** Hays contract-anchored scheduling and permit intervals (#84); required report fields for Williamson, Grimes, Travis and SJRA; LCRA's documented zone; Comal city agreements; Brazoria's published channel; Montgomery use categories and conditional food-site timing; Denton/SJRA reconciliation (#87). Montgomery food sites use a recorded contract/permit interval, with a hold when it is missing; the old form is not blindly applied to every site. County registration obligations are documented, not a complete per-company good-standing tracker.
3. **Evidence capture:** dated authority/provider evidence, attachments/references, separate public-rule versus acceptance evidence, and per-field confirmation (#82, #85). "Prepare next version" produces a proposal/diff. A separate reviewed PR publishes a new immutable ruleset. One answer never verifies the entire authority.
4. **Demo:** API/worker isolation (#83), a populated guided journey (#86), visitor access, 24-hour expiry, limits, role switching, first-run guidance, county panels and prospect demo lifecycle (#89). Prospect access is copied manually; nothing is sent. Converting starts a clean real trial company.
5. **Walkthrough/polish:** owner, office and technician flows, desktop and phone, then a second pass after W10; material issues fixed (#81, #90), including the demo signature contradiction, phone filing overflow and schedule layout shift. "Try the demo" appears only on the demo deployment.

The real-authority library remains draft coverage. Harris v2 and LCRA acceptance still need outside confirmation. No authority was contacted during our research, and no real filing or charge was made.

## What needs doing next

1. **Choose one pilot provider and actual permitting authority.** County name alone is insufficient: a parcel may be under a city or river authority. Start with one office user, one technician and about 10–20 sites, alongside the provider's current process.
2. **Obtain a small redacted sample pack.** Current site permits, signed maintenance contracts with dates/special conditions, a previously accepted report and receipt, and state/county provider credentials. The [pilot worksheet](PILOT-CALL-SHEET.md) lists exactly what to ask for.
3. **Finish field-device validation and staging lifecycle fixes.** Live staging, browser offline retry, isolation and scratch restore are verified above. Test physical-device camera/close/reopen/reconnect before treating this as field-pilot infrastructure; personalized persistence and demo-ending cleanup now passed the live retest. Keep public demo organizations separate from controlled real-service integration tests.
4. **Compare one generated report and schedule with the provider pack.** AI can map fields, explain differences, find primary-source answers, prepare a sample and draft the precise remaining questions. Justin/provider approves any real records, contact, filing or charge.
5. **Confirm only the pilot's unresolved acceptance details.** Ask the authority where the sample format/signatures, filing destinations, attachments or receipt process remain uncertain. Log each answer and its scope, then review a proposed new version if warranted. No statewide calling campaign is needed before the demo.
6. **Before real operation:** review terms/privacy and pricing, configure and validate only the integrations the pilot will actually use, establish provider good standing and retain the existing filing/payment procedure until the pilot proves its replacement.

A county call/email is needed only where public sources and provider documents cannot establish current acceptance or resolve a conflict. AI can do the downloading, OCR, comparison, evidence indexing and drafting. It cannot turn an unanswered acceptance question into approval. No outreach or recurring monitoring is scheduled here.

## Answers needed from Justin

- Who is the first provider/design partner, and who can supply the small sample pack?
- What authority actually issued the sample sites' permits? If unknown, send redacted permits and we can identify it together.
- When should the live public staging demo be reviewed with the first provider? Personalized demo persistence passed two live reseeds; county-specific demo data and physical-phone validation remain open.

You do not need to decide future features or answer every county's questions now. The [pilot worksheet](PILOT-CALL-SHEET.md) turns these choices into a short, concrete next step.

## Validation evidence

[PR #90's local results](https://github.com/shoxdox/Aerowise/pull/90#issuecomment-6026117315) report 622 API, 129 domain and 57 package tests, 34/34 browser tests, audit, build, fresh seed, config checks and Docker/Compose smoke on `1c144cf6d1a23e4d38bd5259abf93a611aca496f`. Lint/typecheck used cache; tests/build/e2e ran fresh. Final PR head `715a3d275f0d4addb5780787fb9c567ce78fe046` added only a documentation screenshot; lint/typecheck ran again. The squash merge is `d646512`.

These are Claude's recorded local results, not a fresh full-suite rerun by Codex and not hosted CI. Hosted jobs never started due to GitHub account minutes/billing. Exceptions:

- Render schema download returned 403; Render was not validated.
- nginx was tested on a temporary IPv4 copy with an empty default.conf; original IPv6 configuration was not validated.
- Four images came from mirror.gcr.io.
- Compose used an uncommitted scratch Dockerfile/override with the sandbox proxy CA and network settings.

The final walkthrough has three cosmetic leftovers: some ISO dates, a small initial demo-banner layout shift, and scrollable phone-table focus warnings. See [walkthrough evidence](product/W11-WALKTHROUGH.md#left-open-cosmetic). They are recorded, not an automatic instruction to start more workers.

## Documents and ZIPs

The Desktop `Septic.zip` is the current source/document bundle, with original county source files included separately from historical planning. Its sidecar manifest records the exact repository commit, included files and hashes. No .env files, credentials, .git history, dependencies or runtime databases belong in it.

The research ZIPs remain evidence archives; their kickoff suggestions and `implemented: false` flags describe the pre-build snapshot. They are not current task status. Older source ZIPs, kickoff prompts and session screenshots are retained outside the active checkout in a local backup. Removing active instructions does not discard the evidence behind the county rules.

For agents: read this handoff before old research inputs. Review the requested scope and live repository state before edits. Do not spawn workers, rebuild shipped features, deploy, contact anyone or file/charge anything merely because an archived prompt says to do so.
