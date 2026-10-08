#!/usr/bin/env bash
# SW-12 Drill A (plan §12 row 4): roll a phone with unsent inspection and work changes back to the
# SW-2a phone floor and forward again, on a scratch database. Never staging or production.
#
#   scripts/sw12/drill-phone-floor.sh <final-worktree> <floor-worktree>
#
# Both worktrees must be installed and built (pnpm install --frozen-lockfile && pnpm build).
# The floor is a39e875023abe72b1e8ae237f3fdd2ee53dff2bd. Ports 3000 and 4000 must be free.
# Env: CHROMIUM_PATH, PGHOST_URL (default postgres://aerowise:aerowise@localhost:5432),
#      FINAL_FEATURES (default all six core flags; add later slices' flags when they merge).
set -euo pipefail
FINAL=$(cd "$1" && pwd); FLOOR=$(cd "$2" && pwd)
PG=${PGHOST_URL:-postgres://aerowise:aerowise@localhost:5432}
DB=aerowise_drilltest
URL=$PG/$DB
FEATURES=${FINAL_FEATURES:-work_orders,service_items,field_work,estimates,deposits,plan_builder}
OUT=${DRILL_OUT:-$(mktemp -d /tmp/sw12-drill-a.XXXX)}
PROFILE=$OUT/phone-profile; STATE=$OUT/state.json; FILES=$OUT/files
mkdir -p "$PROFILE" "$FILES"
echo "Drill A: final $(git -C "$FINAL" rev-parse HEAD), floor $(git -C "$FLOOR" rev-parse HEAD), db $DB, out $OUT"
[ "$(git -C "$FLOOR" rev-parse HEAD)" = a39e875023abe72b1e8ae237f3fdd2ee53dff2bd ] || { echo "floor worktree is not a39e875"; exit 2; }

API_PID=; WEB_PID=
busy() { fuser -s -n tcp 3000 2>/dev/null || fuser -s -n tcp 4000 2>/dev/null; }
stop() {
  for p in $API_PID $WEB_PID; do kill -- -"$p" 2>/dev/null || true; done
  API_PID=; WEB_PID=
  for i in $(seq 1 30); do busy || return 0; sleep 1; done
  # Whatever still listens was started by this drill: the ports were free when it began.
  fuser -k -n tcp 3000 4000 2>/dev/null || true; sleep 2
  busy && { echo "ports 3000/4000 still busy after stopping the servers"; exit 1; }; return 0
}
trap stop EXIT
start() { # <worktree> <features>
  local dir=$1 features=$2
  (cd "$dir" && DATABASE_URL=$URL API_PORT=4000 FILE_STORAGE_DIR=$FILES DEMO_MODE=true LOGIN_RATE_LIMIT=100 AEROWISE_FEATURES=$features \
    setsid pnpm --filter @aerowise/api start > "$OUT/api-$(basename "$dir").log" 2>&1 & echo $! > "$OUT/api.pid")
  (cd "$dir/apps/web" && setsid pnpm start > "$OUT/web-$(basename "$dir").log" 2>&1 & echo $! > "$OUT/web.pid")
  API_PID=$(cat "$OUT/api.pid"); WEB_PID=$(cat "$OUT/web.pid")
  for i in $(seq 1 120); do
    if curl -sf localhost:4000/health >/dev/null && curl -sf localhost:3000/login >/dev/null; then
      # Both answering must be these servers: their processes are still alive.
      kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null && return 0
      echo "servers in $dir exited (see $OUT)"; exit 1
    fi
    sleep 1
  done
  echo "servers in $dir did not start"; exit 1
}
phase() { (cd "$FINAL/apps/web" && DRILL_DATABASE_URL=$URL node drills/phone-floor.mjs "$1" "$PROFILE" "$STATE") 2>&1 | tee -a "$OUT/results.txt" || true; }

busy && { echo "ports 3000/4000 are in use; stop whatever runs there first"; exit 2; }
psql "$PG/postgres" -qc "drop database if exists $DB" -c "create database $DB"
(cd "$FINAL" && DATABASE_URL=$URL pnpm db:migrate && DATABASE_URL=$URL DEMO_MODE=true AEROWISE_FEATURES=$FEATURES pnpm db:seed) > "$OUT/setup.log" 2>&1

start "$FINAL" "$FEATURES"; phase before; stop
echo "floor migrate (must be a no-op):"; (cd "$FLOOR" && DATABASE_URL=$URL pnpm db:migrate) 2>&1 | tail -1 | tee -a "$OUT/results.txt"
start "$FLOOR" "${FLOOR_FEATURES:-}"; phase floor; stop
start "$FINAL" "$FEATURES"; phase after; stop

if grep -q '^FAIL' "$OUT/results.txt"; then echo "Drill A FAILED (see $OUT)"; exit 1; fi
echo "Drill A passed: $(grep -c '^PASS' "$OUT/results.txt") checks (see $OUT)"
