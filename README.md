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
| Invoices (drafts, contract installments, tax, discounts, PDF, email), manual payments, refunds | Done |
| Online card and bank (ACH) payments through Stripe Connect, with signed, idempotent webhooks | Done |
| QuickBooks Online sync (customers, invoices, payments) with a first-sync match review, item mapping, retries and a conflict center | Done |
| Renewals: automatic campaign, one homeowner link to confirm details, choose add-ons, e-sign (typed or drawn) and pay, signed PDF, next term activated | Done |

E-signature, automatic renewals, the customer portal, SMS and route optimization are not built yet.

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

Open http://localhost:3000 and sign in as `owner@example.com`, `office@example.com` or `tech@example.com` with password `aerowise-dev`. The seed creates one fictional provider with 50 customers, 55 sites and their systems, two plans, and contracts on 52 sites, timed so a week of inspections is always coming due and five are overdue. Nine of them are already on the technician's route for today and tomorrow. Signing in as the technician opens the phone app at `/tech` (use your browser's phone view, or open it on a phone on the same network); it keeps working with no signal and sends everything when the connection returns. The office starts at the inbox, which lists only what needs a person. To try invoicing, sign in as the owner, choose Billing and connect the (test) Stripe account, then use "Bill next installment" on any site's contract; the invoice's pay link opens the page a homeowner would see. To try renewals, choose Renewals and "Run campaign now", open a renewal and copy its link: that is the page a homeowner signs and pays on. To try QuickBooks, choose QuickBooks and connect: a built-in test company stands in, pre-filled with near-copies of a few of your customers so the first-sync review has matches to decide. All demo names, addresses and permit numbers are made up.

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
  worker/     Runs background tasks (report PDFs, filing, invoice and renewal emails, QuickBooks sync, the hourly renewal campaign) from the Postgres queue
packages/
  compliance/ Jurisdiction rulesets (rulesets/<key>/v<n>.json), resolver, adapters, filing workflow
  db/         SQL migrations, migration runner, Kysely types, seed script
  domain/     Roles and permissions, Zod schemas shared by API and web
  payments/   Stripe Connect provider, the built-in test provider, webhook handling, payment ledger
  renewals/   Renewal offers, activation into the next contract, and contract creation shared with the API
  quickbooks/ QuickBooks Online client (OAuth, REST), the built-in test company, sync engine, first-sync review
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
- **Stripe runs in test mode by default.** Without `STRIPE_SECRET_KEY`, a built-in test provider stands in outside production: "Connect Stripe" is ready at once and checkout opens Aerowise's own test page, which plays signed webhooks through the real handler. With keys, set the Connect webhook endpoint to `/api/webhooks/stripe` (events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`, `refund.updated`, `account.updated`) and enable card and US bank account payment methods for connected accounts.
- **Invoice emails are not really sent** either; they go to the same outbox as filings.
- No autopay or saved payment methods yet, no processing-fee pass-through, no recurring automatic invoicing (the office bills each contract installment); credit notes are done by voiding and reissuing.
- **QuickBooks runs against a test company by default.** Without `QUICKBOOKS_CLIENT_ID`, a built-in stand-in company (kept in the database) replaces QuickBooks Online outside production. With an Intuit app's keys, register `<PUBLIC_APP_URL>/api/quickbooks/callback` as its redirect URI and set `QUICKBOOKS_TOKEN_KEY`. The Intuit client is covered by unit tests with a stubbed network, not yet by a run against an Intuit sandbox company.
- QuickBooks sync is one-way (Aerowise to QuickBooks). Sales tax, refunds, sub-customers per site and estimates are not sent yet; an invoice with tax waits in the conflict center to be entered by hand.
- E-signature, automatic renewals, the customer portal, SMS and route optimization are not built yet.
