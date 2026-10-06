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
