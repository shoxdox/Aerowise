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
| Compliance engine: jurisdictions, versioned rulesets, filing by email or by hand, with proof and confirmation (fake `tx-example-county` only) | Done |
| Exception inbox as the office home screen (overdue visits, unfinished inspections, filing problems, late next visits, open issues, contracts ending) | Done |
| CSV/XLSX customer import with column detection, preview, duplicate flags and all-or-nothing commit | Done |

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

Open http://localhost:3000 and sign in as `owner@example.com`, `office@example.com` or `tech@example.com` with password `aerowise-dev`. The seed creates one fictional provider with 50 customers, 55 sites and their systems, two plans, and contracts on 52 sites, timed so a week of inspections is always coming due and five are overdue. Nine of them are already on the technician's route for today and tomorrow. Signing in as the technician opens the phone app at `/tech` (use your browser's phone view, or open it on a phone on the same network); it keeps working with no signal and sends everything when the connection returns. The office starts at the inbox, which lists only what needs a person. All demo names, addresses and permit numbers are made up.

The OpenAPI document is at http://localhost:4000/openapi.json outside production.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test      # needs TEST_DATABASE_URL; the test database is created and migrated automatically
pnpm build
pnpm --filter @aerowise/web e2e   # offline sync test; run after `pnpm build`, needs Postgres on :5432 and ports 3000/4000 free
```

CI runs all of these against Postgres on every pull request. It also brings the stack up with `docker compose up`, seeds it, and runs `scripts/compose-smoke.sh`, which signs in through the web app as the office (inbox, a CSV import) and as the technician (today's route). The end-to-end test resets and seeds its own `aerowise_e2e` database.

## Layout

```
apps/
  api/        Fastify REST API; routes declare a permission or they refuse to load
  web/        Next.js office app and technician phone app (/tech); /api/* is proxied to the API
  worker/     Runs background tasks (report PDFs, filing emails) from the Postgres queue
packages/
  compliance/ Jurisdiction rulesets (rulesets/<key>/v<n>.json), resolver, adapters, filing workflow
  db/         SQL migrations, migration runner, Kysely types, seed script
  domain/     Roles and permissions, Zod schemas shared by API and web
  reports/    Report snapshot and PDF rendering
  storage/    File storage interface (local disk for now)
  tasks/      Background task queue and task handlers
```

[ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md) plans separate `compliance` and `jurisdictions` packages; while there is one adapter they live together in `packages/compliance`.

## Stubbed or deferred

- Files (photos, report PDFs) are stored on local disk behind an interface; an S3-compatible store is needed before production.
- Corrected report versions are not built yet; reports are made once per inspection and never change.
- **The only jurisdiction is fictional.** `tx-example-county` (counties named "Example County") exists to exercise the engine; its rules are made up. Real authorities need rulesets written from their published requirements before anyone files with them.
- **Filing emails are not really sent.** They are written as `.eml` files to `<org>/outbox/` in file storage. Production needs a mail provider that honours an idempotency key (for example Resend's `Idempotency-Key`) behind the `EmailTransport` interface.
- Confirmations are recorded by hand (the authority's reference number); nothing reads the authority's replies yet, and receipts cannot be uploaded yet.
- No organization switcher in the UI; a user in several organizations picks one at sign-in via the API.
- **Imports** read the first sheet of an `.xlsx` or a CSV, up to 10 MB and 5,000 rows; old `.xls` files are refused. A committed import cannot be undone from the screen yet, though every customer and site it created carries its `import_id`.
- Payments, invoicing, QuickBooks, e-signature, automatic renewals, the customer portal, SMS and route optimization are not built (see the scope note above).
