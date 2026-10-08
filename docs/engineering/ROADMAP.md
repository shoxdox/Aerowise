# Delivery record and remaining pilot work

Updated October 6, 2026 after #90 (`d646512`, migrations through `0046`). This replaces the completed build queue. The [current handoff](../DEMO-PILOT-BRIEF.md) governs next steps; the [pilot worksheet](../PILOT-CALL-SHEET.md) governs evidence collection. No worker assignment or new feature phase is active here.

## Delivered foundation (W1–W8)

Hosting/deploy configuration, demo stand-ins, organization/admin onboarding and security, email/storage/observability, Aerowise subscription billing, provider Stripe payments, QuickBooks/SMS, imports, portal, routing, contracts/renewals and draft county coverage are implemented. Historical task/PR detail is in Git history and `docs/DECISIONS.md`. Configuration implementation does not prove live deployment or real-service acceptance.

## Demo and pilot readiness (W10–W12)

- **W10.1:** demo API/worker isolation, synthetic contacts and watermarking — done #83, migration 0040.
- **W10.2:** visitor demo, 24-hour expiry, role switching and abuse limits — done #89, migration 0045.
- **W10.3:** populated guided story — done #86.
- **W10.4:** intros and explanatory empty states — done #89, migration 0044.
- **W10.5:** site/filing authority panel with partial confirmation — done #89, using #85.
- **W10.6:** admin-created prospect demos and clean trial conversion — done #89, migration 0046. Invitations/deployment are separate. STG-01: the nightly reset now keeps prospect demos and real trials (draft PR, branch `claude/stg-01-preserve-prospect-demos-3vhznh`; staging retest pending).
- **W11.1–W11.3:** two walkthrough rounds and material fixes/measurements — done #81/#90; three cosmetic leftovers recorded in [W11-WALKTHROUGH.md](../product/W11-WALKTHROUGH.md#left-open-cosmetic).
- **W11.4:** accurate marketing coverage and demo-only "Try the demo" — done #90.
- **W12.C1:** primary-source research packet — done #80.
- **W12.C2:** Hays contract schedule and permit interval — done #84, migration 0041. Annual county registration is documented, not fully tracked per company.
- **W12.C3–C7:** required PDF fields, jurisdiction scope, Montgomery categories/conditional timing, sources/dates/contact metadata and Denton/SJRA reconciliation — done #87, migrations 0042/0043.
- **W12.V1:** authority/provider evidence log — done #82, migration 0039.
- **W12.V2:** preparation of a next-version proposal/diff — done #82. Publication remains a separate reviewed immutable-version PR.
- **W12.V3:** call sheet prepared; [repository worksheet](../PILOT-CALL-SHEET.md) now available. Pilot provider/authority not selected; no contact sent.
- **W12.V4:** per-field confirmation in admin/coverage/marketing — done #85.
- **Street map for routes:** office schedule and technician map/list toggle on a self-hosted OpenStreetMap basemap ([MAP.md](MAP.md)); demo addresses gated from real geocoders — draft PR, branch `claude/route-street-map-ae4nrx`. Staging map file not yet installed; no offline basemap.

## W12. County evidence and verification

Supported research corrections have landed; original packet `implemented: false` labels are a pre-build snapshot. No real authority becomes verified from that implementation. Harris v2, LCRA acceptance, current channels/format/signatures/receipt, permit-specific scope and recorded source conflicts remain evidence questions. Focus on the chosen pilot rather than repeating eight-county research or the ten earlier draft packets.

## Next operational steps

Choose one provider and actual permit authority; obtain a small redacted permit/contract/accepted-report pack; deploy and verify controlled staging/demo; compare one generated report and schedule; confirm the pilot's remaining acceptance details; log evidence and review any proposed new version. Before real operations, validate required integrations, credentials, legal text and backup/restore. These steps require fresh evidence, not automatic new coding workers.

## Service workflows (in progress)

- **SW-0:** [implementation plan](SERVICE-WORKFLOWS-IMPLEMENTATION-PLAN.md) for general work orders, pumping/disposal records, estimates, plan-specific agreements and coverage, conventional/installation work, work on the street map and authority export interoperability — merged #98 (`2faf91c`, documentation only).
- **SW-1:** work foundation, flag `work_orders` (off by default) — merged #100 (`79b3c12`), migration 0048; deployed to staging with `work_orders` on there only (RUNBOOK). Kinds of work, work orders with lines, notes and an append-only timeline, work visits as `type = 'work'` jobs (several visits per order, one open at a time), database-enforced job/obligation/inspection kinds, the retest link stored, every existing jobs reader explicit about its kind, idempotent issue and request conversion, office `/work` pages, inbox buttons and schedule badges, demo story behind the flag. Not yet: phone work form and sync (SW-2), homeowner portal listing (SW-7). Rollback floor SW-1 (service workflows plan §9.1).
- **SW-2a:** phone compatibility release (phone rollback floor), client only, no migration — merged #99 (`a39e875`). The inspection IndexedDB opens by store presence, not a fixed version, and is never raised by later releases. The future work DB `aerowise-tech-work:<org>:<user>` (store `outbox`) is counted in pending/sign-out/other-sign-in notices and deleted with an ended demo. Unknown outbox op kinds wait with an "N items will send after the app updates" banner. Tests: `apps/web/e2e/phone-compat.spec.ts`. Deployed to staging and runtime-verified by Codex (application `a39e875`, recorded in RUNBOOK by `31fffcf`); no physical phone test yet. SW-2 still waits for SW-1 and SW-F to merge.
- **SW-11 Authority export framework:** draft PR on branch `claude/sw-11-authority-export-bb6n8v`. Ruleset `export` block, `csv_export` submission method, the authority CSV as a document in the immutable submission package (filing stays ready until mark-sent; confirm separate), demo notice column, Example County v2 fixture only. No real authority has an export block (gate G-AUTH-CSV).
- **SW-3:** service items and work invoicing, flag `service_items` (off by default) — draft PR #105, branch `claude/sw-1-work-foundation-19alk9`, migration 0052. A per-company catalog (unit each/hour/gallon/foot/visit, price, taxable, kind of work), fractional line quantities in thousandths (whole-number lines unchanged, including their QuickBooks payload), work order and invoice lines that start from an item, and "Create invoice" on a work order: one draft from its lines, at most one invoice that is not void per order (concurrent requests return the same one), void or discard makes the order unbilled again without reopening the work. QuickBooks: a service item can name its own QuickBooks item (else the plan's, else the default item), on SW-4's tax paths. Not yet: phone-added lines (SW-2); the decimal `Qty` and item mapping untried against a real Intuit company (gate). Not deployed; rollback floor SW-3 once fractional lines exist.

- **SW-4:** QuickBooks mixed sales tax and quarantine (§3.7): per-connection tax mode, off by default and refused for live QuickBooks companies until G-QBO-TAX; compare after create, quarantined invoices with held payments and refunds, recheck/keep review — draft PR, branch `claude/sw-4-qbo-tax-quarantine-2o2rzy`, migration `0050` (number reserved through SW-1, renumbered at merge if needed). Test provider only; no Intuit sandbox run.

- **SW-4:** QuickBooks mixed sales tax and quarantine (§3.7): per-connection tax mode, off by default and refused for live QuickBooks companies until G-QBO-TAX; compare after create, quarantined invoices with held payments and refunds, recheck/keep review — draft PR, branch `claude/sw-4-qbo-tax-quarantine-2o2rzy`, migration `0050` (number reserved through SW-1, renumbered at merge if needed). Test provider only; no Intuit sandbox run.

## W9. Deferred

Homeowner autopay/saved payment methods, organization switcher, technician-app MP signing, two-way QuickBooks, IoT and other states remain deferred until a real pilot/customer need justifies them. No 300-contract demo seed or statewide confirmation campaign is queued.
