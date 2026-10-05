#!/bin/sh
# Runs on the server: restores one environment from backup.sh's files. Replaces the
# database and the stored files, so the app is stopped while it runs.
#   deploy/vps/restore.sh staging|production <db-....dump> [<files-....tar.gz>]
set -eu
env=${1:?usage: restore.sh staging|production <db dump> [files tarball]}
dump=${2:?usage: restore.sh staging|production <db dump> [files tarball]}
files=${3:-}
[ -r "$dump" ] || { echo "cannot read $dump" >&2; exit 1; }

echo "$env: stopping the app"
docker stop "aerowise-$env-web-1" "aerowise-$env-worker-1" "aerowise-$env-api-1" >/dev/null
echo "$env: restoring the database from $dump"
docker exec "aerowise-$env-db-1" psql -U aerowise -d postgres -qc "drop database if exists aerowise with (force)" -c "create database aerowise"
docker exec -i "aerowise-$env-db-1" pg_restore -U aerowise -d aerowise --no-owner < "$dump"
if [ -n "$files" ]; then
  echo "$env: restoring files from $files"
  docker run --rm -v "aerowise-${env}_files:/files" -v "$(cd "$(dirname "$files")" && pwd):/in:ro" alpine:3 \
    sh -c "rm -rf /files/* && tar xzf /in/$(basename "$files") -C /files"
fi
docker start "aerowise-$env-api-1" "aerowise-$env-worker-1" "aerowise-$env-web-1" >/dev/null
echo "$env: restored; the app is starting"
