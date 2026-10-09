# Aerowise — demo and pilot status

Current as of October 9, 2026. This page says what is live, what is open, and what Justin needs to do. The dated checkpoints that used to live here are in [HANDOFF-HISTORY-2026-10.md](engineering/HANDOFF-HISTORY-2026-10.md); the delivery record is [ROADMAP.md](engineering/ROADMAP.md); the independent review of October 9 is [REVIEW-2026-10-09.md](engineering/REVIEW-2026-10-09.md).

## What is live

- **Staging** https://staging.deshain.com runs application `a444be2`, migration `0060`, all eight workflow flags on, `DEMO_MODE=true`, every outside service a stand-in. Enter with **Try the demo → Start my demo**; switch Owner / Office / Technician in the banner. Production containers are unchanged.
- **Main** is ahead of staging: `c733c22` fixed the three P1 bugs from the review (Stripe Billing partial invoices, an inspection restarted on a second phone, the fictional county selectable by real companies) and `f871bee` gave the demo a year of real history: Lake Travis sites report to LCRA (a real authority, assigned with evidence marked fictional), Blanco sites to the fictional Example County, every past visit is an inspection with its report, signature and filing, and the inbox no longer chases authorities that publish no acknowledgment. Office navigation is grouped into five sections with one Settings entry. **Staging shows none of this until it is redeployed** (`docs/engineering/DEPLOY.md`); the nightly reseed then takes about 15 seconds longer.
- **Checks** are local only: GitHub Actions has not run since early October because the private repository is out of minutes. Making the repository public or adding a self-hosted runner on the VPS restores it.

## What is open

- **No real provider, phone or authority has used it.** Physical-phone camera, lock-screen, airplane-mode and restart tests; a real provider alongside their current process; one authority confirming it accepts a sample report. These are the gates, not more features.
- **P2 bugs from the review**, in the order to fix them: a stale open Checkout page can charge a homeowner twice after an office-recorded payment; ordinary refunds call Stripe inside the transaction with a counter-based key; the support-view cookie survives platform-admin logout; phone timestamps drive compliance deadlines with no bounds; inspections synced for a job the office moved have no held-for-review path; a stalled connection hangs the technician app on "Loading your route"; long tasks can run twice; migrations do full-table rewrites at boot. File and line references are in the review.
- **County coverage.** Twenty-one authority profiles are drafts built from public sources; none is confirmed by its authority. Five file by email (Brazoria, Denton County, Harris, LCRA, Williamson); the rest file by hand through the product's download-and-record path; Travis County publishes no channel. Fort Bend's 27-column bulk-upload schema is documented at [fort-bend-bulk-upload-2026-10-09.md](jurisdictions/research/fort-bend-bulk-upload-2026-10-09.md) and is the first adapter worth building once one call settles its unknowns.
- **Market.** Fieldbase On-Site sells the same thesis to the same customer at $50 plus $0.50 per contract per month; Aerowise's page says $1.50. Pricing needs a decision before any provider sees it.
- **Cosmetic leftovers** from the October 6 walkthrough: some ISO dates, a small demo-banner layout shift, scrollable phone-table focus warnings ([W11-WALKTHROUGH.md](product/W11-WALKTHROUGH.md#left-open-cosmetic)).

## What Justin needs to do

1. Redeploy staging from main and walk the demo once: a Lake Travis site's history, a Blanco filing, the technician route.
2. Restore CI (public repository or a self-hosted runner), then merge nothing further without it.
3. Pick the first provider. County maintenance-provider directories and the TCEQ license search list every candidate; the [pilot worksheet](PILOT-CALL-SHEET.md) says what to ask for. Ask the provider, not the county, how they file today.
4. Decide pricing with Fieldbase's number on the table.
5. Arrange a physical-phone test on an iPhone and a cheap Android before any provider relies on the technician app.

Nothing on this page authorizes a new feature phase, a deployment, a contact with an authority, a real filing or a charge. A demo is not authority acceptance.

## Validation evidence

October 9, local, at `e86b522` before the fixes: typecheck 16/16 packages, API 879/879, domain 161/161, lint clean after `pnpm install`, `pnpm audit --prod` two moderate advisories. After the fixes and the demo change: the touched API files (billing, filings, inspections, schedule, inbox, demo mode, reseed, visitor demos and the seed-dependent suites) pass, and the full browser suite passed 107/107 across a clean run plus reruns of four specs that needed test-only changes for the new seed. Earlier dated evidence, including the 37-row SW-12 record, is in the history file and [SW12-VALIDATION-2026-10-08.md](engineering/SW12-VALIDATION-2026-10-08.md). Hosted CI has run none of it.

## Documents

The Desktop `Septic.zip` is the source and document bundle with a sidecar manifest; no secrets, Git history, dependencies or databases belong in it. Research ZIPs are evidence archives, not task status. For agents: read this page, then [CODEX.md](../CODEX.md), before any older input.
