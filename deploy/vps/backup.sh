#!/bin/sh
# Runs on the server, nightly from cron: backs up one environment's database (pg_dump,
# custom format) and stored files, and keeps BACKUP_KEEP_DAYS days of them.
#   deploy/vps/backup.sh staging|production
# With R2 settings in /etc/aerowise/<env>.env, each backup is also copied to R2 and read back
# (offsite.sh). With BACKUP_HEARTBEAT_URL set, a backup that finished is reported there, so a
# monitor (for example Healthchecks.io) emails when one does not. See docs/engineering/RUNBOOK.md.
set -eu
# Dumps hold customer data and password hashes: readable by root only.
umask 077
env=${1:?usage: backup.sh staging|production}
dir=${BACKUP_DIR:-/var/backups/aerowise}/$env
keep=${BACKUP_KEEP_DAYS:-14}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$dir"

docker exec "aerowise-$env-db-1" pg_dump -U aerowise -Fc aerowise > "$dir/db-$stamp.dump.partial"
mv "$dir/db-$stamp.dump.partial" "$dir/db-$stamp.dump"
docker run --rm -v "aerowise-${env}_files:/files:ro" -v "$dir:/out" alpine:3 \
  tar czf "/out/files-$stamp.tar.gz.partial" -C /files .
chmod 600 "$dir/files-$stamp.tar.gz.partial"
mv "$dir/files-$stamp.tar.gz.partial" "$dir/files-$stamp.tar.gz"

find "$dir" -name 'db-*.dump' -mtime +"$keep" -delete
find "$dir" -name 'files-*.tar.gz' -mtime +"$keep" -delete
echo "$env: backed up to $dir/db-$stamp.dump and files-$stamp.tar.gz"

# Off the server. A failed copy fails the backup (and so its heartbeat); no R2 settings (exit 3)
# keeps the copies here only, which is fine for staging's demo data.
offsite=0
"$(dirname "$0")/offsite.sh" "$env" push "$dir/db-$stamp.dump" "$dir/files-$stamp.tar.gz" || offsite=$?
[ "$offsite" -eq 0 ] || [ "$offsite" -eq 3 ] || { echo "$env: copying off the server FAILED" >&2; exit "$offsite"; }

heartbeat=$(sed -n 's/^BACKUP_HEARTBEAT_URL=//p' "${AW_ETC:-/etc/aerowise}/$env.env" 2>/dev/null | tail -n 1)
if [ -n "$heartbeat" ]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$heartbeat" || echo "$env: could not reach BACKUP_HEARTBEAT_URL" >&2
fi
