# Aerowise — current demo and pilot handoff

Updated October 6, 2026, after PR #90. Application baseline: `d646512b00327017736434fdd9ebb58a95509f8f`; migrations through `0046`. Later documentation commits may advance main without changing that application baseline.

**Call: ready for a controlled demo and pilot preparation. Real deployment and authority acceptance still need evidence.** W10, W11 and the W12 implementation work have merged. The pilot call sheet is prepared; its first authority is not yet selected. No coding worker needs to restart the old kickoff.

This document supersedes PilotBuildBrief.txt, the Oct 5 Pilot Build Brief, Aerowise-Next-Phases-2026-10-06.md and the pre-build Fable proposal. Those are history, not work orders. GitHub main is authoritative for code. This handoff, README and the pilot worksheet are authoritative for current status and next steps. Original research remains unchanged and retains its baseline labels; use current rulesets and jurisdiction docs for implemented behavior.

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
3. **Deploy and verify the finished code on controlled staging/demo infrastructure.** Check actual configured host, commit, migrations, health, isolation, real-device offline close/reopen/reconnect, backup and restore. No deployment was performed by this handoff. Keep public demo organizations separate from controlled real-service integration tests.
4. **Compare one generated report and schedule with the provider pack.** AI can map fields, explain differences, find primary-source answers, prepare a sample and draft the precise remaining questions. Justin/provider approves any real records, contact, filing or charge.
5. **Confirm only the pilot's unresolved acceptance details.** Ask the authority where the sample format/signatures, filing destinations, attachments or receipt process remain uncertain. Log each answer and its scope, then review a proposed new version if warranted. No statewide calling campaign is needed before the demo.
6. **Before real operation:** review terms/privacy and pricing, configure and validate only the integrations the pilot will actually use, establish provider good standing and retain the existing filing/payment procedure until the pilot proves its replacement.

A county call/email is needed only where public sources and provider documents cannot establish current acceptance or resolve a conflict. AI can do the downloading, OCR, comparison, evidence indexing and drafting. It cannot turn an unanswered acceptance question into approval. No outreach or recurring monitoring is scheduled here.

## Answers needed from Justin

- Who is the first provider/design partner, and who can supply the small sample pack?
- What authority actually issued the sample sites' permits? If unknown, send redacted permits and we can identify it together.
- When should the finished demo/staging deployment be prepared for review? Sending prospect invitations is a separate decision.

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
