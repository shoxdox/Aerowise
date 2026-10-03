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
| Contracts and recurring inspection obligations | Next |
| Scheduling, technician PWA (offline), inspections, reports, filing, exception inbox, imports | Planned, in that order |

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
pnpm dev                # API on :4000, web on :3000
```

Open http://localhost:3000 and sign in as `owner@example.com`, `office@example.com` or `tech@example.com` with password `aerowise-dev`. The seed creates one fictional provider with 50 customers, 55 sites and their systems. All demo names, addresses and permit numbers are made up.

The OpenAPI document is at http://localhost:4000/openapi.json outside production.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test      # needs TEST_DATABASE_URL; the test database is created and migrated automatically
pnpm build
```

CI runs all four against Postgres on every pull request, plus a Docker build.

## Layout

```
apps/
  api/        Fastify REST API; routes declare a permission or they refuse to load
  web/        Next.js office app; /api/* is proxied to the API
packages/
  db/         SQL migrations, migration runner, Kysely types, seed script
  domain/     Roles and permissions, Zod schemas shared by API and web
```

Planned packages from [ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md) (`worker`, `compliance`, `jurisdictions`, `reports`, `offline-sync`) are added with the modules that need them.

## Stubbed or deferred

- No object storage yet; it arrives with photos and report PDFs.
- No background worker yet; it arrives with report generation and filing.
- `sites.jurisdiction_id` arrives with the compliance engine; `sites.county` is free text for now.
- No organization switcher in the UI; a user in several organizations picks one at sign-in via the API.
