# Deploying Aerowise

Staging and production both run on Justin's own server (Chicago, 4 GB RAM, 2 vCPUs) with Docker Compose, until Aerowise moves to a managed host such as Render ([DEPLOY-RENDER.md](DEPLOY-RENDER.md), with `render.yaml` kept ready). Why, and what that costs in risk, is in [DECISIONS.md](../DECISIONS.md) (2026-10-05, Hosting on our own server). Everything the server runs is in [`deploy/vps/`](../../deploy/vps).

## What runs where

| | Staging (the public demo) | Production |
| --- | --- | --- |
| Address | `https://staging.<domain>` | `https://app.<domain>` |
| Checkout | `/opt/aerowise/staging` | `/opt/aerowise/production` |
| Settings file | `/etc/aerowise/staging.env` | `/etc/aerowise/production.env` |
| Compose project | `aerowise-staging` | `aerowise-production` |
| `DEMO_MODE` | `true` | `false` |

- **One front door.** Caddy ([`edge.compose.yaml`](../../deploy/vps/edge.compose.yaml), [`Caddyfile`](../../deploy/vps/Caddyfile)) is the only thing listening on ports 80 and 443. It gets a Let's Encrypt certificate for each address, redirects HTTP to HTTPS and passes requests to that environment's web app over the shared `aerowise-edge` Docker network. Changing an address means changing `AW_DOMAIN` in the environment's settings file and the matching line in `/etc/aerowise/edge.env`, then restarting Caddy and redeploying.
- **Or nginx in front.** When the server's own nginx already has ports 80 and 443 (Justin's does), `setup.sh` leaves Caddy out. It adds two sites to nginx ([`nginx/aerowise.conf`](../../deploy/vps/nginx/aerowise.conf)) that forward each address to its environment's web app on `127.0.0.1:3101` (staging) or `127.0.0.1:3102` (production), and runs certbot for the certificates and the HTTPS redirect; certbot's timer renews them. The rest of nginx's configuration is not touched. The shared proxy settings ([`nginx/aerowise-proxy.conf`](../../deploy/vps/nginx/aerowise-proxy.conf)) replace any `X-Forwarded-For` a client sends and allow uploads up to 20 MB (photos are up to 15 MB).
- **Each environment** ([`app.compose.yaml`](../../deploy/vps/app.compose.yaml)) has its own Postgres 16, API, worker and web app, built from the repo's `Dockerfile`, and its own volumes for the database and stored files. Only the web app is on the shared network; the database and API are reachable only inside their own environment. The web app proxies `/api/*` to the API, as in development.
- **Settings.** Each environment's settings file feeds the `environment:` list in `app.compose.yaml`, which names every setting the API and worker read. A change that adds a setting to `.env.example` adds it there and to `deploy/vps/env.example` too; `apps/api/test/deploy.test.ts` fails until it does.
- **The client's address.** Caddy replaces any `X-Forwarded-For` a client sends with the address it saw, so `TRUST_PROXY=uniquelocal` (the private Docker addresses of Caddy and the web app) lets the rate limits key on the real client and nothing a client can fake.
- **Memory.** Both environments together used about 1 GB in a local test. Building the image needs more for a minute or two, so on a 4 GB server shared with other things a 2 GB swap file is a cheap margin.

## Setting the server up (once)

First, DNS: two records pointing at the server, `staging.<domain>` and `app.<domain>` (A records to its IP). In Cloudflare, set them to **DNS only** (grey cloud), so the certificates can be issued on the server and the address Aerowise sees is the visitor's. Proxied (orange cloud) also works with SSL/TLS mode **Full (strict)**, but then every visitor arrives from a Cloudflare address, so the sign-in rate limits need Cloudflare's ranges in `TRUST_PROXY`. With no domain, pass the server's IP to the script instead and it uses `staging.<ip>.sslip.io` and `app.<ip>.sslip.io`, which resolve to the server by themselves.

Then `deploy/vps/setup.sh` does the rest and is safe to run again. As root on the server, with Docker and git installed:

```sh
curl -fsSL https://get.docker.com | sh      # if Docker is not installed yet
sudo bash setup.sh <domain> <your email>    # copy deploy/vps/setup.sh over first
```

The first run creates a `deploy` user and a read-only key for GitHub, prints that key and stops. Add it under the repository's **Settings > Deploy keys** (write access off), then run the script again. The second run:

1. clones the repository into `/opt/aerowise/staging` and `/opt/aerowise/production`;
2. writes `/etc/aerowise/staging.env`, `production.env` and `edge.env` (readable by root and the `deploy` user only) from [`env.example`](../../deploy/vps/env.example), with new random values for the database password, `FILE_SIGNING_SECRET` and `QUICKBOOKS_TOKEN_KEY`. Files that already exist are left alone;
3. makes a key that CI can use to deploy and for nothing else (see below);
4. installs [`/etc/cron.d/aerowise`](../../deploy/vps/cron): nightly backups, the nightly demo reset and the restarter;
5. sets up HTTPS (Caddy, or nginx and certbot when nginx already has ports 80 and 443) and deploys `main` to staging, loading the demo data. If a certificate cannot be issued yet (DNS not pointing at the server), it says so and prints the certbot command to run later.

It ends by printing the GitHub secrets CI needs. To pick up later changes to the cron file or `aerowise-deploy`, run it again.

Production refuses to start until its settings file has Resend and Cloudflare R2 filled in (W3.3's check). Every other service is optional and stays off when its lines are empty.

### Platform admin

```sh
docker exec -it aerowise-production-api-1 pnpm db:create-platform-admin you@example.com "Your Name"
```

It asks for the password. Staging needs its own if you want `/admin` there; the demo seed does not create one.

## Deploying

A deploy checks the commit out on the server, builds the image, runs the settings check, runs the migrations, swaps the containers and waits up to five minutes for every one to report healthy. A failed build, settings check or migration stops it before anything is replaced, and the running version keeps serving. On staging, the demo company and users are loaded if they are missing. Production only takes commits that are on `main`.

- **From CI** (W1.3), or by hand with the same restricted key: `ssh deploy@<server> aerowise-deploy staging|production <full commit sha>`. The CI key in `~deploy/.ssh/authorized_keys` is pinned to [`aerowise-deploy`](../../deploy/vps/aerowise-deploy.sh): no shell, no port forwarding.
- **From your machine**, with your own SSH access as `deploy`: `VPS_SSH=deploy@<server> ./scripts/deploy-vps.sh staging [commit]`. The commit must be pushed.
- **On the server:** `sudo -u deploy /opt/aerowise/<env>/deploy/vps/deploy.sh <env> <commit>`.

To roll back, deploy the earlier commit. Migrations are forward-only and are not rolled back; a fix goes in a new migration.

## Staging is the demo

Staging runs with `DEMO_MODE=true`: every outside service is its test stand-in whatever keys are set, the fictional example county rules load, and every screen shows "Demo data. Nothing is sent." The sign-in page lists the demo users: `owner@example.com`, `office@example.com` and `tech@example.com`, password `aerowise-dev`. Every night at 09:00 UTC cron runs `pnpm db:reseed-demo`, which empties everything except the authority rules and platform admins, removes stored files and seeds again. To reset it now:

```sh
docker exec aerowise-staging-api-1 pnpm db:reseed-demo
```

`seed` and `reseed-demo` refuse to run unless `DEMO_MODE=true`, so they cannot touch production.

## Keeping it up

- **Restarts.** Every container restarts if it exits or the server reboots. Docker does not restart a container that is running but unhealthy, so cron restarts any Aerowise container reported unhealthy, every minute (`/var/log/aerowise-autoheal.log`).
- **Health checks.** The API's `GET /health` checks the database. The worker touches a heartbeat file after every clean pass of its loop, and `pnpm --filter @aerowise/worker health` fails when it is more than five minutes old. The web app's check goes through its proxy to the API, so it fails when either is down. `docker ps` shows each one's state. `GET /api/health/queue` answers 503 when due work has waited more than 15 minutes with no worker on it, or a filing task has failed 3 times or more; nothing restarts on it, because a restart would not fix a failing filing.
- **Uptime checks** from outside (UptimeRobot, Better Stack or similar, every 5 minutes, alerting on two failures in a row) on `https://app.<domain>/api/health` and `https://app.<domain>/api/health/queue`. They are the only thing that notices the whole server being down.
- **Logs** are JSON lines (`LOG_LEVEL`, `info` by default): `docker logs aerowise-<env>-<api|worker|web>-1`, or `docker compose -p aerowise-<env> logs -f` from the checkout. API lines carry `reqId` and, once signed in, `organizationId` and `userId`; a 500's response carries the same `requestId`.
- **Error tracking:** with `SENTRY_DSN` in the settings file, unexpected API errors, failed background tasks and queue alerts also go to Sentry, tagged with the environment and the deployed commit. It is optional.

## Backups and restore

[`backup.sh`](../../deploy/vps/backup.sh) runs nightly for each environment (08:30 UTC production, 08:45 UTC staging). It writes a `pg_dump` and a tarball of stored files to `/var/backups/aerowise/<env>/` (root only, 14 days), then copies both to `backups/<env>/` in the R2 bucket and reads them back (35 days). Every Sunday, [`restore-check.sh`](../../deploy/vps/restore-check.sh) restores production's newest copy from R2 into a scratch database and compares it with the live one.

How to restore, check a backup, and recover from a lost server: [RUNBOOK.md](RUNBOOK.md).

## Moving to Render later

`render.yaml` and [DEPLOY-RENDER.md](DEPLOY-RENDER.md) stay current. The move is: create the Render Blueprint, copy the settings from `/etc/aerowise/<env>.env` into Render, restore the latest `pg_dump` into Render's database, point the domain at Render, and switch CI's deploy step to `scripts/deploy.sh`.
