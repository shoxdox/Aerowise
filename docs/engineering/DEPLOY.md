# Deploying Aerowise

Aerowise runs on [Render](https://render.com). Everything Render needs is in [`render.yaml`](../../render.yaml) at the repo root (a Render Blueprint), and one command deploys a commit. Why Render and what it costs are in [DECISIONS.md](../DECISIONS.md) (2026-10-05, Hosting).

## What runs where

Two environments, each with its own database and services, all in Render's Ohio region:

| Resource | Staging | Production |
| --- | --- | --- |
| Postgres 16 | `aerowise-db-staging` (Basic-256mb, 1 GB) | `aerowise-db-production` (Basic-1gb, 5 GB) |
| API and worker | `aerowise-api-staging` (Starter, 1 GB disk) | `aerowise-api-production` (Starter, 5 GB disk) |
| Web app | `aerowise-web-staging` (Starter) | `aerowise-web-production` (Starter) |

All three services build the same `Dockerfile` and differ only in their start command, as in `docker-compose.yml`.

- **The API and the worker share one service** (`scripts/start-api-and-worker.sh`), because uploaded photos and report PDFs live on a disk (`FILE_STORAGE_DIR=/data/files`) and a Render disk belongs to one service. If either process stops, the script stops the other and the container exits, so Render restarts both. With R2 configured (W3.2) nothing needs the disk any more, so the worker can become its own service; that split is left for a later change.
- **The web app** proxies `/api/*` to the API over Render's private network. `API_URL` is the API's private `host:port`; Render passes it to the Docker build, where Next.js bakes it into its rewrites. People, Stripe, Twilio and Intuit only ever use the web app's address.
- The API service also has a public `onrender.com` address because Render health checks only run on web services. Nothing links to it; it answers the same signed-in requests the web app proxies.

## Migrations

Each API deploy runs `pnpm db:migrate` as its pre-deploy command: after the image builds, on a separate instance, before the new API starts. If a migration fails, the deploy stops there and the running version keeps serving. Migrations are forward-only and applied files are never edited, so the old API keeps working against the new schema during the switch. The API and worker still run `migrate` when they start, which is a no-op after the pre-deploy step and keeps `docker compose up` working. A Postgres advisory lock stops two migrators from running at once.

## Health checks

- **API:** `GET /health` checks the database. With `HEALTH_INCLUDES_WORKER=true` (set in `render.yaml`) it also answers 503 when the worker's heartbeat is missing or more than `WORKER_HEARTBEAT_MAX_AGE_MS` old (5 minutes by default), so a stuck or dead worker makes Render restart the service.
- **Worker:** after every clean pass of its loop, the worker touches `WORKER_HEARTBEAT_FILE` (a file in the temp directory by default). `pnpm --filter @aerowise/worker health` exits 0 when that file is recent and 1 otherwise; Docker Compose uses it as the worker's health check. A pass that throws (for example, the database is unreachable) does not count.
- **Web:** `GET /api/health` goes through the web app's proxy to the API, so it fails when either is down.
- **Queue:** `GET /health/queue` (and `/api/health/queue` through the web app) answers 503 when due work has waited more than 15 minutes with no worker on it, or a filing task (reports, contract filings, sending to an authority) has failed 3 times or more. The body says how many tasks wait, for how long, and how many filing tasks are failing. Render does not use it: restarting would not fix a failing filing.

## Monitoring

- **Uptime checks** (an external monitor such as UptimeRobot or Better Stack, every 5 minutes, alert on two failures in a row):
  - `<PUBLIC_APP_URL>/api/health`: the web app, the API and the database are up.
  - `<PUBLIC_APP_URL>/api/health/queue`: the worker keeps up and filings are going out.
- **Logs** are JSON lines on stdout from the API and the worker (`LOG_LEVEL`, `info` by default). API lines carry `reqId` and, once signed in, `organizationId` and `userId`; a 500's response body carries the same `requestId`, so a customer's report can be matched to its log lines. Worker lines name each task with its `organizationId`.
- **Error tracking:** with `SENTRY_DSN` set, unexpected API errors (500s), failed background tasks and queue alerts go to Sentry, tagged with `organization_id`, `request_id`, the route or task kind, `DEPLOY_ENV` as the environment and the deployed commit as the release. Without it, they are only in the logs. The worker checks the queue every `QUEUE_CHECK_INTERVAL_MS` (5 minutes) and sends each alert once, then every 6 hours while it lasts.

## First-time setup (Justin, once)

1. Create a Render account (the free Hobby workspace is enough to start) and connect GitHub with access to `shoxdox/Aerowise`.
2. In the Render dashboard choose **New > Blueprint**, pick the repo and the `main` branch. Render reads `render.yaml` and lists the six resources.
3. Fill in the values Render asks for (the `sync: false` keys):
   - `PUBLIC_APP_URL`: the web service's address, for example `https://aerowise-web-staging.onrender.com`, until a domain is bought.
   - `DEPLOY_ENV` is already set (`staging` / `production`). Production refuses to start until Resend and R2 are configured; the deploy log names exactly what is missing. Staging runs without them.
   - Files: leave the four `R2_*` keys empty and photos and PDFs stay on the service's disk. To use Cloudflare R2, create a private bucket and an R2 API token with object read and write on that bucket only, then set `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Files already on the disk are copied with `pnpm files:copy-to-r2` from the API service's Shell (run it before setting the keys, with them exported in the shell, then again after; it is safe to repeat and checks every file's SHA-256).
   - Email: leave `RESEND_API_KEY` empty and every email is written to the outbox in file storage. To send for real, set `RESEND_API_KEY`, `FILING_EMAIL_FROM`, `INVOICE_EMAIL_FROM` and `ACCOUNT_EMAIL_FROM` (addresses on the domain verified in Resend), point a Resend webhook at `<PUBLIC_APP_URL>/api/webhooks/email` and put its signing secret in `RESEND_WEBHOOK_SECRET`. On staging, set `EMAIL_REDIRECT_TO` to a test inbox so synthetic filings never reach a real authority.
   - Production only: Stripe, QuickBooks and Twilio keys. Leave them empty and each one stays off.
4. Apply. Render creates the databases, generates `FILE_SIGNING_SECRET` and `QUICKBOOKS_TOKEN_KEY`, and builds and starts everything.
5. Create your platform admin for `/admin`: open the API service's **Shell** in the dashboard and run `pnpm db:create-platform-admin you@example.com "Your Name"` (it asks for the password).
6. Create an API key under **Account settings > API keys** for the deploy command below.

Changing `render.yaml` later and syncing the Blueprint updates the services to match; values entered by hand are kept.

## Deploy

```sh
RENDER_API_KEY=... ./scripts/deploy.sh staging            # deploys the commit you have checked out
RENDER_API_KEY=... ./scripts/deploy.sh production <sha>   # or a given commit
```

The script finds the services by name, deploys the API first (its pre-deploy step migrates the database), waits until it is live, then deploys the web app. It stops with an error at the first failed build, failed migration or failed health check. Render never deploys on a push by itself (`autoDeployTrigger: off`); W1.3 runs this script from CI after the checks pass.

To roll back, choose an earlier deploy under the service's **Events** in the dashboard and **Rollback**, or run the script with the earlier commit. Migrations are not rolled back; a fix goes in a new migration.

## Not here yet

- Demo mode, the demo seed and the "Demo data. Nothing is sent." banner on staging (W1.2). Until then staging runs like production: test providers off, no fictional rulesets.
- Deploys from CI, the nightly staging reseed and a custom domain with HTTPS (W1.3). Render already serves the `onrender.com` addresses over HTTPS.
- Object storage, so the worker can run as its own service (W3.2); backups beyond Render's point-in-time recovery and a restore runbook (W3.5).
