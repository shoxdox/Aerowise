#!/bin/sh
# Runs on the server, nightly from cron: backs up one environment's database (pg_dump,
# custom format) and stored files, and keeps BACKUP_KEEP_DAYS days of them.
#   deploy/vps/backup.sh staging|production
# Copies stay on this server until W3.5 adds an offsite copy; see docs/engineering/DEPLOY.md.
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
