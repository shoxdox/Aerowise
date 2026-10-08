#!/usr/bin/env bash
# SW-12 Drill B: run the application floor against a scratch database migrated and seeded by the
# final integration SHA (with service-workflow records added), roll forward again, then back up
# and restore the database and the stored files on scratch. Plan §12 rows 12 and 21 at the final
# SHA. Never staging or production.
#
#   APP_FLOOR=<sha> scripts/sw12/drill-app-floor.sh <final-worktree> <floor-worktree>
#
# APP_FLOOR is required and must equal the floor worktree's HEAD. Plan §9.2: 81048d3 is the core
# floor only until a non-aerobic obligation exists; after SW-9 merges the final app floor is SW-9's
# merge SHA (older due lists misclassify non-aerobic obligations). A run against 81048d3 after SW-9
# is a core-floor rehearsal, not final-floor evidence, and the results file says so.
#
# Both worktrees installed. Port 4000 must be free; the script stops only the process groups it
# started. Env: PGHOST_URL, FINAL_FEATURES (default: every flag in the final SHA's FEATURES), FLOOR_FEATURES (default:
# every flag the floor SHA knows; a rollback must drop flags the floor does not know), FLOOR_UNSUPPORTED
# (comma-separated path prefixes newer than the floor: reported as unsupported there, never as reads
# that passed).
#
# Verdict: every step of the drill must finish and report; a crash, a missing step marker or a
# failed check fails the drill. Steps after a failure still run, so the roll forward is always tried.
set -euo pipefail
FINAL=$(cd "$1" && pwd); FLOOR=$(cd "$2" && pwd)
PG=${PGHOST_URL:-postgres://aerowise:aerowise@localhost:5432}
DB=aerowise_drilltest_b; RDB=aerowise_drilltest_restore
URL=$PG/$DB; RURL=$PG/$RDB
# The final run uses every flag the final SHA knows (plan: final flags include all waves).
ALL_FEATURES=$(sed -n 's/^export const FEATURES = \[\(.*\)\] as const;$/\1/p' "$FINAL/packages/domain/src/features.ts" | tr -d ' "')
[ -n "$ALL_FEATURES" ] || { echo "could not read FEATURES from the final worktree" >&2; exit 2; }
FEATURES=${FINAL_FEATURES:-$ALL_FEATURES}
FLOOR_KNOWS=$(sed -n 's/^export const FEATURES = \[\(.*\)\] as const;$/\1/p' "$FLOOR/packages/domain/src/features.ts" | tr -d ' "')
FLOOR_FEATURES=${FLOOR_FEATURES:-$FLOOR_KNOWS}
OUT=${DRILL_OUT:-$(mktemp -d /tmp/sw12-drill-b.XXXX)}
FILES=$OUT/files; RFILES=$OUT/files-restored; mkdir -p "$FILES"
RESULTS=$OUT/results.txt; : > "$RESULTS"
FLOOR_SHA=$(git -C "$FLOOR" rev-parse HEAD)
[ -n "${APP_FLOOR:-}" ] || { echo "set APP_FLOOR to the floor SHA (81048d3 before SW-9 merges, SW-9's merge SHA after)"; exit 2; }
case "$FLOOR_SHA" in "$APP_FLOOR"*) ;; *) echo "floor worktree $FLOOR_SHA is not APP_FLOOR $APP_FLOOR"; exit 2;; esac
log() { echo "$*" | tee -a "$RESULTS"; }
log "Drill B: final $(git -C "$FINAL" rev-parse HEAD), floor $FLOOR_SHA, db $DB, out $OUT"
case "$FLOOR_SHA" in 81048d3*) log "NOTE floor 81048d3 is the core/pumping floor; it is not the final app floor once SW-9 has merged (plan §9.2)";; esac
[ -n "${FLOOR_UNSUPPORTED:-}" ] && log "NOTE newer than the floor, reported as unsupported there: $FLOOR_UNSUPPORTED"

declare -A STEPS=()   # step -> passed | FAILED (...)
ORDER=()
record() { ORDER+=("$1"); STEPS[$1]=$2; log "step $1: $2"; }
check() { if [ "$1" = ok ]; then record "$2" passed; else record "$2" "FAILED ${3:-}"; fi; }

declare -A PGIDS=()
listeners() { fuser -n tcp 4000 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true; }
owned() {
  local p g pids; pids=$(listeners); [ -n "$pids" ] || return 1
  for p in $pids; do g=$(ps -o pgid= -p "$p" | tr -d ' '); [ -n "${PGIDS[$g]:-}" ] || return 1; done
}
stop() {
  local g
  for g in "${!PGIDS[@]}"; do kill -- -"$g" 2>/dev/null || true; done
  for i in $(seq 1 30); do [ -z "$(listeners)" ] && { PGIDS=(); return 0; }; sleep 1; done
  for g in "${!PGIDS[@]}"; do kill -9 -- -"$g" 2>/dev/null || true; done; sleep 2
  PGIDS=()
  # Never kill a listener this drill did not start.
  [ -z "$(listeners)" ] || { echo "port 4000 still busy after stopping this drill's API; not touching other processes"; return 1; }
}
trap 'stop || true' EXIT
start() { # <worktree> <features> <label> <db-url> <files-dir>
  (cd "$1" && exec setsid env DATABASE_URL="$4" API_PORT=4000 FILE_STORAGE_DIR="$5" DEMO_MODE=true LOGIN_RATE_LIMIT=1000 AEROWISE_FEATURES="$2" \
    pnpm --filter @aerowise/api start > "$OUT/api-$3.log" 2>&1 < /dev/null) &
  PGIDS[$!]=1
  for i in $(seq 1 90); do
    if curl -sf localhost:4000/health >/dev/null; then owned && return 0; echo "something other than this drill's $3 API answers on 4000"; return 1; fi
    sleep 1
  done
  return 1
}
# Runs drills/app-floor.mjs and records it as a step; it must print its END marker with fails=0.
step() { # <name> <db-url> <mode> [args...]
  local name=$1 url=$2 rc=0 marker; shift 2
  (cd "$FINAL/apps/web" && DRILL_DATABASE_URL=$url node drills/app-floor.mjs "$@") > "$OUT/step-$name.txt" 2>&1 || rc=$?
  grep -E '^(FAIL|PASS.*UNSUPPORTED)' "$OUT/step-$name.txt" | tee -a "$RESULTS" || true
  marker=$(grep -E "^STEP $1 .* END checks=[0-9]+ fails=0$" "$OUT/step-$name.txt" | tail -1 || true)
  if [ "$rc" -eq 0 ] && [ -n "$marker" ]; then record "$name" "passed ($(grep -c '^PASS' "$OUT/step-$name.txt") checks)"
  else record "$name" "FAILED (exit $rc, marker: $(grep -E '^STEP ' "$OUT/step-$name.txt" | tail -1 || echo missing))"; fi
}
api_errors() { [ "$(grep -c '"level":50' "$OUT/api-$1.log" || true)" = 0 ] && check ok "$1 API logged no errors" || check fail "$1 API logged no errors" "(see $OUT/api-$1.log)"; }
# Every table's row count and content hash, except session and log tables that sign-ins write.
snapshot() { # <db-url> <file>
  psql "$1" -Atc "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
      and table_name not in ('sessions','audit_events','platform_audit_events','login_attempts','tasks','kysely_migration','kysely_migration_lock','schema_migrations')
      order by 1" | while read -r t; do
    echo "$t $(psql "$1" -Atc "select count(*) || ' ' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '-') from \"$t\" x")"
  done > "$2"
}
same() { # <label> <a> <b>
  if diff -q "$2" "$3" >/dev/null; then check ok "$1"; else check fail "$1"; diff "$2" "$3" | head -20 | tee -a "$RESULTS"; fi
}
manifest() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum); }

[ -z "$(listeners)" ] || { echo "port 4000 is in use; stop whatever runs there first"; exit 2; }
psql "$PG/postgres" -qc "drop database if exists $DB" -c "drop database if exists $RDB" -c "create database $DB"
rm -rf "$RFILES"
if (cd "$FINAL" && DATABASE_URL=$URL pnpm db:migrate && DATABASE_URL=$URL DEMO_MODE=true FILE_STORAGE_DIR="$FILES" AEROWISE_FEATURES=$FEATURES pnpm db:seed) > "$OUT/setup.log" 2>&1
then check ok "final SHA migrated ($(psql "$URL" -Atc "select count(*) from schema_migrations") migrations) and seeded"; else check fail "final SHA migrated and seeded" "(see $OUT/setup.log)"; fi

# Final: add service-workflow records, read everything, take the reference snapshot.
if start "$FINAL" "$FEATURES" final-1 "$URL" "$FILES"; then
  step fixtures "$URL" fixtures fixtures; step final-1-reads "$URL" smoke final-1; api_errors final-1
else check fail "final-1 API starts"; fi
stop
snapshot "$URL" "$OUT/snap-0.txt"

# Roll back to the floor.
floor_migrate=$(cd "$FLOOR" && DATABASE_URL=$URL pnpm db:migrate 2>&1 | tail -1)
[[ $floor_migrate == *"up to date"* ]] && check ok "floor migrate is a no-op" || check fail "floor migrate is a no-op" "($floor_migrate)"
if start "$FLOOR" "$FLOOR_FEATURES" floor "$URL" "$FILES"; then step floor-reads "$URL" smoke floor floor; api_errors floor; else check fail "floor API starts"; fi
stop
snapshot "$URL" "$OUT/snap-1.txt"; same "the floor changed no data" "$OUT/snap-0.txt" "$OUT/snap-1.txt"

# Roll forward, always, whatever happened on the floor.
if start "$FINAL" "$FEATURES" final-2 "$URL" "$FILES"; then step final-2-reads "$URL" smoke final-2; step final-2-files "$URL" files final-2; api_errors final-2; else check fail "final-2 API starts"; fi
stop
snapshot "$URL" "$OUT/snap-2.txt"; same "nothing lost after the roll forward" "$OUT/snap-0.txt" "$OUT/snap-2.txt"

# Backup and restore on scratch (row 21): the database and a copy of the stored files, each
# restored somewhere new, compared, and the restored files served by the restored server.
manifest "$FILES" > "$OUT/files-0.sha256"
pg_dump -Fc "$URL" > "$OUT/backup.dump"
tar -C "$FILES" -cf "$OUT/files-backup.tar" .
psql "$PG/postgres" -qc "create database $RDB"
pg_restore --no-owner -d "$RURL" "$OUT/backup.dump"
mkdir -p "$RFILES"; tar -C "$RFILES" -xf "$OUT/files-backup.tar"
snapshot "$RURL" "$OUT/snap-restore.txt"; same "restored database matches ($(wc -l < "$OUT/snap-0.txt") tables)" "$OUT/snap-0.txt" "$OUT/snap-restore.txt"
manifest "$RFILES" > "$OUT/files-restore.sha256"
[ -s "$OUT/files-0.sha256" ] && check ok "files to back up ($(wc -l < "$OUT/files-0.sha256"))" || check fail "files to back up" "(none stored)"
same "restored files match by checksum" "$OUT/files-0.sha256" "$OUT/files-restore.sha256"
if start "$FINAL" "$FEATURES" restored "$RURL" "$RFILES"; then step restored-files "$RURL" files restored; api_errors restored; else check fail "restored API starts"; fi
stop

EXPECTED=(final-1-migrate fixtures final-1-reads final-1-errors floor-migrate floor-reads floor-errors floor-data final-2-reads final-2-files final-2-errors final-2-data restore-db restore-files-present restore-files restored-files restored-errors)
failed=0
for s in "${ORDER[@]}"; do [[ ${STEPS[$s]} == passed* ]] || failed=$((failed+1)); done
log "steps recorded: ${#ORDER[@]} of ${#EXPECTED[@]} expected; failed: $failed"
if [ "$failed" -ne 0 ] || [ "${#ORDER[@]}" -ne "${#EXPECTED[@]}" ]; then log "Drill B FAILED (see $OUT)"; exit 1; fi
log "Drill B passed: every step completed (see $OUT)"
