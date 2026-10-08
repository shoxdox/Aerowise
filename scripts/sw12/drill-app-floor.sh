#!/usr/bin/env bash
# SW-12 Drill B: run the application floor against a scratch database migrated and seeded by the
# final integration SHA, then roll forward again, and take a scratch backup and restore. Covers
# plan §12 rows 12 and 21 at the final SHA. Never staging or production.
#
#   APP_FLOOR=<sha> scripts/sw12/drill-app-floor.sh <final-worktree> <floor-worktree>
#
# APP_FLOOR is required and must equal the floor worktree's HEAD. Plan §9.2: 81048d3 is the core
# floor only until a non-aerobic obligation exists; after SW-9 merges the final app floor is SW-9's
# merge SHA (older due lists misclassify non-aerobic obligations). A run against 81048d3 after SW-9
# is a core-floor rehearsal, not final-floor evidence, and the results file says so.
#
# Both worktrees installed and built. Ports 4000 must be free (the web app is not needed: these
# are API reads of every list and of each work order, invoice, estimate and field record).
# Env: PGHOST_URL, FINAL_FEATURES (every flag of the final SHA), FLOOR_FEATURES (default: the six
# 81048d3 knows; a rollback must drop flags the floor does not know, or its config check refuses).
set -euo pipefail
FINAL=$(cd "$1" && pwd); FLOOR=$(cd "$2" && pwd)
PG=${PGHOST_URL:-postgres://aerowise:aerowise@localhost:5432}
DB=aerowise_drilltest_b; RDB=aerowise_drilltest_restore
URL=$PG/$DB
FEATURES=${FINAL_FEATURES:-work_orders,service_items,field_work,estimates,deposits,plan_builder}
FLOOR_FEATURES=${FLOOR_FEATURES:-work_orders,service_items,field_work,estimates,deposits,plan_builder}
OUT=${DRILL_OUT:-$(mktemp -d /tmp/sw12-drill-b.XXXX)}
FILES=$OUT/files; mkdir -p "$FILES"
RESULTS=$OUT/results.txt; : > "$RESULTS"
FLOOR_SHA=$(git -C "$FLOOR" rev-parse HEAD)
[ -n "${APP_FLOOR:-}" ] || { echo "set APP_FLOOR to the floor SHA (81048d3 before SW-9 merges, SW-9's merge SHA after)"; exit 2; }
case "$FLOOR_SHA" in "$APP_FLOOR"*) ;; *) echo "floor worktree $FLOOR_SHA is not APP_FLOOR $APP_FLOOR"; exit 2;; esac
echo "Drill B: final $(git -C "$FINAL" rev-parse HEAD), floor $FLOOR_SHA, db $DB, out $OUT" | tee -a "$RESULTS"
case "$FLOOR_SHA" in 81048d3*) echo "NOTE floor 81048d3 is the core/pumping floor; it is not the final app floor once SW-9 has merged (plan §9.2)" | tee -a "$RESULTS";; esac
check() { if [ "$1" = ok ]; then echo "PASS $2" | tee -a "$RESULTS"; else echo "FAIL $2" | tee -a "$RESULTS"; fi; }

API_PID=
busy() { fuser -s -n tcp 4000 2>/dev/null; }
stop() {
  [ -n "$API_PID" ] && kill -- -"$API_PID" 2>/dev/null || true; API_PID=
  for i in $(seq 1 30); do busy || return 0; sleep 1; done
  fuser -k -n tcp 4000 2>/dev/null || true; sleep 2; busy && { echo "port 4000 still busy"; exit 1; }; return 0
}
trap stop EXIT
start() { # <worktree> <features> <label>
  (cd "$1" && DATABASE_URL=$URL API_PORT=4000 FILE_STORAGE_DIR=$FILES DEMO_MODE=true LOGIN_RATE_LIMIT=1000 AEROWISE_FEATURES=$2 \
    setsid pnpm --filter @aerowise/api start > "$OUT/api-$3.log" 2>&1 & echo $! > "$OUT/api.pid")
  API_PID=$(cat "$OUT/api.pid")
  for i in $(seq 1 90); do curl -sf localhost:4000/health >/dev/null && { kill -0 "$API_PID" 2>/dev/null && return 0; break; }; sleep 1; done
  check fail "$3 API starts (see $OUT/api-$3.log)"; exit 1
}

# Every table's row count and content hash, except session and log tables that sign-ins write.
snapshot() { # <db-url> <file>
  psql "$1" -Atc "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'
      and table_name not in ('sessions','audit_events','platform_audit_events','login_attempts','tasks','kysely_migration','kysely_migration_lock','schema_migrations')
      order by 1" | while read -r t; do
    echo "$t $(psql "$1" -Atc "select count(*) || ' ' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '-') from \"$t\" x")"
  done > "$2"
}

# Reads every list as owner and technician, then each work order, invoice, estimate and field record.
smoke() { # <label>
  local jar=$OUT/owner.jar tjar=$OUT/tech.jar bad=0 n=0 today
  curl -sf -c "$jar" -H 'content-type: application/json' -d '{"email":"owner@example.com","password":"aerowise-dev"}' localhost:4000/auth/login >/dev/null || { check fail "$1 owner signs in"; return; }
  curl -sf -c "$tjar" -H 'content-type: application/json' -d '{"email":"tech@example.com","password":"aerowise-dev"}' localhost:4000/auth/login >/dev/null || { check fail "$1 technician signs in"; return; }
  today=$(curl -s -b "$jar" "localhost:4000/obligations/due?limit=1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["today"])')
  local paths="/customers /estimates /exports /filings /form-templates /inbox /invoices /plans /service-items /service-requests /sites /work-orders /work-types /work/conflicts /subscription /schedule?from=$today&to=$today /routing/day?date=$today"
  for p in $paths; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "localhost:4000$p"); n=$((n+1))
    case $code in 2??|403|404) ;; *) bad=$((bad+1)); echo "  $1 owner GET $p -> $code" | tee -a "$RESULTS";; esac
  done
  for p in /route /work/route "/route?date=$today" "/work/route?date=$today"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -b "$tjar" "localhost:4000$p"); n=$((n+1))
    case $code in 2??|404) ;; *) bad=$((bad+1)); echo "  $1 tech GET $p -> $code" | tee -a "$RESULTS";; esac
  done
  for q in "work-orders:select id from work_orders" "invoices:select id from invoices" "estimates:select id from estimates" \
           "jobs/{}/work-record:select job_id from work_records" "plans:select id from plans" "contracts:select id from contracts limit 50"; do
    local route=${q%%:*} sql=${q#*:}
    psql "$URL" -Atc "select 1 from information_schema.tables where table_name = '$(echo "$sql" | awk '{print $4}')'" | grep -q 1 || continue
    for id in $(psql "$URL" -Atc "$sql"); do
      local path; if [[ $route == *"{}"* ]]; then path=/${route//\{\}/$id}; else path=/$route/$id; fi
      code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "localhost:4000$path"); n=$((n+1))
      case $code in 2??|403|404) ;; *) bad=$((bad+1)); echo "  $1 owner GET $path -> $code" | tee -a "$RESULTS";; esac
    done
  done
  [ $bad -eq 0 ] && check ok "$1: $n reads answered without a server error" || check fail "$1: $bad of $n reads failed"
  [ "$(grep -c '"level":50' "$OUT/api-$1.log" || true)" = 0 ] && check ok "$1: no error logged by the API" || check fail "$1: errors in $OUT/api-$1.log"
}

busy && { echo "port 4000 is in use; stop whatever runs there first"; exit 2; }
psql "$PG/postgres" -qc "drop database if exists $DB" -c "drop database if exists $RDB" -c "create database $DB"
(cd "$FINAL" && DATABASE_URL=$URL pnpm db:migrate && DATABASE_URL=$URL DEMO_MODE=true AEROWISE_FEATURES=$FEATURES pnpm db:seed) > "$OUT/setup.log" 2>&1
check ok "final SHA migrated and seeded with $FEATURES ($(psql "$URL" -Atc "select count(*) from schema_migrations" 2>/dev/null || echo '?') migrations)"
start "$FINAL" "$FEATURES" final-1; smoke final-1; stop
snapshot "$URL" "$OUT/snap-0.txt"

# Roll back to the floor.
floor_migrate=$(cd "$FLOOR" && DATABASE_URL=$URL pnpm db:migrate 2>&1 | tail -1)
[[ $floor_migrate == *"up to date"* ]] && check ok "floor migrate is a no-op ($floor_migrate)" || check fail "floor migrate: $floor_migrate"
start "$FLOOR" "$FLOOR_FEATURES" floor; smoke floor; stop
snapshot "$URL" "$OUT/snap-1.txt"
diff -q "$OUT/snap-0.txt" "$OUT/snap-1.txt" >/dev/null && check ok "the floor changed no data ($(wc -l < "$OUT/snap-0.txt") tables)" || { check fail "data changed under the floor"; diff "$OUT/snap-0.txt" "$OUT/snap-1.txt" | head -20 | tee -a "$RESULTS"; }

# Roll forward.
start "$FINAL" "$FEATURES" final-2; smoke final-2; stop
snapshot "$URL" "$OUT/snap-2.txt"
diff -q "$OUT/snap-0.txt" "$OUT/snap-2.txt" >/dev/null && check ok "nothing lost after the roll forward" || { check fail "data changed after the roll forward"; diff "$OUT/snap-0.txt" "$OUT/snap-2.txt" | head -20 | tee -a "$RESULTS"; }

# Backup and restore (row 21): dump, restore into a fresh database, same tables and content.
pg_dump -Fc "$URL" > "$OUT/backup.dump"
psql "$PG/postgres" -qc "create database $RDB"
pg_restore --no-owner -d "$PG/$RDB" "$OUT/backup.dump"
snapshot "$PG/$RDB" "$OUT/snap-restore.txt"
diff -q "$OUT/snap-0.txt" "$OUT/snap-restore.txt" >/dev/null && check ok "restore matches: $(wc -l < "$OUT/snap-0.txt") tables, $(awk '{s+=$2} END {print s}' "$OUT/snap-0.txt") rows" || check fail "restore differs"
check ok "stored files: $(find "$FILES" -type f | wc -l) (copied with the backup by the RUNBOOK procedure, not by this drill)"

if grep -q '^FAIL' "$RESULTS"; then echo "Drill B FAILED (see $OUT)"; exit 1; fi
echo "Drill B passed: $(grep -c '^PASS' "$RESULTS") checks (see $OUT)"
