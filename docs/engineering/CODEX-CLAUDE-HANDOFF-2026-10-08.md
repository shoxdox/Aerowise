# Codex / Claude continuation — October 8, 2026

Justin requested a fresh Codex chat to take over the accepted Fieldbase expansion. The outgoing chat has stopped implementation/review work after saving this record. Continue autonomously with the four existing Claude workers; do not create duplicate workers or rebuild the plan from scratch.

## Boundaries and authority

Justin has authorized implementation, Claude coordination, independent code review, fixes, serialized merges and manual staging deployment of the accepted expansion. A passing Claude test report alone is not Codex approval. Staging only: never configure, start or deploy production. Keep DEMO_MODE=true, DEMO_LIVE_SERVICES empty, Twilio off and test stand-ins. If Resend is configured, require EMAIL_REDIRECT_TO. Verify runtime isolation before any external-looking action. Ask Justin before money, accounts or DNS changes. No real provider/customer messages, filing, payments or pricing changes. Record every manual deployment step in RUNBOOK.md. Preserve untracked apps/web/AGENTS.md and apps/web/CLAUDE.md; do not commit or overwrite them.

## What is already pushed and deployed

- Main at handoff preparation: e1abf46, documentation on top of c004148. This handoff will be a later docs-only commit; verify origin/main on arrival.
- Staging: https://staging.deshain.com, application c004148e9b23f3c2d01cbc9f79f7a57c7827c303, migration 0052, flags work_orders,service_items. #105 is merged and deployed, alongside earlier merged prerequisites.
- Previous turn verified DEMO_MODE=true, empty live overrides, no Twilio/Resend credentials, healthy API/queue/worker and unchanged production container identity/start time. This handoff check did not redeploy or recheck runtime; refresh before deploying.
- Live catalog check passed: add a fictional hourly item; work order with quantity 1.5; schedule; office completion; create invoice; edit/save/reload; issue without email; void; replacement draft. Screenshots and precise steps are in RUNBOOK.md and staging-catalog-2026-10/README.md.
- Final backup/restore: db-20261008T150217Z.dump, scratch restore passed, 79 tables / 3,283 rows / 22 organizations, migration 0052, 71 stored files. Local backups only, no R2. Never restore over the live database for a check.
- Fractional data now exists. Rollback floor is c004148 / SW-3 or a compatible successor, never a pre-0052 application.
- GitHub Actions failed before jobs started under account billing/spending restriction. Do not call hosted checks green or change billing. Manual deployment works.

## Freshly checked Claude and GitHub state

The correct Claude project is https://claude.ai/code/project/chan_01QvhSvKr1RJboadnDBkYsjo in Justin's **Personal Brave profile**. Work-profile Claude cannot access it. Last verified tab: browser 4, tab 92916335. Browser IDs can change; inspect the actual connected tab. Use CUA browser tools for UI interaction, not hidden HTTP/page state. All four latest handoffs were read. Overview shows **three waiting for Codex review and one working on deposits**. Justin has no decision to make at this checkpoint.

Existing threads (their old titles persist):

- **SW-1 Work foundation and integration**, thread cmsg_01QvhSvKr1RJboadnDBkYsjo71HcgzFZHgfQPZ4MgbMUQc: prepared #110 and completed the combined run; waiting on independent Codex review. Owns shared-file integration/migration coordination.
- **SW-2a Phone compatibility**, thread cmsg_01QvhSvKr1RJboadnDBkYsjoTe3GGN8PyE7fJzEXFoVQnz: #106/#109 stable, waiting on Codex review. Physical-phone behavior is untested. Shared form renderer may be reused read-only.
- **SW-11 Authority export framework**, thread cmsg_01QvhSvKr1RJboadnDBkYsjoMQmmdiVCTggm5pyYkFSmPP: now handles SW-8 plans, #108/#111 waiting on review. Migration 0057 confirmed by SW-1 in a later GitHub comment (the older chat message says pending).
- **SW-4 QuickBooks tax and quarantine**, thread cmsg_01QvhSvKr1RJboadnDBkYsjoBxghucvWqSYNQH3xdpGnXB: estimates #107 fixes pushed, now building/testing deposits SW-5b / 0056. UI reports ledger/refunds/webhook/reconcile code, targeted tests, lint/typecheck/build done; full API and browser checks/commit still in progress. Do not describe deposits as pushed or complete until verified.

Verified open draft heads:

- #106 db5d7041fd01e3e83e4540dac04cad7a08285c8c: server work records/held records/assignment history, actual migration 0055 (PR title still says 0053).
- #109 0a96ea804617dd5ab1e996a1dcebda07ce40bcc7: phone/offline work visits, stacked on #106.
- #107 a5845c54dc4a8d7e1b443d93044271021c527ac2: estimates, migration 0054.
- #108 a3f9eab03d85b61d2d9cba795ee1aac4645a5ede: plan versions/coverage, migration 0053.
- #110 71ac4d2308ac94e0653a727938b92803429ec203: **integration evidence only; do not merge this PR**. Each slice merges through its own PR after review.
- #111 d3e91d948d05a708f8f08ad2d40d751b954eca39: stacked on #108, migration 0057; office contract options, intake at online renewal signing, fictional Basic/Gold/Platinum demo tiers. Office unsigned contracts have no intake step. It is not in #110.

## Evidence to use without duplicating expensive suites

[Combined run evidence](https://github.com/shoxdox/Aerowise/pull/110#issuecomment-6063545408): Claude reports a full local run on 85d8a774403c9bfd0a462a1733363153a572a277, 10:07–10:38 AM America/Chicago. Install/audit/lint/typecheck, all packages (763 API, 151 domain), build, 67 browser tests with five flags including offline/phone floor, seed and upgrade from c004148 passed. Upgrade applied only 0053–0055 and invoice lines stayed identical. Docker image build was excluded; compose config passed. Hosted CI did not run.

Current #110 absorbed later estimate test-only commits. Outgoing Codex independently fetched the branch and verified `git diff 85d8a77 71ac4d2`: **four API test files only, +23/-4**. Claude reports targeted lint/API typecheck and 59/59 passing on that delta. Do not repeat the full suite just for these test-only changes. New app fixes or adding #111/deposits require validation of the changed combined application; do not imply the old run covers them.

The outgoing review found two #107 P2 blockers: empty optional selection generated invalid SQL/500; cancellation missed invoices linked directly through invoices.work_order_id. Both fixes are pushed and regressions reportedly fail before/pass after. [Fix evidence](https://github.com/shoxdox/Aerowise/pull/107#issuecomment-6062816486), [test-only updates and invoice/cancel race](https://github.com/shoxdox/Aerowise/pull/107#issuecomment-6063457746). **Independent rereview remains required**, including the rest of #107; neither finding comment approved the whole PR.

[#111 evidence](https://github.com/shoxdox/Aerowise/pull/111): 150 affected API, seven domain and three browser tests, typecheck/lint/build and upgrade preserving existing data reported on d3e91d9. [Later comment](https://github.com/shoxdox/Aerowise/pull/111#issuecomment-6062952865) confirms SW-1 assigned 0057 and approved shared commits. Worker approval is not independent Codex approval.

## Immediate next work

1. Read repository guidance, DEPLOY.md, RUNBOOK.md, DEMO-PILOT-BRIEF.md, Fieldbase expansion roadmap/decisions. Refresh PR heads and worker state; do not repeat already completed deploy steps.
2. Independently review #107 fixes/current head, #106/#109, #108, shared integration resolutions and #111. Send concrete small fixes to their existing workers and keep SW-1 informed. Regress tenant isolation, atomic/idempotent acceptance, invoice/coverage reservation, pinned forms and offline sync/held-record behavior as warranted. Distinguish test reports from your own review.
3. Once approved, serialize prerequisite/slice merges and retarget stacked PRs, retaining every shared change. Do not merge #110. Coordinate with SW-1 so the merged application preserves the reviewed/tested candidate; account for any extra integration changes rather than assuming squash merges reproduce it.
4. Collect deposits' separate PR when ready. Coordinate #111 and deposits into a next combined candidate, migration order 0053/0054/0055/0056/0057 and one full combined validation after app fixes settle. Use targeted checks for unchanged trees/test-only deltas.
5. Back up, deploy approved application manually with deploy/vps/deploy.sh staging SHA, verify health/isolation, reseed public demo preserving personalized demos, and walk changed flows in browser. Restore-check backup in scratch. Record steps/screenshots and refresh pilot brief/readiness honestly.
6. Continue accepted later waves after their prerequisites: pumping/disposal SW-6, conventional/install SW-7, non-aerobic cycles SW-9, map SW-10, final walkthrough/backup/rollback SW-12. Do not call the full expansion or real field pilot complete while these remain.

## Useful local access and records

- Existing protected server helper: /home/deshain/.codex/aerowise-setup-session/run-root.py. Read/use locally without printing credential contents; it accepts a remote command. Git/deploy runs as deploy, staging checkout /opt/aerowise/staging, env /etc/aerowise/staging.env. Existing host vultr-beta 45.76.29.23, SSH port 62008. No new account or key needed.
- Installed scripts: /usr/local/lib/aerowise/vps/backup.sh staging and restore-check.sh staging. Deploy via sudo -u deploy /opt/aerowise/staging/deploy/vps/deploy.sh staging SHA.
- Remote logs: /tmp/aerowise-catalog-deploy-20261008.log, /tmp/aerowise-catalog-enabled-20261008.log, /tmp/aerowise-catalog-reseed-20261008.log.
- PR fetch refs already available: origin/review-106 through origin/review-111; refresh before using. Local main is left clean except the two preexisting untracked web guidance files.
- Original Codex chat: Deploy Aerowise staging, thread 01a11383-2f46-7470-babf-00085e0bba20; use read_thread for earlier evidence if needed. Do not run a second reviewer/deployer from that chat concurrently.
