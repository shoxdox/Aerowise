#!/usr/bin/env bash
# Deploys a pushed commit to the self-hosted server from your own machine:
#   VPS_SSH=deploy@203.0.113.7 ./scripts/deploy-vps.sh staging|production [commit]
# The server checks the commit out, builds, checks its settings, migrates (stopping there on
# any failure, with the running version still serving), swaps the containers and waits until
# they are healthy. Production only takes commits on main. CI does the same (W1.3).
# See docs/engineering/DEPLOY.md.
set -euo pipefail

env=${1:-}
[[ $env == staging || $env == production ]] || { echo "usage: $0 staging|production [commit]" >&2; exit 2; }
: "${VPS_SSH:?set VPS_SSH, for example deploy@203.0.113.7}"
commit=$(git rev-parse --verify "${2:-HEAD}^{commit}")

ssh ${VPS_SSH_OPTS:-} "$VPS_SSH" aerowise-deploy "$env" "$commit"
