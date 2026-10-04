# Aerowise

An operating system for Texas aerobic septic maintenance providers: customers and sites, recurring inspections, an offline technician app, county reporting with proof of filing, and an office that only handles exceptions.

The product spec lives alongside the code: start with [PRODUCT-SPEC.md](PRODUCT-SPEC.md), then [CODEX.md](CODEX.md) for the build order and [docs/](docs/) for the domain model, UX flows, architecture and acceptance tests. Choices made where the spec is silent are logged in [docs/DECISIONS.md](docs/DECISIONS.md).

## What works today

| Area | Status |
| --- | --- |
| Monorepo, Postgres migrations, Docker Compose, CI | Done |
| Sign-in, sessions, roles (owner / office / technician / read-only) | Done |
| Tenant isolation (query scoping + composite foreign keys), with tests | Done |
| Customers, contacts, sites, wastewater systems (API + office screens) | Done |
| Append-only audit log | Done |
| Plans, contracts, renewals (next term) and recurring inspection visits with due dates | Done |
| Due-inspections list for the office | Done |
| Jobs, office scheduling screen, technician daily route | Done |
| Inspection templates, idempotent inspection sync, photo uploads with signed links, supervisor override (API) | Done |
| Technician phone app (`/tech`) that works offline, with an exactly-once sync test | Done |
| Customer and authority PDF reports (immutable), per-site compliance history, background worker | Done |
| Compliance engine and filing (fake `tx-example-county`, email + manual adapter) | Next |
| Exception inbox, imports | Planned, in that order |

Payments, invoicing, QuickBooks, e-signature, renewals, the customer portal, SMS and route optimization are out of scope for the first build.

## Run it

With Docker:

```sh
docker compose up --build
docker compose run --rm api pnpm db:seed
```

Without Docker (Node 22.12+, pnpm 10, a local Postgres 16):

```sh
cp .env.example .env    # then export the variables, or use direnv
pnpm install
pnpm db:seed            # applies migrations, then loads demo data
pnpm dev                # API on :4000, web on :3000, plus the background worker
```

Open http://localhost:3000 and sign in as `owner@example.com`, `office@example.com` or `tech@example.com` with password `aerowise-dev`. The seed creates one fictional provider with 50 customers, 55 sites and their systems, two plans, and contracts on 52 sites, timed so a week of inspections is always coming due and five are overdue. Nine of them are already on the technician's route for today and tomorrow. Signing in as the technician opens the phone app at `/tech` (use your browser's phone view, or open it on a phone on the same network); it keeps working with no signal and sends everything when the connection returns. All demo names, addresses and permit numbers are made up.

The OpenAPI document is at http://localhost:4000/openapi.json outside production.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test      # needs TEST_DATABASE_URL; the test database is created and migrated automatically
pnpm build
pnpm --filter @aerowise/web e2e   # offline sync test; run after `pnpm build`, needs Postgres on :5432 and ports 3000/4000 free
```

CI runs all of these against Postgres on every pull request, plus a Docker build. The end-to-end test resets and seeds its own `aerowise_e2e` database.

## Layout

```
apps/
  api/        Fastify REST API; routes declare a permission or they refuse to load
  web/        Next.js office app and technician phone app (/tech); /api/* is proxied to the API
  worker/     Runs background tasks (report PDFs) from the Postgres queue
packages/
  db/         SQL migrations, migration runner, Kysely types, seed script
  domain/     Roles and permissions, Zod schemas shared by API and web
  reports/    Report snapshot and PDF rendering
  storage/    File storage interface (local disk for now)
  tasks/      Background task queue and task handlers
```

Planned packages from [ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md) (`compliance`, `jurisdictions`) are added with the modules that need them.

## Stubbed or deferred

- Files (photos, report PDFs) are stored on local disk behind an interface; an S3-compatible store is needed before production.
- Corrected report versions are not built yet; reports are made once per inspection and never change.
- `sites.jurisdiction_id` arrives with the compliance engine; `sites.county` is free text for now.
- No organization switcher in the UI; a user in several organizations picks one at sign-in via the API.
