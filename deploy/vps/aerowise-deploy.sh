#!/usr/bin/env bash
# Installed on the server as /usr/local/bin/aerowise-deploy by setup.sh. The CI key in
# ~deploy/.ssh/authorized_keys can run this and nothing else:
#   ssh deploy@<server> aerowise-deploy staging|production <commit sha>
set -euo pipefail

if [[ -n ${SSH_ORIGINAL_COMMAND:-} ]]; then
  read -r -a args <<<"$SSH_ORIGINAL_COMMAND"
  [[ ${args[0]:-} == aerowise-deploy ]] && args=("${args[@]:1}")
else
  args=("$@")
fi
env=${args[0]:-}
commit=${args[1]:-}
if [[ ${#args[@]} != 2 || ! $env =~ ^(staging|production)$ || ! $commit =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: aerowise-deploy staging|production <full commit sha>" >&2
  exit 2
fi
exec "${AEROWISE_ROOT:-/opt/aerowise}/$env/deploy/vps/deploy.sh" "$env" "$commit"
