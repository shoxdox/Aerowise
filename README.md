# Aerowise

An operating system for Texas aerobic septic maintenance providers: customers and sites, recurring inspections, an offline technician app, county reporting with proof of filing, and an office that only handles exceptions.

The product spec lives alongside the code: start with [PRODUCT-SPEC.md](PRODUCT-SPEC.md), then [CODEX.md](CODEX.md) for the build order and [docs/](docs/) for the domain model, UX flows, architecture and acceptance tests. Choices made where the spec is silent are logged in [docs/DECISIONS.md](docs/DECISIONS.md).

## What works today

| Area | Status |
| --- | --- |
| Monorepo, Postgres migrations, Docker Compose, CI | Done |
| Hosting on our own server (Docker Compose staging and production, HTTPS, migrations on deploy, health checks, nightly backups) and demo mode for staging (test stand-ins, banner, nightly reseed) | Config done; **server not set up yet** |
| Sign-in, sessions, roles (owner / office / technician / read-only) | Done |
| Tenant isolation (query scoping + composite foreign keys), with tests | Done |
| Customers, contacts, sites, wastewater systems (API + office screens) | Done |
| Append-only audit log | Done |
| Public marketing page at `/`: the problem, how it works, county coverage read from the rulesets (verified ones badged), design-partner pricing from configuration, and a demo request form that lands in `/admin` and emails Aerowise (rate-limited, with a spam trap); placeholder copy | Done |
| Terms of service and privacy policy pages (placeholder text), each owner's acceptance recorded with version and time, and asked again when a version changes | Done; **needs lawyer-reviewed text** |
| Platform admin console (`/admin`): separate admin sign-in, create organizations, list them with usage, invite an organization's first owner, platform audit log | Done |
| User invitations: owner and office invite by email with a role (office cannot invite an owner); single-use links that expire after 7 days; accepting sets a password and signs in | Done |
| Password reset by email (single-use, one-hour links, rate-limited, never says whether an email exists) and deactivating a user (signed out at once) | Done |
| Company settings: name, contact, address, service counties, logo on inspection reports, and the responsible MP license | Done |
| First-run checklist on the office home for a new company (company details, responsible MP, licensed technicians, service counties, customers, Stripe, optional QuickBooks), worked out from real records and hidden once done | Done |
| Aerowise plans: plan state (design partner, trial, active, past due, read-only), dates and founder price per organization, set in `/admin`; read-only companies can view and export everything but change nothing | Done |
| Aerowise billing: monthly count of active contracts per organization, stored with each month; Stripe Billing invoices (per-contract price, monthly minimum, founder price) collected automatically; test stand-in in development | Code done; **needs Stripe Billing keys** |
| Owner subscription page (`/settings/subscription`): plan, days left, estimate at today's count, saved payment method (Stripe customer portal), past invoices | Done |
| Plans, contracts, renewals (next term) and recurring inspection visits with due dates | Done |
| Due-inspections list for the office | Done |
| Jobs, office scheduling screen, technician daily route | Done |
| Inspection templates, idempotent inspection sync, photo uploads with signed links, supervisor override (API) | Done |
| Technician phone app (`/tech`) that works offline, with an exactly-once sync test | Done |
| Customer and authority PDF reports (immutable), per-site compliance history, background worker | Done |
| Compliance engine: jurisdictions, versioned rulesets, filing by email or by hand, with proof and confirmation | Done |
| Filing readiness: draft LCRA and Harris County profiles (never auto-send), reviewed site-to-authority assignment with evidence, licenses and registrations checked before release, immutable submission packages with the LCRA cover sheet, contract filings, complaint and monitoring-notice review, corrected report versions, customer delivery records, licensed provider signature on each authority report (30 TAC 285.7(b)(3)), contract deadlines by kind and the notice owed when a contract ends | Built and tested locally; **not used for a real filing yet** |
| Exception inbox as the office home screen (overdue visits, unfinished inspections, filing problems, late next visits, open issues, contracts ending) | Done |
| CSV/XLSX customer import with column detection, sheet choice, saved column choices, contract dates and last inspection, preview, duplicate flags and all-or-nothing commit | Done |
| Invoices (drafts, contract installments, tax, discounts, PDF, email), manual payments, refunds | Done |
| Online card and bank (ACH) payments through Stripe Connect, with signed, idempotent webhooks | Done |
| QuickBooks Online sync (customers, invoices, payments) with a first-sync match review, item mapping, retries and a conflict center | Done |
| Renewals: automatic campaign, one homeowner link to confirm details, choose add-ons, e-sign (typed or drawn) and pay, signed PDF, next term activated | Done |
| Customer portal: magic link (copied or emailed, or asked for by email) with plan, next visit, inspection reports, invoices and payments, renewal, and service requests that land in the inbox | Done |
| Text messages (Twilio): on the way, inspection done, report ready (with a portal link), renewal and payment reminders; consent, STOP/START, quiet hours, delivery receipts, replies in the inbox | Done |
| Routing: sites found on the map, day map of every route, driving and day-length estimates, one-click route optimization, unscheduled visits ranked by distance from a route | Done |

Route optimization is not built yet.

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

Open http://localhost:3000 and sign in as `owner@example.com`, `office@example.com` or `tech@example.com` with password `aerowise-dev`. The seed creates one fictional provider with 50 customers, 55 sites and their systems, two plans, and contracts on 52 sites, timed so a week of inspections is always coming due and five are overdue. Nine of them are already on the technician's route for today and tomorrow. Signing in as the technician opens the phone app at `/tech` (use your browser's phone view, or open it on a phone on the same network); it keeps working with no signal and sends everything when the connection returns. The office starts at the inbox, which lists only what needs a person. To try invoicing, sign in as the owner, choose Billing and connect the (test) Stripe account, then use "Bill next installment" on any site's contract; the invoice's pay link opens the page a homeowner would see. To try renewals, choose Renewals and "Run campaign now", open a renewal and copy its link: that is the page a homeowner signs and pays on. To try the customer portal, open any customer and choose "Copy portal link": the link opens what that homeowner sees, and a service request sent from it shows in the inbox. To try QuickBooks, choose QuickBooks and connect: a built-in test company stands in, pre-filled with near-copies of a few of your customers so the first-sync review has matches to decide. All demo names, addresses and permit numbers are made up.

The Aerowise team's console is at http://localhost:3000/admin. In development the seed creates a platform admin, `admin@example.com` with password `aerowise-dev`. Platform admins are a separate identity from company users: an owner's sign-in never opens `/admin`, and an admin's never opens the office screens. Outside development the seed creates no admin; create one with the CLI, which reads the password (12 characters or more) from stdin so it stays out of shell history:

```sh
pnpm db:create-platform-admin you@example.com "Your Name"
# Docker: docker compose run --rm -T api pnpm db:create-platform-admin you@example.com "Your Name"
```

The OpenAPI document is at http://localhost:4000/openapi.json outside production.

Hosted staging and production run with Docker Compose on our own server, behind Caddy for HTTPS; [docs/engineering/DEPLOY.md](docs/engineering/DEPLOY.md) covers the one-time setup (`deploy/vps/setup.sh`), deploys, backups and health checks. A Render setup is kept for later in [`render.yaml`](render.yaml). Staging is the public demo: with `DEMO_MODE=true` every outside service is a test stand-in whatever keys are set, every screen says "Demo data. Nothing is sent.", and it resets to the seed every night.

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
  worker/     Runs background tasks (report PDFs, filing, invoice and renewal emails, QuickBooks sync, the hourly renewal campaign, texts and payment reminders) from the Postgres queue
packages/
  compliance/ Jurisdiction rulesets (rulesets/<key>/v<n>.json), resolver, adapters, filing workflow
  db/         SQL migrations, migration runner, Kysely types, seed script
  domain/     Roles and permissions, Zod schemas shared by API and web
  payments/   Stripe Connect provider, the built-in test provider, webhook handling, payment ledger
  renewals/   Renewal offers, activation into the next contract, and contract creation shared with the API
  quickbooks/ QuickBooks Online client (OAuth, REST), the built-in test company, sync engine, first-sync review
  reports/    Report snapshot and PDF rendering
  routing/    Travel estimates, route optimization, geocoders (US Census, built-in test) and the site lookup sweep
  sms/        Twilio client, the built-in test provider, sending once per text, replies (STOP/START) and delivery receipts
  storage/    File storage: local disk, or Cloudflare R2 over the S3 API
  tasks/      Background task queue and task handlers
```

[ARCHITECTURE.md](docs/engineering/ARCHITECTURE.md) plans separate `compliance` and `jurisdictions` packages; while there is one adapter they live together in `packages/compliance`.

## Stubbed or deferred

- Files (photos, report PDFs, outbox mail) are stored on local disk unless the four `R2_*` settings are present; then they go to a private Cloudflare R2 bucket, keyed by organization id. `pnpm files:copy-to-r2` copies existing files across and checks each SHA-256.
- **Real authorities are drafts.** `tx-lcra-ossf` and `tx-harris-county-oce` are written from public pages (docs/jurisdictions/) and list their open questions; a draft never sends on its own and Harris inspection reports are never sent (submission unpublished). Brazoria has no ruleset (its site refused every fetch). `tx-example-county` is fictional and is not loaded in production.
- Authority boundaries are not automated: sites in counties LCRA or Harris County partly cover wait for a person to choose the authority with evidence.
- The LCRA cover sheet is LCRA's own fillable PDF, filled in and flattened. LCRA has not confirmed it accepts it filled electronically and emailed.
- **Email goes through Resend when `RESEND_API_KEY` is set**, and otherwise is written as `.eml` files to `<org>/outbox/` in file storage. Every send carries an idempotency key; a send whose outcome was lost is looked up at Resend before any retry past Resend's 24-hour key window. Point a Resend webhook (events `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`) at `<PUBLIC_APP_URL>/api/webhooks/email` and set `RESEND_WEBHOOK_SECRET`; a bounced filing email shows in the inbox. Set `EMAIL_REDIRECT_TO` on staging so every message lands in one test inbox.
- Acknowledgments are recorded by hand (reference, kind of evidence, date, from whom); nothing reads the authority's replies, and receipt files cannot be uploaded yet. Neither LCRA nor Harris County publishes an acknowledgment process.
- No organization switcher in the UI; a user in several organizations picks one at sign-in via the API.
- **Imports** read every sheet of an `.xlsx` (the office picks one) or a CSV, up to 10 MB and 5,000 rows; old `.xls` files are refused. A committed import cannot be undone from the screen yet, though every customer and site it created carries its `import_id`.
- **Stripe runs in test mode by default.** Without `STRIPE_SECRET_KEY`, a built-in test provider stands in outside production: "Connect Stripe" is ready at once and checkout opens Aerowise's own test page, which plays signed webhooks through the real handler. With keys, set the Connect webhook endpoint to `/api/webhooks/stripe` (events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `refund.created`, `refund.updated`, `account.updated`) and enable card and US bank account payment methods for connected accounts.
- Invoice, renewal and portal emails use the same transport as filings.
- No autopay or saved payment methods yet, no processing-fee pass-through, no recurring automatic invoicing (the office bills each contract installment); credit notes are done by voiding and reissuing.
- **QuickBooks runs against a test company by default.** Without `QUICKBOOKS_CLIENT_ID`, a built-in stand-in company (kept in the database) replaces QuickBooks Online outside production. With an Intuit app's keys, register `<PUBLIC_APP_URL>/api/quickbooks/callback` as its redirect URI and set `QUICKBOOKS_TOKEN_KEY`. The Intuit client is covered by unit tests with a stubbed network, not yet by a run against an Intuit sandbox company.
- QuickBooks sync is one-way (Aerowise to QuickBooks). Sales tax, refunds, sub-customers per site and estimates are not sent yet; an invoice with tax waits in the conflict center to be entered by hand.
- **Texts run in test mode by default.** Without `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, a built-in test provider stands in outside production: nothing is sent, each text shows as delivered on the Texts page, Twilio's magic numbers (`+15005550001` invalid, `+15005550009` not a mobile, `+15005550004` unsubscribed) fail the way Twilio fails them, and the Texts page can play a customer's reply. With Twilio keys, the owner enters the organization's Twilio number on the Texts page and points that number's incoming messages at `<PUBLIC_APP_URL>/api/webhooks/sms/inbound` (or set `SMS_WEBHOOK_BASE_URL` to the API's public address plus `/api`). Twilio's request signatures are checked against that exact URL. US numbers also need A2P 10DLC registration in Twilio before carriers deliver them. The Twilio client is covered by unit tests with a stubbed network, not yet by a run against a Twilio account.
- **Sites are found on the map with the US Census geocoder in production** (free, no key; `GEOCODER=off` turns it off). Outside production the built-in test geocoder gives each address a made-up, repeatable spot near central Texas (ZIP `00000` is not found). Lookups run in the worker. Driving times are estimates from straight-line distance; see docs/DECISIONS.md.
