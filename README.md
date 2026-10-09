# Aerowise

Software for Texas septic maintenance and service providers: customers, sites and contracts, recurring inspections, an offline technician app, reporting and filing evidence, renewals, invoices, payments and the customer portal.

**Current handoff:** read [Demo and pilot status](docs/DEMO-PILOT-BRIEF.md) first. Staging runs `a444be2` (migration `0060`, all eight workflow flags on). Main is ahead: the October 9 [outside review](docs/engineering/REVIEW-2026-10-09.md) and its three P1 fixes (`c733c22`), then a demo with a year of real LCRA history and grouped office navigation (`f871bee` and after); staging shows these once redeployed. Physical-phone, real-provider/accounting/legal and authority acceptance remain separate gates. Production is unchanged.

## Start here

- [Current status and next steps](docs/DEMO-PILOT-BRIEF.md): what shipped, what remains, what Justin needs to decide.
- [Pilot worksheet](docs/PILOT-CALL-SHEET.md): provider documents first, then targeted acceptance questions.
- [Delivery record](docs/engineering/ROADMAP.md): shipped workflows, current validation and deferred features.
- [Agent working guidance](CODEX.md): document precedence and engineering boundaries.
- [Deployment runbook](docs/engineering/DEPLOY.md) and [configuration](.env.example).
- [Street map](docs/engineering/MAP.md): coverage, licences and installing the map file.
- [County evidence archive](docs/jurisdictions/research/2026-10-06/ARCHIVE.md): originals, hashes, extraction and research limits.
- [Walkthrough results](docs/product/W11-WALKTHROUGH.md) and [decisions](docs/DECISIONS.md).

`PRODUCT-SPEC.md` and the domain/architecture documents are design references. Old kickoff briefs and build-horizon/parity planning lists have been retired from the active checkout. Research inputs and original documents are historical evidence, not instructions to rebuild completed work.

## Implemented

- Organization isolation, role-based access, invitations, password reset, audit history and separate platform administration.
- Customers, sites, systems, plans, contracts, recurring due dates, scheduling and estimated route optimization.
- Offline technician inspections with sync, signatures and photos; an inspection for a visit the office changed meanwhile is held for the office to accept or set aside, never refused; report PDFs, review and filing preparation with recorded proof.
- Renewals, homeowner signatures, invoicing, Stripe Connect and Aerowise subscription billing, customer portal, imports and exports.
- General work orders, offline work records, service items and fractional quantities, estimates/deposits/refunds, frozen plan versions/options/coverage, pumping/disposal, conventional service and installation summaries, non-aerobic service cycles, mixed-service maps and authority CSV exports.
- One-way QuickBooks sync, SMS workflows and configurable file/email providers. Real-service validation still depends on configured accounts and controlled integration checks.
- Demo organization isolation enforced by API and worker, synthetic contacts, watermarked exports, guided data and first-run help. The demo company's Lake Travis sites report to LCRA (a real authority, assigned with evidence marked fictional) and its Blanco sites to the fictional Example County; a year of inspections, reports, signatures and filings is played through the API on the story's own clock, so every site has real history.
- Passwordless visitor demos lasting 24 hours, per-address/global creation limits, role switching and platform-created expiring prospect demos. A trial starts as a new company without synthetic customers.
- Draft jurisdiction coverage, per-field evidence/confirmation and preparation of proposed new immutable rule versions. Saving an answer never publishes a rule or verifies an authority.

Real-authority profiles remain drafts. Published rules support implementation; they do not prove acceptance of Aerowise reports. Actual permit/authority assignment is reviewed per site. See the pilot worksheet for remaining confirmations.

## Run locally

Requires Node 22.12+, pnpm 10 and PostgreSQL 16, or Docker Compose. Copy `.env.example` to `.env` and set the local database URLs before using pnpm directly.

```sh
docker compose up --build
# In another terminal, on the disposable local demo database:
docker compose run --rm api pnpm db:seed
```

Without Docker:

```sh
cp .env.example .env
pnpm install
pnpm db:seed
pnpm dev
```

The API is on `:4000`, the web app on `:3000`, and the worker runs alongside them. `db:seed` applies migrations, seeds fictional data and plays the guided demo story through the API. Use a disposable development/demo database; `db:reseed-demo` replaces the public demo company and visitor demos (data, people and stored files) and keeps prospect demos and every real company.

In local development, seeded users are `owner@example.com`, `office@example.com` and `tech@example.com`, password `aerowise-dev`. The technician opens `/tech`; the office opens the inbox. Development also creates `admin@example.com` for `/admin`. These credentials are for development only. Public visitors use `/demo` on a dedicated demo deployment, with individual companies and no shared password or platform-admin access.

Outside development, create a platform admin using the CLI, which reads its password from stdin:

```sh
pnpm db:create-platform-admin you@example.com "Your Name"
```

The API exposes `/openapi.json` outside production. The marketing page offers "Try the demo" only on a demo deployment. `DEMO_MODE` selects deployment stand-ins; `DEMO_LIVE_SERVICES` is for controlled staging integration checks. Demo organizations always retain their server/worker isolation regardless of those settings.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @aerowise/web e2e
```

Tests need `TEST_DATABASE_URL`; browser tests seed their own database and need PostgreSQL and free ports 3000/4000. The complete workflow also includes fresh-seed/config validation, dependency audit and `scripts/compose-smoke.sh`; see [.github/workflows/ci.yml](.github/workflows/ci.yml).

GitHub Actions did not run the final build because account minutes/billing blocked hosted jobs. PRs recorded local checks instead. The [current handoff](docs/DEMO-PILOT-BRIEF.md#validation-evidence) identifies the tested commits and sandbox exceptions. A merged PR or refreshed ZIP is not a deployment.

## Layout

- `apps/api`: Fastify API with declared route permissions.
- `apps/web`: Next.js office app, `/tech`, marketing and platform administration.
- `apps/worker`: PostgreSQL-backed task execution.
- `packages/db`, `domain`: migrations, seed, shared schemas and permissions.
- `packages/compliance`, `reports`: versioned rules, authority adapters, filing workflows and PDFs.
- `packages/payments`, `renewals`, `quickbooks`, `sms`: provider integrations and stand-ins.
- `packages/storage`, `routing`, `tasks`: files, estimated routes, queue and demo service gates.
- `deploy/vps`: Compose, nginx/Caddy options, migrations, backup and restore tooling.

## Limits before real operation

Authority acceptance, site-specific permits and provider credentials must be established for the pilot. Validate staging health, migrations, backup/restore and real-device offline recovery on the actual deployment. Terms/privacy text still needs review before production use. Real Stripe, email, storage, QuickBooks and SMS need their own configured-account checks where used.

Deferred features include homeowner autopay/saved payment methods, two-way QuickBooks sync, an organization switcher, IoT and other states. They are not the next automatic coding queue. Three cosmetic walkthrough items remain documented; no new feature phase has been authorized by this handoff.
