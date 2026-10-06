# Runbook: backups and restore

For whoever runs the server. It covers what is backed up, how to check it, and how to restore, from a recent mistake up to a lost server. Commands run on the server as root (`sudo -i`) unless a step says otherwise. `<env>` is `staging` or `production`.

## What is backed up, and where

| What | How | Kept |
|---|---|---|
| The database | `pg_dump -Fc` nightly by [`backup.sh`](../../deploy/vps/backup.sh): 08:30 UTC production, 08:45 UTC staging | 14 days on the server, in `/var/backups/aerowise/<env>/db-<stamp>.dump` |
| Files on the server's disk (outbox mail, and photos and PDFs while R2 is off) | a tarball of the `aerowise-<env>_files` volume, in the same run | 14 days, as `files-<stamp>.tar.gz` beside the dump |
| Both, off the server | [`offsite.sh`](../../deploy/vps/offsite.sh) copies each to `backups/<env>/` in the R2 bucket, then downloads it again and compares it byte for byte. A copy that fails or does not match fails the backup. | 35 days (`BACKUP_OFFSITE_KEEP_DAYS`); old copies are deleted only after a new one checked out |
| Photos and signed PDFs in R2 | not copied anywhere else yet (see "Open" below) | |

The dumps hold customer data and password hashes. They are readable by root only on the server, and the R2 bucket is private. Staging holds demo data only; without R2 lines in `staging.env` its backups stay on the server, which is fine.

Logs: `/var/log/aerowise-backup.log` (nightly) and `/var/log/aerowise-restore-check.log` (weekly).

On the server (since 2026-10-06) the reviewed `backup.sh`, `offsite.sh` and `restore-check.sh` are installed in `/usr/local/lib/aerowise/vps/`, with the source commit and each file's hash in `release.json` there, and `/etc/cron.d/aerowise` runs them from that folder. That keeps backups independent of which commit each app checkout is deployed at. The commands below name `/opt/aerowise/<env>/deploy/vps/`; on that server use `/usr/local/lib/aerowise/vps/` instead, and update it from a reviewed commit when these scripts change.

## Is it working?

- **A missed backup emails you** when `BACKUP_HEARTBEAT_URL` is set: a Healthchecks.io check (free) with a 1-day period and a few hours' grace. `backup.sh` pings it only after the dump, the tarball and the checked copy in R2 all succeeded.
- **Every Sunday at 09:30 UTC,** [`restore-check.sh`](../../deploy/vps/restore-check.sh) restores production's newest copy *from R2* into a scratch Postgres container and compares every table's row count with the live database. The last line of its log is `RESTORE CHECK PASSED ...` or `RESTORE CHECK FAILED ...`:
  `tail -n 3 /var/log/aerowise-restore-check.log`
- **By hand:**
  ```sh
  tail -n 5 /var/log/aerowise-backup.log
  ls -lt /var/backups/aerowise/production | head
  /opt/aerowise/production/deploy/vps/offsite.sh production list | tail -n 4
  ```

## Check a backup without touching the app

```sh
/opt/aerowise/<env>/deploy/vps/restore-check.sh <env>            # the newest backup on the server
/opt/aerowise/<env>/deploy/vps/restore-check.sh <env> r2         # the newest copy in R2
/opt/aerowise/<env>/deploy/vps/restore-check.sh <env> <path/to/db-<stamp>.dump>
```

It starts a throwaway Postgres (`aerowise-restore-check-<env>`, data in memory), restores the dump with `--exit-on-error`, and prints a table of row counts: backup against live. It fails when the restore fails, when the backup has no tables, when the two databases have different tables at the same migration, or when a table had rows at backup time but none restored. `backup.sh` records every table's row count just before the dump (`db-<stamp>.counts`, copied to R2 with it), so a table that was still empty then, like everything on a production with no companies yet, does not count as missing. Backups from before the counts existed are compared with the live database instead. The live database normally has a few more rows than the backup (work done since the backup). A deploy since the backup shows as a note about the migration. It also lists the files tarball, if there is one. The scratch container is removed when it finishes, whatever happens.

## Restore

`restore.sh` **replaces** the environment's whole database (and its files, when a tarball is given). Everything written since that backup is lost, so first decide which backup is right and tell the companies affected.

### A recent mistake (the server is fine)

1. Pick the backup from before the mistake: `ls -lt /var/backups/aerowise/<env>/`.
2. Optional but recommended: take a backup of the current state, so the restore can be undone: `/opt/aerowise/<env>/deploy/vps/backup.sh <env>`.
3. Check the chosen backup: `restore-check.sh <env> /var/backups/aerowise/<env>/db-<stamp>.dump`.
4. Restore it. This stops the app, drops and recreates the database, restores, and starts the app again:
   ```sh
   /opt/aerowise/<env>/deploy/vps/restore.sh <env> /var/backups/aerowise/<env>/db-<stamp>.dump /var/backups/aerowise/<env>/files-<stamp>.tar.gz
   ```
   Leave out the tarball to keep the files as they are. With R2 on, photos and PDFs live in R2 and are not touched either way.
5. Open the site, sign in, and check the data the mistake touched. `curl -s https://<domain>/api/health` should answer `ok`.

If the mistake touched only one company, restoring everything would undo the other companies' work since the backup. Restore into the scratch database instead and copy that company's rows across by hand. Ask for help before doing this on production.

### The server is lost

1. Get a new server and point the `staging` and `app` DNS records at it.
2. Run the setup from [the server setup checklist](DEPLOY.md) (`setup.sh` twice, the deploy key) and put the production settings back in `/etc/aerowise/production.env`. **Use the same `R2_*` values**, and keep a copy of that file somewhere safe outside the server (a password manager), because the R2 token is how you get the backups back.
3. Deploy production once, so its containers exist (step 5 of the checklist).
4. Fetch the newest copy from R2 and check it:
   ```sh
   /opt/aerowise/production/deploy/vps/offsite.sh production fetch latest /var/backups/aerowise/production
   /opt/aerowise/production/deploy/vps/restore-check.sh production /var/backups/aerowise/production/db-<stamp>.dump
   ```
   `offsite.sh production list` shows every copy; pass a name instead of `latest` for an older one.
5. Restore it: `restore.sh production /var/backups/aerowise/production/db-<stamp>.dump /var/backups/aerowise/production/files-<stamp>.tar.gz`.
6. Deploy again, so migrations newer than the backup run, then check the site as above.

With R2 on, photos and PDFs never left R2, so nothing more is needed for them. A new staging just starts from the demo data.

## Restore record

Each restore or restore check run for the record: date, where, which backup, and the result. Newest at the bottom.

| Date | Where | Backup | Result |
|---|---|---|---|
| 2026-10-05 | Local test of the scripts (Docker Postgres 16 named like the server's, rclone's S3 server standing in for R2), with the synthetic demo seed | `db-20261005T233657Z.dump`, fetched back from the R2 stand-in | Passed. `restore-check.sh staging r2`: 63 tables, 463 rows, 1 organization; every table's count matched the live database (for example customers 50/50, sites 55/55, contracts 52/52, service obligations 156/156), same last migration (`0026_demo_requests.sql`), files tarball read back (2 files). Then all customers (and everything under them) and all files were deleted, and `restore.sh` with the copy fetched from R2 brought back customers 50, sites 55, contracts 52 and both files. A truncated dump made the check fail, a wrong R2 secret failed the backup, and a copy changed in the bucket failed the read-back. |
| 2026-10-06 | Staging on the server (run by Codex for Justin) | `db-20261006T003819Z.dump`, on the server | Passed: 65 tables, 485 rows, 1 organization, last migration `0030_site_customer_type.sql`. |
| 2026-10-06 | Production on the server (run by Codex for Justin) | `db-20261006T004009Z.dump`, copied to R2, checked, fetched back from R2 | Restored cleanly; all 65 tables' counts matched live (1 platform admin, no companies yet); files archive read back. Reported FAILED only because the check then required at least one organization, which a new production cannot have. Fixed in #56 (counts recorded at backup time) and run again below. |
| 2026-10-06 | Production on the server, scripts from #56 (`dd40486`), run by Codex for Justin | `db-20261006T011529Z.dump` with its counts and files archive, copied to R2, read back, then fetched from R2 | `RESTORE CHECK PASSED production 2026-10-06 dump=db-20261006T011529Z.dump tables=65 rows=40 organizations=0 migration=0029_organization_settings.sql` |
| 2026-10-06 | Staging on the server, same scripts | `db-20261006T011531Z.dump`, on the server | `RESTORE CHECK PASSED staging 2026-10-06 dump=db-20261006T011531Z.dump tables=67 rows=502 organizations=1 migration=0031_plan_reminders.sql` |

## Open

- Photos and signed PDFs in R2 have no second copy. R2 keeps them durably, but a bug or a leaked token could delete them. One option is a nightly copy of the bucket to the server's disk, keeping deleted objects for 35 days.
- The backups use the app's R2 token unless `BACKUP_R2_*` is set. A separate token, or better a separate bucket whose token the app never holds, means a compromised app cannot delete its own backups.

## Staging deployment and walkthrough — October 6, 2026

Scope: staging only at https://staging.deshain.com, on `vultr-beta` (45.76.29.23, SSH 62008). An existing production deployment was discovered and is outside this operation. No production deploy, DNS change, signup or purchase is authorized or performed.

1. Read DEPLOY.md, this runbook, DEMO-PILOT-BRIEF.md and deploy/vps. Fetch origin; starting main is `0b77a6339ee082fbb941032ff63554b1cfdb1515`. Preserve the untracked Next.js guidance files.
2. Inspect via SSH: nginx owns 80/443, Docker 29.8.2 / Compose 5.6.0 installed, root disk has 34 GB free, RAM 3910 MB with 1316 MB available and 7899 MB swap. DNS already points through Cloudflare; no sslip.io or DNS edits needed. Existing origin certificate covers staging and expires January 3, 2027; public /api/health returned 200.
3. Privileged commands use existing owner-supplied SSH/sudo access with a protected local helper; never put secrets in command output or this repo. Inspect current containers, cron, nginx and settings using key-presence summaries, not credential values.
4. Stop staging API/worker before walkthrough actions. Save `/etc/aerowise/staging.env` to root-only `/root/aerowise-staging-before-walkthrough.env`. Clear DEMO_LIVE_SERVICES, notification recipient, Resend, R2, backup R2/heartbeat, Stripe, QuickBooks client credentials, Twilio and Sentry. Keep DEMO_MODE=true. Mail/SMS/payments/accounting/storage must use local stand-ins. Resend is absent, so EMAIL_REDIRECT_TO is unnecessary and no mail can be sent. Production settings/containers are left alone.
5. Fix setup.sh to support `--staging-only` before running: its default also provisions production. Preserve production cron entries; move staging maintenance to `/etc/cron.d/aerowise-staging`, remove duplicate old staging jobs, reuse current certificate, fail on nginx/certificate errors.
6. Copy the fixed setup script to `/tmp/aerowise-setup-staging.sh`; run `sudo bash /tmp/aerowise-setup-staging.sh deshain.com <existing ACME email> --staging-only`. It fetches current main before installing templates and invokes deploy.sh staging automatically. Save deploy output locally (credentials are not printed). Existing shared HTTPS certificate verified through localhost; nginx syntax passed.
7. `gh secret list` confirmed VPS_HOST, VPS_SSH_PORT, VPS_KNOWN_HOSTS and VPS_SSH_KEY already installed. Preserve the existing key. GitHub run 37539820597 check annotation says jobs never started due to account payment/spending limit. Do not claim CI passed; use manual deploy.
8. Playwright CLI's default Chrome path is absent. Use already-installed Chromium at `~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` through a temporary CLI configuration; 1440×1000 desktop and 390×844 phone views. Screenshots go to output/playwright, reviewed evidence to docs/engineering/staging-walkthrough-2026-10. No browser install or account needed.
9. Refresh GitHub secret values with `gh secret set VPS_HOST --body 45.76.29.23` and `gh secret set VPS_SSH_PORT --body 62008`; pass the existing protected known-hosts file to `gh secret set VPS_KNOWN_HOSTS`. Retain the existing VPS_SSH_KEY. The server's read-only repository key passed GitHub's SSH authentication probe. Workflow run 37539820597 still failed before executing due to account restrictions. No money or account changes made.
10. Before reseeding, run `/opt/aerowise/staging/deploy/vps/backup.sh staging` then `restore-check.sh staging`. Pre-walkthrough copy `db-20261006T232258Z.dump` passed: 69 tables, 581 rows, 1 organization, migration 0038, zero stored files. This preserves the old staging state; it is unrelated to production backups.
11. Setup deployed `e323dbfa0936a063e6dede7473388158b5010ad8`. Run `docker exec aerowise-staging-api-1 pnpm db:reseed-demo` once manually (same command as installed cron). It emptied 67 resettable tables, seeded 55 sites / 52 contracts / 9 jobs, then added the demo story (2 filings, 1 renewal, 2 invoices). Verify `/etc/cron.d/aerowise-staging`, cron service, certbot timer, `curl -fsS https://staging.deshain.com/api/health`, and `docker exec aerowise-staging-worker-1 pnpm --filter @aerowise/worker health`. API returned ok; worker's last pass was 1 second old. Reseed preserves platform admins and demo requests, but currently deletes all tenant organizations, including prospect demos/trials: STG-01. Do not use this command on production.
12. Create a staging platform admin using `pnpm db:create-platform-admin walkthrough.admin@example.com 'TEST Staging Walkthrough'` inside the API container, supplying a generated password through stdin using a protected temporary file; delete the server-side temporary password file. Store the resulting credentials locally, mode 0600, at `/home/deshain/.codex/aerowise-setup-session/staging-admin.private.txt`. Never commit credentials or browser session state. Nightly reseed preserves this admin. Use a separate browser context for admin and another temporary/private context for prospect owner/technician verification.
13. Complete marketing request with TEST company, example.com email and reserved 555-0110 phone. Verify success and `/admin/demo-requests` receipt. Enter the public visitor demo; switch Owner/Office/Technician through the banner. Visit inbox, due, site/county panel, filings/detail/proof, renewal/detail, invoice/detail, billing/subscription and Company settings. Save real-looking email/phone once to verify refusal, then restore synthetic values. Screenshots 01–22 record the actions.
14. As office, assign an overdue visit to Oct 6 (stops 5→6). Upload the two-row `staging-walkthrough-2026-10/synthetic-import.csv` through Import. Preview, import, open `/import/summary`, undo through the import detail and confirm zero remaining TEST Ivy Import customers. Screenshots 23–27. No real CSV data was used.
15. Resize technician context to 390×844. Grant simulated browser location 30.149463,-98.38468. Open Carlos Gonzales; mark required checks Pass, air pressure 4, working chlorinator, chlorine 1.5, odor None, pump-out No and TEST notes. Upload existing `apps/api/src/demo-assets/demo-overview.jpg` and `demo-chlorinator.jpg` fixture JPEGs through the photo inputs (use the actual fixture paths from the checkout). Verify refusing missing required readings/photos, then complete. Open Michael Whitfield with browser context offline; repeat inspection/photos, complete, reload offline, confirm pending local work remains. Reconnect. Before reconnect, intercept `**/api/inspections/sync`: when the first POST's parsed body has status completed, `route.fetch()` to let the server process it, then abort that response with connectionreset; subsequent requests continue normally. After automatic retry, reload and verify only one added inspection, two photos, one completion audit and one filing using database counts scoped to visitor organization `c500cd55-6483-43fb-be26-97b47d86e0a1`. Evidence: offline-before.txt, offline-pending-server.txt, offline-after.txt and screenshots 28–42. This is desktop browser network emulation, not a physical phone test.
16. As owner, invite `staging.tech@example.com` with TEST name, request a password reset for the generated demo owner address, and inspect `/data/files/<organization>/outbox/` in the API container. Extract only subject, recipient, transport and time; never publish invite/reset tokens or raw mail. `outbox-evidence.json` proves three local-outbox notifications (demo request, invite, reset). Resend and Twilio are absent. Export from the owner page, wait for Ready, download the ZIP locally and inspect contents: 12 CSVs, 10 PDFs, README and DEMO-FICTIONAL-DATA.txt. Render a sample PDF with pdftoppm to verify diagonal watermark/footer. Standalone CSVs are not labeled: STG-07. No downloaded ZIP or raw credentials are committed.
17. In `/admin/prospect-demos`, make Example Septic LLC with Comal County, Hays County and 14 days. Open the copied link in the isolated prospect context; verify company name. Upload synthetic PNG logo via owner's Company settings and reload. Query sites grouped by county: all 55 are Example County (STG-04). Use Technician role switch on phone view; there is no separate technician entry link. Start their trial through admin and accept confirmation: original demo and new non-demo trial both have zero customers/sites/memberships. Make a second Example Septic LLC demo to retest technician after deployment; End now and accept confirmation. Verify zero database records and refused entry link. Previously downloaded technician route remains visible after reload: STG-03. Access tokens shown in evidence screenshots were revoked by conversion/end.
18. Open `/admin/rulesets`, then Bastrop draft. Record a fabricated call with TEST identity, test@example.com, explicit TEST reference and note, date 2026-10-06, first open question, Where reports go, outcome Answers part of it and answer stating the channel remains unconfirmed. The saved question badge changes; authority remains Draft. Select Use in the next version, Prepare v2 and inspect proposal/diff. Nothing is published. Cleanup is staging-only: copy `staging-walkthrough-2026-10/remove-test-evidence.sql` to a temporary server path, execute with `docker exec -i aerowise-staging-db-1 psql -v ON_ERROR_STOP=1 -U aerowise -d aerowise < <file>`, then remove the temporary server file. The transaction locks both evidence tables, asserts exactly one matching TEST row for this admin/jurisdiction/note, briefly disables only their immutable triggers, deletes that row/answer, restores triggers and commits. Result: zero TEST notes, both triggers enabled; platform audit remains. Never use this maintenance exception for real authority evidence. Reload confirms Draft/Open again. No real authority was called or verified.
19. There is no app call-sheet PDF action. Generate a manual copy of docs/PILOT-CALL-SHEET.md using the preserved `staging-walkthrough-2026-10/generate-call-sheet.py` with reportlab and embedded system DejaVu fonts. Run from repo root; script writes `output/pdf/aerowise-pilot-call-sheet.pdf` (make the output directory first). Render both pages with `pdftoppm -scale-to 1400 -png ...`, inspect, and request the PDF preview in Codex (open tool returned queued). A Playwright file:// attempt was blocked; no screenshot from that failed navigation is retained. Preserve PDF and page images in the evidence folder. This fallback does not implement the missing app action.
20. Fix test-payment copy and favicon metadata; web typecheck and targeted eslint pass. Commit `a80c4f09e18a7a21334abea77931fc0e6d10a647`, push main, then `/opt/aerowise/staging/deploy/vps/deploy.sh staging <commit>`. Compose waits for database/API/web/worker health. Brief 502s during container replacement cleared after health; retest billing/subscription copy and prospect Technician role successfully (screenshots 56, 65–66). This deploy is not zero-downtime.
21. Final backup: `/opt/aerowise/staging/deploy/vps/backup.sh staging`, followed by `/opt/aerowise/staging/deploy/vps/restore-check.sh staging`. `db-20261006T233953Z.dump` restored into scratch successfully: 73 tables, 1,328 rows, 5 organizations, migration 0046_prospect_demos.sql; files tarball read back with 59 files. Scratch removed by the script. Result in staging-walkthrough-2026-10/backup-restore-check.txt. No live restore was performed, and no backup was copied off-host because R2/heartbeat are disabled.
22. Recheck running API and worker environment using only presence booleans: DEMO_MODE true, live-services empty, no Resend/R2/Stripe/QuickBooks/Twilio/Sentry/notification credentials. Provider selection code and local outbox evidence confirm test stand-ins. Preserve provider-isolation.txt. Recheck production API identity/start time: unchanged `94b1e83679581aea27aa076ed6adede76f3df3e7f7d1e2d9befd6dff21d0707e`, started 2026-10-06T00:20:04.215915794Z. No production operation performed.
23. Review numbered screenshots, copy sanitized evidence into docs/engineering/staging-walkthrough-2026-10, write STAGING-WALKTHROUGH-2026-10.md and update DEMO-PILOT-BRIEF.md. Commit/push the handoff, then deploy that main commit with the same staging deploy.sh and verify its checkout, container health, public API/web/icon again. Record the command/output locally; do not claim hosted CI executed. Leave public demo entry usable, test prospect links revoked, test evidence removed, and admin credentials only in the protected local file.

Restore record for this operation: pre-walkthrough check passed on `db-20261006T232258Z.dump` (69 tables / 581 rows / migration 0038); final check passed on `db-20261006T233953Z.dump` (73 / 1328 / migration 0046). Staging backups are local only. All manual actions and deviations above were authorized by the staging walkthrough; costs/accounts/DNS were not changed.
