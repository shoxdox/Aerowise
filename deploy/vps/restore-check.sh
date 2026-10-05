#!/bin/sh
# Proves a backup can be restored, without touching the running app: restores a dump into a
# throwaway Postgres container, compares every table's row count with the live database,
# and checks the files tarball reads back. Prints a summary to paste into RUNBOOK.md.
#   deploy/vps/restore-check.sh <env>                 the newest backup on this server
#   deploy/vps/restore-check.sh <env> <db-....dump>   that dump (and its files tarball beside it)
#   deploy/vps/restore-check.sh <env> r2              the newest copy in R2 (what a lost server leaves)
# Exits non-zero when the restore fails or the restored database does not match the live one's shape.
set -eu
umask 077
env=${1:?usage: restore-check.sh <env> [dump | r2]}
src=${2:-}
dir=${BACKUP_DIR:-/var/backups/aerowise}/$env
live=${LIVE_DB_CONTAINER:-aerowise-$env-db-1}
image=${POSTGRES_IMAGE:-postgres:16-alpine}
scratch=aerowise-restore-check-$env
work=$(mktemp -d)
cleanup() {
  docker rm -f "$scratch" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

case $src in
"") dump=$(ls -1 "$dir"/db-*.dump 2>/dev/null | sort | tail -n 1) ;;
r2) dump=$("$(dirname "$0")/offsite.sh" "$env" fetch latest "$work" | tail -n 1) ;;
*) dump=$src ;;
esac
[ -n "$dump" ] && [ -r "$dump" ] || { echo "$env: no backup to check (looked for ${src:-$dir/db-*.dump})" >&2; exit 1; }
stamp=${dump##*/db-}
stamp=${stamp%.dump}
files=$(dirname "$dump")/files-$stamp.tar.gz

echo "$env: restoring $dump into a scratch database"
docker rm -f "$scratch" >/dev/null 2>&1 || true
docker run -d --name "$scratch" -e POSTGRES_USER=aerowise -e POSTGRES_PASSWORD="$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')" \
  -e POSTGRES_DB=aerowise --tmpfs /var/lib/postgresql/data "$image" >/dev/null
i=0
until docker exec "$scratch" pg_isready -U aerowise -d aerowise -q 2>/dev/null && docker exec "$scratch" psql -U aerowise -d aerowise -qtAc "select 1" >/dev/null 2>&1; do
  i=$((i + 1))
  [ $i -lt 60 ] || { echo "$env: the scratch database did not start" >&2; exit 1; }
  sleep 1
done
docker exec -i "$scratch" pg_restore -U aerowise -d aerowise --no-owner --exit-on-error < "$dump"

# Exact row counts for every table, as "table count" lines, sorted.
counts() {
  docker exec "$1" psql -U aerowise -d aerowise -qtA -F ' ' -c "
    select table_name, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', table_name), false, true, '')))[1]::text::bigint
    from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' "
}
last_migration() {
  docker exec "$1" psql -U aerowise -d aerowise -qtAc "select max(name) from schema_migrations"
}
counts "$scratch" | LC_ALL=C sort > "$work/restored"
counts "$live" | LC_ALL=C sort > "$work/live"
cut -d" " -f1 "$work/restored" > "$work/restored-tables"
cut -d" " -f1 "$work/live" > "$work/live-tables"
restored_migration=$(last_migration "$scratch")
live_migration=$(last_migration "$live")

problems=0
echo
printf '%-34s %10s %10s\n' table backup live
LC_ALL=C join -a 1 -a 2 -e - -o 0,1.2,2.2 "$work/restored" "$work/live" | while read -r t b l; do
  note=
  [ "$b" = - ] && note="  missing from the backup"
  [ "$l" = - ] && note="  missing from the live database"
  printf '%-34s %10s %10s%s\n' "$t" "$b" "$l" "$note"
done
tables=$(wc -l < "$work/restored" | tr -d ' ')
rows=$(awk '{ n += $2 } END { print n + 0 }' "$work/restored")
echo
if [ "$restored_migration" != "$live_migration" ]; then
  echo "note: the backup's last migration is $restored_migration and the live one's is $live_migration (a deploy since the backup)"
elif ! cmp -s "$work/restored-tables" "$work/live-tables"; then
  echo "PROBLEM: the backup and the live database have different tables at the same migration"
  problems=1
fi
[ "$tables" -gt 0 ] || { echo "PROBLEM: the backup has no tables"; problems=1; }
orgs=$(awk '$1 == "organizations" { print $2 }' "$work/restored")
[ "${orgs:-0}" -gt 0 ] || { echo "PROBLEM: the backup has no organizations"; problems=1; }

if [ -r "$files" ]; then
  n=$(tar tzf "$files" | grep -vc '/$' || true)
  echo "files: $files reads back, $n files"
else
  echo "files: no files tarball beside the dump (with R2 on, files live in R2)"
fi

echo
if [ "$problems" -eq 0 ]; then
  echo "RESTORE CHECK PASSED $env $(date -u +%Y-%m-%d) dump=$(basename "$dump") tables=$tables rows=$rows organizations=$orgs migration=$restored_migration"
else
  echo "RESTORE CHECK FAILED $env $(date -u +%Y-%m-%d) dump=$(basename "$dump")"
  exit 1
fi
