#!/usr/bin/env bash
# Checks the README's Docker path end to end: after `docker compose up` and the seed,
# the office can sign in through the web app, see the inbox and import a CSV, and the
# technician can load today's route. Run against a stack that is already up and seeded.
set -euo pipefail

WEB=${WEB_URL:-http://localhost:3000}
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

call() { # method path [json-body] -> prints body, fails on non-2xx
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -b "$jar" -c "$jar" -X "$method" -o /tmp/smoke-body -w '%{http_code}')
  [[ -n $body ]] && args+=(-H 'content-type: application/json' --data "$body")
  local code
  code=$(curl "${args[@]}" "$WEB/api$path")
  [[ $code == 2* ]] || fail "$method $path returned $code: $(cat /tmp/smoke-body)"
  cat /tmp/smoke-body
}

for _ in $(seq 1 60); do
  curl -sf "$WEB/login" >/dev/null && break
  sleep 2
done
curl -sf "$WEB/login" >/dev/null || fail "web app did not come up on $WEB"

call POST /auth/login '{"email":"office@example.com","password":"aerowise-dev"}' >/dev/null
items=$(call GET /inbox | jq '.items | length')
[[ $items -gt 0 ]] || fail "the seeded inbox is empty"
echo "office: inbox has $items exceptions"

csv=$'Customer,Service Address,City,Phone\nSmoke Test,1 Compose Way,Austin,512-555-0199\n'
id=$(call POST /imports "$(jq -n --arg c "$(printf '%s' "$csv" | base64 | tr -d '\n')" '{filename:"smoke.csv",contentBase64:$c}')" | jq -r .id)
status=$(call POST "/imports/$id/commit" '{}' | jq -r .status)
[[ $status == committed ]] || fail "import ended as $status"
echo "office: imported a CSV"

call POST /auth/logout '{}' >/dev/null
call POST /auth/login '{"email":"tech@example.com","password":"aerowise-dev"}' >/dev/null
stops=$(call GET /route | jq '.items | length')
[[ $stops -gt 0 ]] || fail "the technician has no stops today"
echo "technician: $stops stops on today's route"
echo "compose smoke test passed"
