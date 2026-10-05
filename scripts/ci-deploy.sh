#!/usr/bin/env bash
# Deploys a commit to the self-hosted server from GitHub Actions:
#   scripts/ci-deploy.sh staging|production <full commit sha>
# Uses the repository secrets VPS_HOST, VPS_SSH_KEY, VPS_KNOWN_HOSTS and (optional) VPS_SSH_PORT,
# which deploy/vps/setup.sh prints. Without VPS_SSH_KEY it skips with a notice, so forks and
# a repository with no server yet stay green. The server does the work (deploy/vps/deploy.sh);
# the key can run nothing else there.
set -euo pipefail

env=${1:-}
commit=${2:-}
[[ $env == staging || $env == production ]] && [[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 staging|production <full commit sha>" >&2; exit 2; }
if [[ -z ${VPS_SSH_KEY:-} ]]; then
  echo "::notice::No VPS_SSH_KEY secret, so nothing was deployed to $env. See docs/engineering/DEPLOY.md."
  exit 0
fi
: "${VPS_HOST:?the VPS_HOST secret is missing}"
: "${VPS_KNOWN_HOSTS:?the VPS_KNOWN_HOSTS secret is missing}"

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
printf '%s\n' "$VPS_SSH_KEY" > "$dir/key"
printf '%s\n' "$VPS_KNOWN_HOSTS" > "$dir/known_hosts"
chmod 600 "$dir/key"

ssh -i "$dir/key" -p "${VPS_SSH_PORT:-22}" \
  -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$dir/known_hosts" \
  -o ServerAliveInterval=30 -o BatchMode=yes \
  "deploy@$VPS_HOST" aerowise-deploy "$env" "$commit"
