#!/bin/sh
# Copies backups off the server to Cloudflare R2, under backups/<env>/ in the bucket, and
# fetches them back for a restore. Uses rclone in a container, so nothing is installed on
# the server. Settings come from /etc/aerowise/<env>.env:
#   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (the app's, by default)
#   BACKUP_R2_BUCKET, BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY (optional: a
#     separate bucket or token for backups)
#   BACKUP_OFFSITE_KEEP_DAYS (default 35)
#
#   deploy/vps/offsite.sh <env> push <file>...      copy, then download each copy and compare
#   deploy/vps/offsite.sh <env> list                the copies in R2, oldest first
#   deploy/vps/offsite.sh <env> fetch <name|latest> <dir>   download a dump (and its files tarball)
#
# Exits 3 when R2 is not configured for this environment, so callers can tell "off" from "failed".
set -eu
env=${1:?usage: offsite.sh <env> push|list|fetch ...}
cmd=${2:?usage: offsite.sh <env> push|list|fetch ...}
shift 2
envfile=${AW_ETC:-/etc/aerowise}/$env.env

# One value from the env file, without sourcing it (values may hold any characters).
setting() {
  [ -r "$envfile" ] || return 0
  sed -n "s/^$1=//p" "$envfile" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

account=$(setting R2_ACCOUNT_ID)
bucket=$(setting BACKUP_R2_BUCKET)
[ -n "$bucket" ] || bucket=$(setting R2_BUCKET)
key_id=$(setting BACKUP_R2_ACCESS_KEY_ID)
[ -n "$key_id" ] || key_id=$(setting R2_ACCESS_KEY_ID)
secret=$(setting BACKUP_R2_SECRET_ACCESS_KEY)
[ -n "$secret" ] || secret=$(setting R2_SECRET_ACCESS_KEY)
# R2_ENDPOINT points at another S3-compatible service (tests); normally R2's own address.
endpoint=$(setting R2_ENDPOINT)
[ -n "$endpoint" ] || endpoint="https://$account.r2.cloudflarestorage.com"
keep=$(setting BACKUP_OFFSITE_KEEP_DAYS)
keep=${keep:-35}

if [ -z "$bucket" ] || [ -z "$key_id" ] || [ -z "$secret" ] || { [ -z "$account" ] && [ -z "$(setting R2_ENDPOINT)" ]; }; then
  echo "$env: no R2 settings in $envfile, so backups stay on this server only" >&2
  exit 3
fi
remote="r2:$bucket/backups/$env"

# rclone with the credentials in its environment (never on the command line, where ps shows them).
rclone() {
  mounts=$1
  shift
  # shellcheck disable=SC2086
  docker run --rm $mounts \
    -e RCLONE_CONFIG_R2_TYPE=s3 -e RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    -e RCLONE_CONFIG_R2_ENDPOINT="$endpoint" -e RCLONE_CONFIG_R2_ACCESS_KEY_ID="$key_id" \
    -e RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$secret" -e RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true \
    -e RCLONE_CONFIG_R2_ACL=private \
    "${RCLONE_IMAGE:-rclone/rclone:1.68}" --config "" "$@"
}

case $cmd in
push)
  [ $# -gt 0 ] || { echo "usage: offsite.sh <env> push <file>..." >&2; exit 2; }
  for f in "$@"; do
    dir=$(cd "$(dirname "$f")" && pwd)
    name=$(basename "$f")
    rclone "-v $dir:/backup:ro" copyto "/backup/$name" "$remote/$name" --retries 3
    # Read the copy back and compare it byte for byte: a copy nobody has read back is a hope.
    rclone "-v $dir:/backup:ro" check "/backup" "$remote" --one-way --download --include "$name" --quiet
    echo "$env: copied $name to $remote/ and checked it"
  done
  # Old copies go after BACKUP_OFFSITE_KEEP_DAYS. Only after a copy that checked out, so the
  # newest copy in R2 is always fresh, even if backups stop for longer than that.
  rclone "" delete "$remote" --min-age "${keep}d" --include 'db-*.dump' --include 'files-*.tar.gz'
  ;;
list)
  rclone "" lsf "$remote" --include 'db-*.dump' --include 'files-*.tar.gz' | sort
  ;;
fetch)
  which=${1:?usage: offsite.sh <env> fetch <db-....dump|latest> <dir>}
  out=${2:?usage: offsite.sh <env> fetch <db-....dump|latest> <dir>}
  if [ "$which" = latest ]; then
    which=$(rclone "" lsf "$remote" --include 'db-*.dump' | sort | tail -n 1)
    [ -n "$which" ] || { echo "$env: no backups in $remote" >&2; exit 1; }
  fi
  mkdir -p "$out"
  out=$(cd "$out" && pwd)
  stamp=${which#db-}
  stamp=${stamp%.dump}
  rclone "-v $out:/out" copy "$remote" /out --include "$which" --include "files-$stamp.tar.gz"
  echo "$out/$which"
  ;;
*)
  echo "unknown command $cmd (push, list or fetch)" >&2
  exit 2
  ;;
esac
