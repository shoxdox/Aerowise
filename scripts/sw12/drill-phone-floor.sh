#!/usr/bin/env bash
# SW-12 Drill A (plan §12 row 4, §9.1): roll a phone with unsent inspection and work changes back to
# the SW-2a phone floor and forward again, on a scratch database. Never staging or production.
#
#   scripts/sw12/drill-phone-floor.sh <final-worktree> <phone-floor-worktree> [<server-worktree>]
#
# Only the WEB app (what the phone loads) rolls back to the phone floor a39e875. The API always
# stays on an approved compatible server: the final SHA by default, or an explicit server floor
# given as the third worktree with SERVER_FLOOR=<sha> (at least 81048d3; SW-9's merge SHA once
# non-aerobic obligations exist, plan §9.2). Running a39e875's own API is an unsupported rollback
# (its job queries predate work visits) and this script refuses it.
#
# All worktrees must be installed and built (pnpm install --frozen-lockfile && pnpm build).
# Ports 3000 and 4000 must be free; the script stops only the process groups it started.
# Env: CHROMIUM_PATH, PGHOST_URL (default postgres://aerowise:aerowise@localhost:5432),
#      FINAL_FEATURES (default: every flag in the final SHA's FEATURES), SERVER_FEATURES (default:
#      every flag the server SHA knows, for the floor phase's API).
#
# Verdict: each phase prints "PHASE <name> END checks=<n> fails=<m>" as its last line. The drill
# passes only when every phase exited 0 and printed that marker with fails=0 and at least its
# expected number of checks. A crash, a missing marker or too few checks is a failure.
set -euo pipefail
FINAL=$(cd "$1" && pwd); PHONE=$(cd "$2" && pwd); SERVER=$(cd "${3:-$1}" && pwd)
PG=${PGHOST_URL:-postgres://aerowise:aerowise@localhost:5432}
DB=aerowise_drilltest
URL=$PG/$DB
# Flags: every flag each SHA knows, so the final runs with all waves (read from its FEATURES).
knows() { sed -n 's/^export const FEATURES = \[\(.*\)\] as const;$/\1/p' "$1/packages/domain/src/features.ts" | tr -d ' "'; }
FEATURES=${FINAL_FEATURES:-$(knows "$FINAL")}
SERVER_FEATURES=${SERVER_FEATURES:-$(knows "$SERVER")}
[ -n "$FEATURES" ] && [ -n "$SERVER_FEATURES" ] || { echo "could not read FEATURES from the final or server worktree"; exit 2; }
OUT=${DRILL_OUT:-$(mktemp -d /tmp/sw12-drill-a.XXXX)}
PROFILE=$OUT/phone-profile; STATE=$OUT/state.json; FILES=$OUT/files; RESULTS=$OUT/results.txt
mkdir -p "$PROFILE" "$FILES"; : > "$RESULTS"
echo "flags: final $FEATURES; floor-phase server $SERVER_FEATURES" | tee -a "$RESULTS"
sha() { git -C "$1" rev-parse HEAD; }
[ "$(sha "$PHONE")" = a39e875023abe72b1e8ae237f3fdd2ee53dff2bd ] || { echo "phone floor worktree is not a39e875"; exit 2; }
if [ "$SERVER" = "$FINAL" ]; then
  SERVER_LABEL="final $(sha "$FINAL")"
else
  [ -n "${SERVER_FLOOR:-}" ] || { echo "a separate server worktree needs SERVER_FLOOR=<sha> naming the approved server floor"; exit 2; }
  case "$(sha "$SERVER")" in "$SERVER_FLOOR"*) ;; *) echo "server worktree $(sha "$SERVER") is not SERVER_FLOOR $SERVER_FLOOR"; exit 2;; esac
  git -C "$SERVER" merge-base --is-ancestor 81048d33fd88bca93456b89b1c4a4e80edcfa18b HEAD || { echo "server floor must be 81048d3 or later"; exit 2; }
  SERVER_LABEL="server floor $(sha "$SERVER")"
fi
echo "Drill A: final $(sha "$FINAL"), phone floor web $(sha "$PHONE"), API during the floor phase: $SERVER_LABEL, db $DB, out $OUT" | tee -a "$RESULTS"

declare -A PGIDS=()
listeners() { fuser -n tcp "$1" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true; }
busy() { [ -n "$(listeners 3000)$(listeners 4000)" ]; }
# Whether every process listening on <port> is in a process group this drill started.
owned() {
  local p g pids; pids=$(listeners "$1"); [ -n "$pids" ] || return 1
  for p in $pids; do g=$(ps -o pgid= -p "$p" | tr -d ' '); [ -n "${PGIDS[$g]:-}" ] || return 1; done
}
stop() {
  local g
  for g in "${!PGIDS[@]}"; do kill -- -"$g" 2>/dev/null || true; done
  for i in $(seq 1 30); do busy || { PGIDS=(); return 0; }; sleep 1; done
  for g in "${!PGIDS[@]}"; do kill -9 -- -"$g" 2>/dev/null || true; done; sleep 2
  PGIDS=()
  # Never kill a listener this drill did not start.
  busy && { echo "ports 3000/4000 still busy after stopping this drill's servers; not touching other processes"; return 1; }
  return 0
}
trap 'stop || true' EXIT
launch() { # <dir> <log> <command...>: starts it as a new session (its own process group) and records it
  local dir=$1 log=$2; shift 2
  (cd "$dir" && exec setsid "$@" > "$log" 2>&1 < /dev/null) &
  PGIDS[$!]=1
}
start() { # <api-worktree> <web-worktree> <features> <label>
  launch "$1" "$OUT/api-$4.log" env DATABASE_URL="$URL" API_PORT=4000 FILE_STORAGE_DIR="$FILES" DEMO_MODE=true LOGIN_RATE_LIMIT=100 AEROWISE_FEATURES="$3" pnpm --filter @aerowise/api start
  launch "$2/apps/web" "$OUT/web-$4.log" pnpm start
  for i in $(seq 1 120); do
    if curl -sf localhost:4000/health >/dev/null && curl -sf localhost:3000/login >/dev/null; then
      owned 4000 && owned 3000 && return 0
      echo "something other than this drill's $4 servers answers on 3000/4000 (see $OUT)"; return 1
    fi
    sleep 1
  done
  echo "$4 servers did not start (see $OUT)"; return 1
}
declare -A STATUS=([before]="not run" [floor]="not run" [after]="not run")
phase() { # <name> <min-checks>
  local rc=0 marker checks fails
  (cd "$FINAL/apps/web" && DRILL_DATABASE_URL=$URL node drills/phone-floor.mjs "$1" "$PROFILE" "$STATE") > "$OUT/phase-$1.txt" 2>&1 || rc=$?
  cat "$OUT/phase-$1.txt" >> "$RESULTS"; cat "$OUT/phase-$1.txt"
  marker=$(grep -E "^PHASE $1 END checks=[0-9]+ fails=[0-9]+$" "$OUT/phase-$1.txt" | tail -1 || true)
  checks=$(sed -nE 's/.*checks=([0-9]+).*/\1/p' <<< "$marker"); fails=$(sed -nE 's/.*fails=([0-9]+).*/\1/p' <<< "$marker")
  if [ "$rc" -eq 0 ] && [ -n "$marker" ] && [ "${fails:-1}" -eq 0 ] && [ "${checks:-0}" -ge "$2" ]; then STATUS[$1]=passed
  else STATUS[$1]="FAILED (exit $rc, marker: ${marker:-missing}, needs at least $2 checks)"; fi
  echo "phase $1: ${STATUS[$1]}" | tee -a "$RESULTS"
}

busy && { echo "ports 3000/4000 are in use; stop whatever runs there first"; exit 2; }
psql "$PG/postgres" -qc "drop database if exists $DB" -c "create database $DB"
(cd "$FINAL" && DATABASE_URL=$URL pnpm db:migrate && DATABASE_URL=$URL DEMO_MODE=true FILE_STORAGE_DIR="$FILES" AEROWISE_FEATURES=$FEATURES pnpm db:seed) > "$OUT/setup.log" 2>&1

if start "$FINAL" "$FINAL" "$FEATURES" final-1; then phase before 2; else STATUS[before]="FAILED (servers)"; fi
stop
if [ "${STATUS[before]}" = passed ]; then
  if [ "$SERVER" != "$FINAL" ]; then
    echo "server floor migrate (must be a no-op): $(cd "$SERVER" && DATABASE_URL=$URL pnpm db:migrate 2>&1 | tail -1)" | tee -a "$RESULTS"
  fi
  # Only the phone's web app rolls back; the API is the approved server.
  if start "$SERVER" "$PHONE" "$SERVER_FEATURES" floor; then phase floor 8; else STATUS[floor]="FAILED (servers)"; fi
  stop
  # Roll forward and recover the phone whatever happened on the floor.
  if start "$FINAL" "$FINAL" "$FEATURES" final-2; then phase after 6; else STATUS[after]="FAILED (servers)"; fi
  stop
fi

verdict=passed
for p in before floor after; do echo "  $p: ${STATUS[$p]}" | tee -a "$RESULTS"; [ "${STATUS[$p]}" = passed ] || verdict=failed; done
if [ "$verdict" != passed ]; then echo "Drill A FAILED (see $OUT)" | tee -a "$RESULTS"; exit 1; fi
echo "Drill A passed: every phase completed; API during the floor phase was $SERVER_LABEL (see $OUT)" | tee -a "$RESULTS"
