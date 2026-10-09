# SW-12 evidence matrix (plan §12, 37 rows): final head `9daf3d7`

Final #116 head: `9daf3d709a321176d6b1ab97dd1e0e26a78d244f`. It is the frozen `97aca5b` (main `be44166`, SW-9, merged in) plus SW-2's phone sync-banner correction, fast-forwarded with no merge commit. Application floor for Drill B: `be44166aa7d38ff5a2db7eead975c9e951c7753c`. Phone web floor for Drill A: `a39e875`.

All runs are local only. Hosted CI is billing-blocked and has never passed (the 9daf3d7 hosted jobs have no steps; they carry the same billing annotation).

**Two runs, kept apart.**

- **Original run on `97aca5b`.** Install, audit, lint and typecheck: exit 0. API 879/879 and domain 161/161; other packages passed. Seed, build, upgrade (IDENTICAL), Docker config and compose smoke: exit 0. **Browser 101/102, exit 1.** The failure was `pumping.spec.ts:110`, a real false "All changes sent" banner. Root's Drill A passed 2/8/6, and root's corrected Drill B passed 17/17. Evidence: `/mnt/project-files/sw12-evidence/final-97aca5b-20261008/`.
- **Final head `9daf3d7`.** Only 6 files changed against 97aca5b: `sync.ts`, `SyncBanner.tsx` and 4 e2e files. API, packages, migrations and config are unchanged, so API, domain, the other packages, the upgrade check and Drill B carry over (root verified the same diff). Lint, web typecheck and web build: exit 0. **Browser 106/106, exit 0.** Corrected compose images (base digest identical to 97aca5b's build): compose up, seed and smoke exit 0. Root's final Drill A: PASS. Evidence: `/mnt/project-files/sw12-evidence/final-9daf3d7-20261008/`.

**The fix.**

- The banner no longer says "All changes sent" while a just-saved change is still uncounted. It shows "Checking for changes to send…" until a pass recounts.
- A pass that ends with another pass already requested no longer reports idle.
- The banner never says all sent while a change has been turned down.

SW-2's checks for the fix passed 12/12, with fail-before evidence (4 failures with the 97aca5b code; the inspection race still fails with `01168e6`): `/mnt/project-files/sw12-phone-gaps/sync-banner-9daf3d7/`.

**Known leftover, unchanged from 97aca5b.** Offline with changes already waiting, the banner briefly shows "Sending N changes…" before "No signal". It never claims anything was sent.

## Independent review bounds

This repository copy preserves the worker matrix with root evidence clarifications. The immutable visible worker source and verbatim primary excerpts are retained outside Git at `/home/deshain/.codex/aerowise-setup-session/fieldbase-review-20261008/`. Worker `/mnt/project-files/` references identify its cloud evidence, not local workspace paths. Installed staging restore checks counts/archive readability; local Drill B separately checks content/file hashes. The actual installation PDF downloaded and rendered; staging disposal preview remains browser-blocked. No guaranteed offline basemap or traffic estimates. The high-threshold audit passed with two moderate advisories; Render Blueprint schema was not validated because its fetch returned proxy403.

## Exceptions that stay explicit at the final SHA

- **G-DEVICE.** Every phone row runs on the e2e Pixel 7 profile in Chromium. There is no physical phone test.
- **Org types.**
  - e2e runs on the seeded demo company, and some specs use its personalized-demo or prospect variants.
  - Trial and real-test org types are not separately exercised in the browser.
  - Read-only (row 20) is a lapsed state of the same company.
- **Providers.** All providers are test stand-ins: test checkout, the built-in QuickBooks test company, the email outbox, and the app's own map file. There is no real provider acceptance.
- **Authority.** Example County and its rules are fictional. There is no authority acceptance, and no real filing is sent.
- **Row 9 QuickBooks.** The deposit refund is HELD behind `deposit_mapping_missing` (G-QBO-DEPOSIT). No Refund Receipt is delivered.
- **Row 16.** The filing reaches the CSV path through a forced, test-only failed email send (`sw12-run-once.ts submit-filing-failing`). In the demo the outbox send would succeed.
- **Worker steps.** The e2e harness runs no background worker. QuickBooks sync and filing prepare/send are run once on demand by `apps/api/test/sw12-run-once.ts`, which refuses non-test databases, `DEMO_MODE` other than true, and any live-service override (root verified 2/2).

## Rows

| # | Scenario (short) | Evidence (spec / test / drill) | 97aca5b original run | 9daf3d7 final head | Exceptions |
|---|---|---|---|---|---|
| 1 | Each work category lifecycle | `work-orders.spec` (office create→complete), `pumping.spec`, `installation.spec`, `work-phone.spec` (repair); API `work-orders.test` (no filing/report/obligation change) | **`pumping.spec.ts:110` FAILED** (false "All changes sent"); other specs passed; API 879/879 | browser passed (suite **106/106**); API carried (source unchanged) | Org-type exception: demo company only in the browser |
| 2 | Aerobic regression vs `0906828` | inspection/county/filing suites, `offline-sync.spec`; SW-9 schedule/filing comparisons and 31 paired hashes of PDFs re-rendered after UUID/image-key normalization, main `e177c56` vs SW-9 (source `SW9-AEROBIC-BYTES.md`) | browser passed (suite 101/102); API 879/879; upgrade e177c56→97aca5b IDENTICAL | browser passed (suite **106/106**); API carried (source unchanged); upgrade carried | No raw stored-PDF equality or full byte-identity comparison with 0906828. Upgrade compares selected columns/tables on seed with zero work orders; populated work data is covered by Drill B. |
| 3 | Mixed offline: 2 work + 1 inspection | `sw12-mixed-offline.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | G-DEVICE |
| 4 | Phone compat and rollback to SW-2a floor | `phone-compat.spec` (5); **Drill A** `scripts/sw12/drill-phone-floor.sh` (floor `a39e875`, flags default to each SHA's FEATURES) | browser passed (suite 101/102); root Drill A PASS 2/8/6 | browser passed (suite **106/106**); **root final Drill A PASS** exit 0 (before 2/0, floor `a39e875` 8/0, forward 6/0; 7 unsent work changes kept, inspection sent once, no VersionError) | Phone web floor `a39e875`; Chromium Pixel 7, not a physical phone |
| 5 | Convert issue and portal request twice | `sw12-row5-convert-twice.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | — |
| 6 | Two pump-outs, offline load, correction, overdue item | `pumping.spec` (offline pump-out → disposal record + manifest once); API `pumping.test` (correction replaces once, overdue setting, load correction keeps manifest); `sync-banner.spec` (banner truth) | **`pumping.spec.ts:110` FAILED** (false "All changes sent"); other specs passed; API 879/879 | browser passed (suite **106/106**); API carried (source unchanged); banner fix covered (`sync-banner.spec`, `pumping.spec`, `phone-storage.spec`) | Overdue raised→cleared and the correction are API-level only |
| 7 | Estimate revise, 409 on old, deposit, final = total − deposit | `sw12-row7-estimate-revised.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | Trial org type not covered |
| 8 | Double accept and checkout replay | `sw12-row8-double-accept.spec`; API `estimates.test`, `deposits.test` | browser passed (suite 101/102); API 879/879 | browser passed (suite **106/106**); API carried (source unchanged) | — |
| 9 | Cancel after acceptance: refund / retain | `sw12-row9-cancel-deposit.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | **QuickBooks HELD** (`deposit_mapping_missing`); no Refund Receipt |
| 10 | Mixed tax, QuickBooks tax off then on | `sw12-row10-mixed-tax.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | Test QuickBooks company |
| 11 | Plan builder, renewal, coverage to office and tech | `plan-builder.spec`, `plan-intake.spec`, `work-coverage-phone.spec` (#117) | browser passed (suite 101/102) | browser passed (suite **106/106**) | — |
| 12 | Contracts after plan-version backfill | API `plan-versions.test`; upgrade identity (c004148→0057 kept invoice/plan md5s at `4b3e441`) | API 879/879; root Drill B PASS 17/17 (corrected rerun) | API carried (source unchanged); Drill B carried (server/data source unchanged; `APP_FLOOR=be44166`) | — |
| 13 | Pumping cycle plan scheduled as work, never filed | `service-cycles.spec` (office adds pumping visits; booked as a work order, never an inspection); B's `service-cycle-homeowner.spec` (2); API `service-cycles.test` (kept out of inspection lists; pumping-only contract has no inspections) | browser passed (suite 101/102); API 879/879 | browser passed (suite **106/106**); API carried (source unchanged) | — |
| 14 | Conventional site + installation signature | `installation.spec` (two visits, final-only signature, summary PDF in office and portal) | browser passed (suite 101/102) | browser passed (suite **106/106**) | — |
| 15 | Map with mixed kinds | `work-map.spec`, `route-map.spec`; same-origin from `sw12-row22-demo-network.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | — |
| 16 | Example County CSV export | `sw12-row16-county-csv.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | Forced failed send (test-only); fictional authority |
| 17 | Tenant isolation on every new route | `sw12-tenant-sweep.test` (route inventory incl. `/obligations`; booked-visit and `POST /jobs` probes; mutation-checked) | API 879/879 (incl. this test) | API carried (source unchanged) | — |
| 18 | Role matrix | `sw12-role-matrix.test` (91 routes; booking a cycle visit is office/owner only; mutation-checked) | API 879/879 (incl. this test) | API carried (source unchanged) | — |
| 19 | Ended/expired demo clears phone work | `phone-compat.spec` (ended demo removes both DBs), `revoked-tech-cache.spec`; API `demo-reseed.test` | browser passed (suite 101/102); API 879/879 | browser passed (suite **106/106**); API carried (source unchanged); root final Drill A kept the phone's work database through the floor rollback (that is not an ended-demo check) | G-DEVICE |
| 20 | Read-only org with pending phone work | `sw12-read-only-phone.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | — |
| 21 | Export and scratch backup/restore with new data | API `exports.test`; **Drill B** backup/restore with SW-6/SW-7/SW-9 fixtures (manifest checksums, completion PDFs, signed-document hashes, cycle visits keeping their work orders; whole-table hashes include `contract_service_cycles`) | API 879/879; root Drill B PASS 17/17 (corrected rerun) | API carried (source unchanged); Drill B carried (server/data source unchanged; `APP_FLOOR=be44166`) | Root's staging pre-deploy backup and scratch restore PASSED: `db-20261008T235721Z.dump` plus files with the same stamp; 101 tables, 4,983 rows, 28 orgs, 0060, 99 readable files (replaces the 22:56:38Z backup). Local Drill B content checks are separate. |
| 22 | No outbound requests in the demo | `sw12-row22-demo-network.spec` (positive-control probe; office, homeowner, phone walk); API `demo-isolation.test` | browser passed (suite 101/102); API 879/879 | browser passed (suite **106/106**); API carried (source unchanged) | Browser-side requests only; server side is `demo-isolation.test` |
| 23 | Deposit over final, refund beyond free, webhook refund | API `deposits.test` | API 879/879 | API carried (source unchanged) | Row device is Office + API |
| 24 | QuickBooks tax mismatch, lost-response retry | API `quickbooks.test` ("never creates a second invoice when QuickBooks' answer is lost"; quarantine and release) | API 879/879 | API carried (source unchanged) | Test provider |
| 25 | Racing covered work orders; cancel/void/override | API `plan-versions.test` | API 879/879 | API carried (source unchanged) | — |
| 26 | Reassigned/cancelled/office-completed while offline | `sw12-row26-33-phone-held.spec`, `work-phone.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | G-DEVICE |
| 27 | Re-sign after edit; template change offline | `sw12-row27-phone-resign.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | — |
| 28 | Storage full; permanently failed upload | `phone-storage.spec`, `disposal-storage.spec` (#117 product fix); `phone-storage.spec:149` asserts no "All changes sent" before Try again | browser passed (suite 101/102) | browser passed (suite **106/106**); banner fix covered (`sync-banner.spec`, `pumping.spec`, `phone-storage.spec`) | Browser quota simulation, not a physical phone |
| 29 | Expired demo / expired session with pending work | `revoked-tech-cache.spec`, `phone-compat.spec` | browser passed (suite 101/102) | browser passed (suite **106/106**) | — |
| 30 | Two-visit install; work job vs aerobic obligation | `installation.spec`; API `work-kind-guards.test` | browser passed (suite 101/102); API 879/879 | browser passed (suite **106/106**); API carried (source unchanged) | — |
| 31 | Two pumping cycles on one contract | API `service-cycles.test` (each cycle numbers from 1; booking twice or concurrently gives one work order) | API 879/879 | API carried (source unchanged) | Plan's "one live job" is one live work order per visit |
| 32 | NULL/forged kind columns (SQL) | API `work-kind-guards.test`; `service-cycles.test` (unnamed or mismatched cycles refused; inspections and work orders kept to their own kind) | API 879/879 | API carried (source unchanged) | — |
| 33 | Reassign/cancel before first sync / first upload | `sw12-row26-33-phone-held.spec`; API `work-sync.test` R4 1–5 | browser passed (suite 101/102); API 879/879 | browser passed (suite **106/106**); API carried (source unchanged) | — |
| 34 | Unassigned technician sends a record | API `work-sync.test` (403 `not_assigned`, nothing stored) | API 879/879 | API carried (source unchanged) | — |
| 35 | Fully deposit-funded final, refund the job, void, re-invoice | API `deposits.test` | API 879/879 | API carried (source unchanged) | — |
| 36 | Pump-out correction after load; liters+gallons; manifest after reset | API `pumping.test` (canonical total; correction after load; manifest kept; demo removal); `pumping.spec` | **`pumping.spec.ts:110` FAILED** (false "All changes sent"); API 879/879 | browser passed (suite **106/106**); API carried (source unchanged); banner fix covered (`sync-banner.spec`, `pumping.spec`, `phone-storage.spec`) | — |
| 37 | Pending→failed refund, success, dashboard refunds, void | API `deposits.test` (worked example) | API 879/879 | API carried (source unchanged) | — |

## Drill notes (root)

- **Final Drill A on `9daf3d7`**: PASS, exit 0. Before 2/0, floor `a39e875` 8/0, forward 6/0. Seven unsent work changes kept; inspection sent exactly once; the final repair has 1 record, 2 photos, 1 signature and 1 completion; outbox empty; no VersionError. Root's logs: `sw12-final-drill-a-9daf3d7.log` and the `final-drill-a-9daf3d7` folder. Root also ran an independent web build and focused browser checks, 6/6 passed.
- **Earlier, on `97aca5b`:**

- **Drill A**: passed. Phases reported 2, 8 and 6 checks, all with fails=0. Phone web floor `a39e875`.
- **Drill B, first run**: reported 17/17 steps but is NOT counted as a pass. Root's local Docker psql wrapper used `docker exec -i`. That consumed the outer table loop's stdin after the first table, so the whole-table snapshot held 1 table and the table-hash evidence was invalid. This was an infrastructure (wrapper) fault, not a product or script change.
- **Drill B, corrected rerun**: PASSED 17/17 steps, 0 fails, on the same `97aca5b` with `APP_FLOOR=be44166`.
  - The 97 content-compared tables (excluding audit_events, platform_audit_events, schema_migrations and sessions) were identical across all 4 phases (final, floor, roll forward, restore). Snapshot SHA-256: `ae43adb6c0289e959b1308161ef613acf7f7a4489ff27e7044967902160c3eec`.
  - Fixture checks: 9/0.
  - Reads: 123 each on final, floor and roll forward.
  - Files: 18 checks each on roll forward and on the restored server. 30 files matched by checksum.
  - No API errors.
- **Staging (root, informational, not part of the suite)**:
  - All 8 flags are on, migration 0060 is applied, and the `be44166` deployment is healthy.
  - A fresh private demo completed a cycle visit on the phone: 1000 gallons and a TEST manifest photo.
  - The customer's pumping-only renewal preview showed 2 visits and no aerobic promise. Nothing was signed or paid.
  - Customer portal (UI): "Tank pumping 1 of 2 done", next visit Apr 7 to May 7, and no inspection history. In the database the site has 0 inspections and 0 filings. The older manual installation and conventional records (2) were retained.
- **Staging disposal PDF (row 6/36)**: the normal staging download link is blocked by Brave (ERR_BLOCKED_BY_CLIENT). This is a bounded browser limitation; there was no bypass. The PDF was checked separately with local renderer QA.
- **Staging pre-deploy backup and scratch restore (root, 23:57Z, current for row 21)**: PASSED. `db-20261008T235721Z.dump` plus files with the same stamp: 101 tables, 4,983 rows, 28 orgs, 0060, 99 readable files. Staging was still `be44166` with all 8 flags and safe DEMO; production was unchanged.
- **Earlier staging backup and scratch restore (root, 22:56Z, superseded)**: PASSED.
  - Database dump `db-20261008T225638Z.dump` plus a matching files tar.
  - Restored contents: 101 tables, 4896 rows, 28 organizations, migration 0060, 99 files. The archive is readable.
  - Files are server-local only (no R2).
  - The restore check ran in a throwaway staging container only.

## Next

Root independently reviewed the source, primary completion excerpts and all 37 rows, then merged #116 at `a444be2d33bcc347a9a9ebdbe090828ddb62055f`. The non-doc/non-README tree matches tested 9daf3d7 exactly. The official staging deployment passed; final API/queue HTTP200, worker health, all8flags/safeDEMO and unchanged production passed. Normal portal/technician/disposal views and read-only DB counts retain the manual demonstration records. See RUNBOOK and the current handoff for details. Physical-phone, real-provider/deposit accounting/legal and authority-acceptance gates remain open.
