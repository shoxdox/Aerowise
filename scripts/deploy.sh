#!/usr/bin/env bash
# One-command deploy to Render: ./scripts/deploy.sh staging|production [commit]
# Deploys the API first (its pre-deploy step runs the migrations), waits for it to go live,
# then deploys the web app. Stops at the first failure. Needs RENDER_API_KEY (Render
# dashboard > Account settings > API keys) plus curl and jq. See docs/engineering/DEPLOY.md.
set -euo pipefail

env=${1:-}
commit=${2:-$(git rev-parse HEAD)}
[[ $env == staging || $env == production ]] || { echo "usage: $0 staging|production [commit]" >&2; exit 2; }
: "${RENDER_API_KEY:?set RENDER_API_KEY}"
API=${RENDER_API_URL:-https://api.render.com/v1}
POLL=${DEPLOY_POLL_SECONDS:-10}
TIMEOUT=${DEPLOY_TIMEOUT_SECONDS:-1800}

render() { # method path [json-body] -> prints the response body; exits on an HTTP error
  local args=(-sS --fail-with-body -X "$1" -H "authorization: Bearer $RENDER_API_KEY" -H "accept: application/json")
  [[ -n ${3:-} ]] && args+=(-H "content-type: application/json" --data "$3")
  local body
  body=$(curl "${args[@]}" "$API$2") || { echo "Render API $1 $2 failed: $body" >&2; exit 1; }
  printf '%s' "$body"
}

deploy() { # service-name
  local name=$1 id deploy status waited=0
  local services
  services=$(render GET "/services?name=$name&limit=1")
  id=$(jq -r --arg n "$name" '[.[].service | select(.name == $n)][0].id // empty' <<<"$services")
  [[ -n $id ]] || { echo "no Render service named $name (create it from render.yaml first)" >&2; exit 1; }
  deploy=$(render POST "/services/$id/deploys" "$(jq -n --arg c "$commit" '{commitId: $c}')")
  deploy=$(jq -r .id <<<"$deploy")
  echo "$name: deploying $commit ($deploy)"
  while :; do
    status=$(render GET "/services/$id/deploys/$deploy")
    status=$(jq -r .status <<<"$status")
    case $status in
      live) echo "$name: live"; return 0 ;;
      build_failed | update_failed | pre_deploy_failed | canceled | deactivated)
        echo "$name: deploy ended as $status; see the service's events in the Render dashboard" >&2; exit 1 ;;
    esac
    (( waited >= TIMEOUT )) && { echo "$name: still $status after ${TIMEOUT}s" >&2; exit 1; }
    sleep "$POLL"; waited=$((waited + POLL))
  done
}

deploy "aerowise-api-$env"
deploy "aerowise-web-$env"
echo "deployed $commit to $env"
