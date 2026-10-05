#!/usr/bin/env bash
# Runs on the server: deploys a commit to one environment.
#   deploy/vps/deploy.sh staging|production <commit>
# Checks the commit out in /opt/aerowise/<env>, builds the image, runs the migrations (a
# failure stops here and the running version keeps serving), then replaces the containers
# and waits until every one reports healthy. scripts/deploy-vps.sh calls it over SSH.
set -euo pipefail

# Everything is inside main, which bash reads in full before running: the checkout below
# replaces this very file.
main() {
  env=${1:-}
  commit=${2:-}
  [[ $env == staging || $env == production ]] && [[ -n $commit ]] || { echo "usage: $0 staging|production <commit>" >&2; exit 2; }
  root=${AEROWISE_ROOT:-/opt/aerowise}
  env_file=${AEROWISE_ENV_DIR:-/etc/aerowise}/$env.env
  [[ -r $env_file ]] || { echo "missing $env_file (copy deploy/vps/env.example)" >&2; exit 1; }

  cd "$root/$env"
  if [[ ${AEROWISE_CHECKED_OUT:-} != "$commit" ]]; then
    git fetch --quiet origin
    if [[ $env == production ]] && ! git merge-base --is-ancestor "$commit" origin/main; then
      echo "refusing to deploy $commit to production: it is not on main" >&2; exit 1
    fi
    git checkout --quiet --detach "$commit"
    # The checkout may have changed this script: carry on with the new one.
    AEROWISE_CHECKED_OUT=$commit exec ./deploy/vps/deploy.sh "$env" "$commit"
  fi
  echo "$env: $(git log -1 --format='%h %s')"

  export GIT_COMMIT=$commit
  compose=(docker compose -p "aerowise-$env" --env-file "$env_file" -f deploy/vps/app.compose.yaml)
  "${compose[@]}" build
  # A missing secret stops the deploy here, before anything is replaced.
  "${compose[@]}" run --rm --no-deps migrate pnpm --filter @aerowise/db check-config
  "${compose[@]}" run --rm migrate
  # The hosted demo starts with the demo company and users (a no-op once they exist).
  if grep -qx 'DEMO_MODE=true' "$env_file"; then "${compose[@]}" run --rm migrate pnpm db:seed; fi
  "${compose[@]}" up -d --wait --wait-timeout 300 --remove-orphans db api worker web
  docker image prune -f >/dev/null
  echo "$env: deployed $commit"
}

main "$@"
exit
