#!/usr/bin/env bash
# Sets the server up for Aerowise, as root. Safe to run again: each step skips what is done.
#   curl -fsSL <this file's raw GitHub URL> -o setup.sh   (or copy it over)
#   sudo bash setup.sh <domain> <email for certificate notices>
# Staging is served at staging.<domain> and production at app.<domain>; both DNS records must
# point at this server first. With no domain yet, give the server's IP instead and the
# addresses are staging.<ip>.sslip.io and app.<ip>.sslip.io.
# The first run stops after printing the key GitHub needs. Add it, run it again, and it
# finishes: both environments checked out, settings files written with new secrets, HTTPS set
# up (Caddy, or the server's nginx plus certbot when nginx already has ports 80 and 443),
# nightly jobs installed and the demo deployed to staging.
# See docs/engineering/DEPLOY.md.
set -euo pipefail

domain=${1:-}
acme_email=${2:-}
mode=${3:-all}
[[ $mode == all || $mode == --staging-only ]] || { echo "third argument must be --staging-only (or omitted)" >&2; exit 2; }
environments=(staging production)
hosts=()
[[ $mode == --staging-only ]] && environments=(staging)
[[ $domain =~ ^[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$ && $acme_email == *@* ]] || { echo "usage: sudo bash setup.sh <domain, or the server's IP> <email>" >&2; exit 2; }
# An IP address becomes an sslip.io name, which resolves back to that IP.
[[ $domain =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && domain=${domain//./-}.sslip.io
staging_host=staging.$domain
production_host=app.$domain
hosts=("$staging_host")
[[ $mode == all ]] && hosts+=("$production_host")
[[ $(id -u) == 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
repo=${AEROWISE_REPO:-git@github.com:shoxdox/Aerowise.git}
root=/opt/aerowise
etc=/etc/aerowise

say() { printf '\n== %s\n' "$*"; }

say "Checking Docker, Compose and git"
command -v docker >/dev/null || { echo "Docker is not installed. Install it with: curl -fsSL https://get.docker.com | sh" >&2; exit 1; }
docker compose version >/dev/null || { echo "The Docker Compose plugin is missing (apt install docker-compose-plugin)" >&2; exit 1; }
command -v git >/dev/null || { echo "git is not installed (apt install git)" >&2; exit 1; }
# The front door on ports 80 and 443: Caddy, unless nginx already has them, in which case nginx
# forwards the two addresses and certbot gets their certificates.
front=caddy
if ! docker ps --format '{{.Names}}' | grep -qx aerowise-edge-caddy-1 && command -v ss >/dev/null; then
  listeners=$(ss -ltnpH '( sport = :80 or sport = :443 )')
  if [[ -n $listeners ]]; then
    if ! grep -qv '"nginx"' <<<"$listeners"; then
      front=nginx
    else
      echo "Something other than nginx already listens on port 80 or 443:" >&2
      echo "$listeners" >&2
      echo "Aerowise needs those ports, or nginx in front. Stop that service or ask for a shared setup." >&2
      exit 1
    fi
  fi
fi
echo "front door: $front"

say "Creating the deploy user"
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy ~deploy/.ssh

# The server reads the private repository with its own read-only key.
github_key=~deploy/.ssh/github
if [[ ! -f $github_key ]]; then
  sudo -u deploy ssh-keygen -q -t ed25519 -N "" -C "aerowise-server-read" -f "$github_key"
fi
sudo -u deploy tee ~deploy/.ssh/config >/dev/null <<EOF
Host github.com
  IdentityFile $github_key
  IdentitiesOnly yes
EOF
sudo -u deploy sh -c 'ssh-keyscan -t ed25519 github.com 2>/dev/null >> ~/.ssh/known_hosts; sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts'
if ! sudo -u deploy git ls-remote "$repo" HEAD >/dev/null 2>&1; then
  cat <<EOF

GitHub does not know this server yet. On github.com open shoxdox/Aerowise >
Settings > Deploy keys > Add deploy key, title "Aerowise server", leave
"Allow write access" off, and paste this one line:

$(cat "$github_key.pub")

Then run this script again.
EOF
  exit 0
fi

say "Checking out ${environments[*]}"
install -d -m 755 -o deploy -g deploy "$root"
for env in "${environments[@]}"; do
  [[ -d $root/$env/.git ]] || sudo -u deploy git clone --quiet "$repo" "$root/$env"
done

say "Writing the settings files in $etc"
install -d -m 750 -o root -g deploy "$etc"
secret() { openssl rand -hex 32; }
for env in "${environments[@]}"; do
  file=$etc/$env.env
  [[ -f $file ]] && { echo "$file exists; left as it is"; continue; }
  host=$([[ $env == staging ]] && echo "$staging_host" || echo "$production_host")
  demo=$([[ $env == staging ]] && echo true || echo false)
  port=$([[ $env == staging ]] && echo 3101 || echo 3102)
  sed -e "s|^AW_ENV=.*|AW_ENV=$env|" \
      -e "s|^AW_DOMAIN=.*|AW_DOMAIN=$host|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(secret)|" \
      -e "s|^FILE_SIGNING_SECRET=.*|FILE_SIGNING_SECRET=$(secret)|" \
      -e "s|^QUICKBOOKS_TOKEN_KEY=.*|QUICKBOOKS_TOKEN_KEY=$(secret)|" \
      -e "s|^DEMO_MODE=.*|DEMO_MODE=$demo|" \
      -e "s|^AW_WEB_PORT=.*|AW_WEB_PORT=$port|" \
      "$root/staging/deploy/vps/env.example" > "$file"
  chown root:deploy "$file"; chmod 640 "$file"
  echo "wrote $file"
done
if [[ $mode == all && ! -f $etc/edge.env ]]; then
  printf 'STAGING_DOMAIN=%s\nPRODUCTION_DOMAIN=%s\nACME_EMAIL=%s\n' "$staging_host" "$production_host" "$acme_email" > "$etc/edge.env"
  chown root:deploy "$etc/edge.env"; chmod 640 "$etc/edge.env"
  echo "wrote $etc/edge.env"
fi

say "Letting CI deploy, and nothing else"
if [[ $mode == all || ! -f /usr/local/bin/aerowise-deploy ]]; then
  install -m 755 "$root/staging/deploy/vps/aerowise-deploy.sh" /usr/local/bin/aerowise-deploy
fi
ci_key=/root/aerowise-ci-key
if ! grep -q aerowise-ci ~deploy/.ssh/authorized_keys 2>/dev/null; then
  ssh-keygen -q -t ed25519 -N "" -C "aerowise-ci" -f "$ci_key"
  # This key can only run aerowise-deploy: no shell, no forwarding.
  echo "command=\"/usr/local/bin/aerowise-deploy\",restrict $(cat "$ci_key.pub")" >> ~deploy/.ssh/authorized_keys
  chown deploy:deploy ~deploy/.ssh/authorized_keys; chmod 600 ~deploy/.ssh/authorized_keys
fi

say "Installing nightly backups, the demo reset and the restarter"
if [[ $mode == --staging-only ]]; then
  # Preserve existing production maintenance, but avoid two nightly staging resets.
  if [[ -f /etc/cron.d/aerowise ]]; then
    sed -i '/^[^#].*staging/d' /etc/cron.d/aerowise
  fi
  install -m 644 "$root/staging/deploy/vps/cron.staging" /etc/cron.d/aerowise-staging
else
  install -m 644 "$root/staging/deploy/vps/cron" /etc/cron.d/aerowise
  rm -f /etc/cron.d/aerowise-staging
fi
install -d -m 700 /var/backups/aerowise

say "Starting the HTTPS front door ($front)"
for host in "${hosts[@]}"; do
  getent hosts "$host" >/dev/null || echo "warning: $host does not resolve yet; its certificate needs the DNS record first"
done
if [[ $front == caddy ]]; then
  if [[ $mode == --staging-only ]]; then
    echo "staging-only setup currently requires an existing nginx front door" >&2
    exit 1
  fi
  (cd "$root/staging" && docker compose -f deploy/vps/edge.compose.yaml --env-file "$etc/edge.env" up -d)
else
  # The two Aerowise sites only; the rest of nginx's configuration is left as it is.
  install -m 644 "$root/staging/deploy/vps/nginx/aerowise-proxy.conf" /etc/nginx/aerowise-proxy.conf
  site=$([[ -d /etc/nginx/sites-enabled ]] && echo /etc/nginx/sites-available/aerowise.conf || echo /etc/nginx/conf.d/aerowise.conf)
  if [[ ! -f $site ]]; then
    template=$root/staging/deploy/vps/nginx/aerowise.conf
    [[ $mode == --staging-only ]] && template=$root/staging/deploy/vps/nginx/staging.conf
    sed -e "s/STAGING_HOST/$staging_host/" -e "s/PRODUCTION_HOST/$production_host/" "$template" > "$site"
    [[ $site == /etc/nginx/sites-available/* ]] && ln -sf "$site" /etc/nginx/sites-enabled/aerowise.conf
  fi
  nginx -t
  systemctl reload nginx 2>/dev/null || nginx -s reload
  if ! command -v certbot >/dev/null; then
    command -v apt-get >/dev/null || { echo "install certbot and its nginx plugin, then run this again" >&2; exit 1; }
    apt-get install -y -q certbot python3-certbot-nginx >/dev/null
  fi
  # Adds HTTPS and the redirect to the two sites; certbot's timer renews them.
  cert_name=aerowise
  [[ $mode == --staging-only ]] && cert_name=aerowise-staging
  certbot_cmd=(certbot --nginx --non-interactive --agree-tos -m "$acme_email" --redirect --cert-name "$cert_name")
  for host in "${hosts[@]}"; do certbot_cmd+=(-d "$host"); done
  # Reuse valid HTTPS already configured for staging; do not rewrite a shared certificate.
  if [[ $mode == --staging-only ]] && curl --fail --silent --resolve "$staging_host:443:127.0.0.1" "https://$staging_host/" >/dev/null; then
    echo "staging HTTPS already verifies; existing certificate left in place"
  else
    "${certbot_cmd[@]}" || { echo "certificate failed; run: sudo ${certbot_cmd[*]}" >&2; exit 1; }
  fi
  docker network inspect aerowise-edge >/dev/null 2>&1 || docker network create aerowise-edge >/dev/null
fi

say "Deploying the demo to staging"
commit=$(sudo -u deploy git -C "$root/staging" ls-remote origin refs/heads/main | cut -f1)
sudo -u deploy "$root/staging/deploy/vps/deploy.sh" staging "$commit"

ssh_port=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')
ssh_port=${ssh_port:-22}
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
known_host=$([[ $ssh_port == 22 ]] && echo "$ip" || echo "[$ip]:$ssh_port")
ci_key_line=$([[ -f $ci_key ]] && echo "everything printed by: sudo cat $ci_key" || echo "(already handed over; to make a new one, remove the aerowise-ci line from ~deploy/.ssh/authorized_keys and run this again)")
cat <<EOF

Done. The demo is at https://$staging_host (the certificate can take a minute).
Setup scope: ${environments[*]}.

For deploys from GitHub, add these repository secrets (Settings > Secrets and variables > Actions):
  VPS_HOST         $ip   (this server's public IP address; correct it if it shows a private one)
  VPS_SSH_PORT     $ssh_port
  VPS_KNOWN_HOSTS  $known_host $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)
  VPS_SSH_KEY      $ci_key_line
After saving VPS_SSH_KEY, delete the copy here: sudo rm -f $ci_key
EOF
