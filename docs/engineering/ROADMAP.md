# Pilot roadmap

This breaks workstreams W1–W8 of [the Pilot Build Brief](../PILOT-BUILD-BRIEF.md) into PR-sized tasks. Each task is one PR that a reviewer can read in about 15 minutes. The brief is the source of truth; when this file and the brief disagree, the brief wins and this file gets fixed.

Task ids (W2.3, W6.C1) are stable: they stay the same when tasks are reordered or finished, and PR titles start with them. New tasks get the next free number; a dropped task is marked "dropped", not deleted.

**Status** is one of: not started, in progress (with the PR), done (with the PR), blocked (and why). Update it at the end of every working session.

**Rules that apply to every task** (from the brief): lint, typecheck, tests, build and e2e stay green; no test is weakened; a draft ruleset never auto-sends; county rules come only from cited sources (URL and read date), with unknowns in `profile.unresolved`; synthetic data only; secrets only through env, with `.env.example` updated; every new tenant table has `organization_id`, composite foreign keys and an isolation test; migrations are forward-only; open choices go in `docs/DECISIONS.md`. Anything only Justin can provide is built behind the provider interface with a test stand-in and listed under "Needs from Justin" in the PR.

## Order

1. **Now, in parallel:** W1, W2, W3, W6. Each stream works its tasks in order.
2. **After W2.1 lands** (organizations created outside the seed): W4 and W5.
3. **Then:** W7 and W8.
4. **W9 is not started** until a paying customer asks.

Where two streams touch the same file, the dependency column says who goes first. The known overlaps:

- Outbound email: W3.1 replaces the outbox transport. W2.2, W2.3, W4.4 and W8.2 send through `EmailTransport` and work against the outbox until then.
- Rate limits: W2.3 adds the password-reset limit; W3.3 reviews every auth and public-link limit afterwards.
- `/admin`: W2.1 creates the console and platform-admin guard; W4.1, W5.6, W6.6 and W8.2 add pages to it.
- The office `/settings/billing` page is the provider's Stripe Connect setup today. W4.3's page for paying Aerowise is a separate page (`/settings/subscription`), so the two Stripe relationships stay apart, as the brief requires.

## Status at a glance

| ID | Task | Depends on | Status |
| --- | --- | --- | --- |
| W1.1 | Hosting choice and deploy config | — | done (Render chosen; config in `render.yaml`, waiting on a Render account) |
| W1.2 | Demo mode: banner, nothing leaves, demo seed | — | not started |
| W1.3 | Deploy from main through CI | W1.1 | not started |
| W2.1 | Platform admin and `/admin`: create and list organizations | — | done (#22) |
| W2.2 | User invites | W2.1 | in progress (PR open) |
| W2.3 | Password reset and user deactivation | W2.2 | not started |
| W2.4 | Organization settings | — | not started |
| W2.5 | First-run checklist | W2.2, W2.4 | not started |
| W2.6 | Read-only support impersonation and the onboarding e2e | W2.1–W2.3 | not started |
| W3.1 | Real email transport with idempotency and bounces | — | done (#24); sending for real needs Justin's Resend account, key and DNS |
| W3.2 | Cloudflare R2 object store | — | done (#30); using R2 needs Justin's Cloudflare account, bucket and token |
| W3.3 | Production secrets check and hardening | — | done (#32); Render's TRUST_PROXY value to be read off staging |
| W3.4 | Observability: logs, error tracking, alerts | — | done (PR pending); needs a Sentry DSN and an uptime monitor from Justin |
| W3.5 | Backups and restore runbook | W1.1 | not started |
| W4.1 | Plan states and read-only mode | W2.1 | done (#35) |
| W4.2 | Active-contract count and Stripe Billing provider | W4.1 | in progress (PR open); needs Stripe Billing keys from Justin |
| W4.3 | Owner subscription page | W4.2 | not started |
| W4.4 | Expiry reminders and the full plan lifecycle | W4.2, W4.3 | not started |
| W4.5 | Platform fee on homeowner payments | W4.1 | not started |
| W5.1 | Import: several sheets and saved column mappings | W2.1 | not started |
| W5.2 | Import: contracts, last inspection, permits, make and model | W5.1 | not started |
| W5.3 | Undo a committed import | W5.2 | not started |
| W5.4 | Onboarding summary | W5.2 | not started |
| W5.5 | Full data export | W2.1 | not started |
| W5.6 | Organization data deletion and data-handling page | W2.1, W5.5 | not started |
| W6.1 | Per-ruleset service intervals | — | done (#21) |
| W6.2 | Annual lab tests as required tests | W6.1 | done (#26) |
| W6.3 | Six-month schedule with electronic monitoring | W6.1 | done (#28) |
| W6.4 | Per-authority report templates and fees | W6.1 | done (#33) |
| W6.5 | Ruleset verification workflow and badge | — | done (#36) |
| W6.6 | Ruleset coverage page in `/admin` | W2.1, W6.5 | not started |
| W6.C* | County rulesets, one authority per PR | W6.1, W6.2 | not started |
| W7.1 | Stripe Connect live readiness | W1.3 | not started |
| W7.2 | QuickBooks against an Intuit sandbox | W1.3 | not started |
| W7.3 | Twilio on a real account | W1.3 | not started |
| W8.1 | Public marketing page | W6.5 | not started |
| W8.2 | Demo request form | W2.1, W8.1 | not started |
| W8.3 | Terms and privacy pages with recorded acceptance | W2.1 | not started |

## W1. Hosted demo and staging

### W1.1 Hosting choice and deploy config

- **Scope:** Compare Render, Railway and Fly.io for the existing Dockerfile (api, web, worker) plus managed Postgres 16; record the choice and monthly cost in `docs/DECISIONS.md`. Add the host's config as code for two environments, staging and production. Migrations run automatically on deploy, before the new api starts. Add a worker health check (the api already has `/health`). Document a one-command deploy in `docs/engineering/DEPLOY.md`.
- **Files likely touched:** host config at the repo root (`render.yaml`, `railway.json` or `fly.toml`), `Dockerfile`, `apps/worker/src/index.ts`, `packages/db/src/migrate.ts`, `.env.example`, `docs/DECISIONS.md`, `docs/engineering/DEPLOY.md`.
- **Acceptance test:** a test for the worker health check; the CI docker smoke job still passes; the config file passes the host's own validator where one exists.
- **Depends on:** nothing.
- **Needs from Justin:** a hosting account and, later, a domain.

### W1.2 Demo mode

- **Scope:** A `DEMO_MODE` setting for staging. With it on, every outside service uses its test stand-in whatever keys are set (email to the outbox, SMS, Stripe, QuickBooks, geocoding, filings), and the web app shows "Demo data. Nothing is sent." on every screen. A demo seed with fictional owner, office and technician users and enough data to walk every README flow, plus a reseed command for the nightly reset.
- **Files likely touched:** `apps/api/src/app.ts`, `apps/worker/src/index.ts`, `packages/db/src/seed.ts`, `apps/web/app/layout.tsx` or a banner component, `.env.example`, `README.md`.
- **Acceptance test:** API tests showing each provider resolves to its test stand-in in demo mode even when real keys are set; an e2e check that the banner shows.
- **Depends on:** nothing.

### W1.3 Deploy from main through CI

- **Scope:** A GitHub Actions job that deploys staging from `main` only after the check, docker and e2e jobs pass, and skips cleanly when the deploy secret is absent. A nightly reseed of staging. Production deploy as a manual, protected step. HTTPS on a placeholder domain until Justin buys one.
- **Files likely touched:** `.github/workflows/ci.yml` or a new `.github/workflows/deploy.yml`, `docs/engineering/DEPLOY.md`.
- **Acceptance test:** the workflow runs green on the PR (deploy skipped without secrets); the PR description lists the secrets Justin must add. Done for the brief when a fresh visitor can open staging, sign in as each demo user, and walk the README flows with nothing leaving the system.
- **Depends on:** W1.1.
- **Needs from Justin:** hosting account, deploy token as a GitHub secret, domain.

## W2. Company onboarding and user management

### W2.1 Platform admin and `/admin`

- **Scope:** A platform-admin identity separate from tenant roles (owner, office, technician, read-only), with its own route guard; created by a CLI command, never by the seed in production. An `/admin` console: create an organization, list organizations with usage (active contracts, users, last activity). Every admin action writes an audit event.
- **Files likely touched:** new migration `packages/db/migrations/0017_platform_admin.sql`, `packages/db/src/schema.ts`, `packages/db/src/cli.ts`, `apps/api/src/auth/plugin.ts`, new `apps/api/src/routes/admin.ts`, `packages/domain/src/roles.ts`, new `apps/web/app/admin/`, `apps/api/test/helpers.ts`.
- **Acceptance test:** API tests: a tenant owner cannot reach any admin route; a platform admin can create an organization and see its usage; an audit event is written.
- **Depends on:** nothing. W4, W5 and the other `/admin` pages build on it.

### W2.2 User invites

- **Scope:** Owner and office invite a user by email with a role; the platform admin invites an organization's first owner. The invite link is single-use and expires; accepting it sets a password and signs the user in. Invites are sent through `EmailTransport` (outbox until W3.1). Office cannot invite an owner.
- **Files likely touched:** new migration (invitations table, tenant-scoped), `packages/domain/src/` (invite schemas), `apps/api/src/routes/auth.ts` or a new `users.ts`, `apps/web/app/(office)/settings/` (users page), new accept page under `apps/web/app/`.
- **Acceptance test:** API tests for accept, expiry, reuse, tampered token, role limits and cross-organization isolation.
- **Depends on:** W2.1.

### W2.3 Password reset and user deactivation

- **Scope:** Password reset by email with a single-use, expiring token and a rate limit; the response never reveals whether an email exists. Owner can deactivate a user: their sessions are revoked at once and they cannot sign in.
- **Files likely touched:** `apps/api/src/routes/auth.ts`, `apps/api/src/auth/sessions.ts`, new migration (reset tokens), `apps/web/app/login/`, users settings page.
- **Acceptance test:** API tests for reset, token reuse and expiry, rate limit, and a deactivated user's existing session failing on the next request.
- **Depends on:** W2.2.

### W2.4 Organization settings

- **Scope:** Owner edits company name, TCEQ MP license, address, phone, logo (used on PDFs) and service counties. The logo is an uploaded image through the existing upload path, shown on customer and authority PDFs.
- **Files likely touched:** new migration (service counties, MP license fields if not covered by credentials), `apps/api/src/routes/` (organization settings), `packages/reports/src/`, `apps/web/app/(office)/settings/`.
- **Acceptance test:** API tests for edit permissions and isolation; a PDF test showing the logo is embedded.
- **Depends on:** nothing.

### W2.5 First-run checklist

- **Scope:** A checklist on the office home for a new organization: company details, responsible MP, technicians and their credentials, service counties, import customers, connect Stripe, connect QuickBooks (optional). Each item is computed from real data, not ticked by hand, and the checklist hides when complete.
- **Files likely touched:** `packages/domain/src/` (checklist computation), `apps/api/src/routes/inbox.ts` or a new route, `apps/web/app/(office)/inbox/` or the home page.
- **Acceptance test:** domain tests for each item's rule; an API test for a fresh organization and a completed one.
- **Depends on:** W2.2, W2.4.

### W2.6 Read-only support impersonation and the onboarding e2e

- **Scope:** A platform admin can open an organization read-only for support; every impersonation start and end writes an audit event, and no write succeeds while impersonating. Add the e2e the brief asks for: create a company in `/admin`, the owner accepts the invite, invites a technician, the technician signs into `/tech`.
- **Files likely touched:** `apps/api/src/auth/plugin.ts`, `apps/api/src/routes/admin.ts`, `apps/web/app/admin/`, new `apps/web/e2e/onboarding.spec.ts`.
- **Acceptance test:** API tests that impersonated writes are refused and audited; the new e2e passes.
- **Depends on:** W2.1, W2.2, W2.3.

## W3. Production plumbing

### W3.1 Real email transport

- **Scope:** An `EmailTransport` for Resend or Postmark (record the choice). Every send carries an idempotency key; an uncertain send is reconciled with the provider before any retry past its idempotency window (PILOT-FILING-READINESS.md item 5). Bounce and complaint webhooks are verified and recorded on the delivery. The outbox stays the default outside production.
- **Files likely touched:** `packages/compliance/src/email.ts`, new provider module, `apps/api/src/app.ts`, `apps/worker/src/index.ts`, a webhook route, new migration (delivery events), `.env.example`, `docs/DECISIONS.md`.
- **Acceptance test:** tests against a fake provider for idempotent retry, reconcile-before-retry, and bounce and complaint recording; existing filing and invoice email tests unchanged.
- **Depends on:** nothing.
- **Needs from Justin:** a mail provider account, API key, and DNS records for the sending domain.

### W3.2 Cloudflare R2 object store

- **Scope:** An `ObjectStore` for R2 over the S3 API: private bucket, signed URLs only, keys prefixed by organization id. A script that copies files from local disk to R2 and verifies hashes. Local disk stays the default outside production.
- **Files likely touched:** `packages/storage/src/index.ts`, new `packages/storage/src/r2.ts`, `apps/api/src/app.ts`, `apps/worker/src/index.ts`, a migration script under `scripts/`, `.env.example`.
- **Acceptance test:** the existing store tests run against both stores (R2 through an S3-compatible fake); a test that keys are organization-prefixed; a photo upload and download round-trip.
- **Depends on:** nothing.
- **Needs from Justin:** Cloudflare account, R2 bucket and API token.

### W3.3 Production secrets check and hardening

- **Scope:** One config check at boot: production refuses to start when a required secret is missing (FILE_SIGNING_SECRET, QUICKBOOKS_TOKEN_KEY when QuickBooks is on, mail and storage keys), and names the missing ones. Rate limits on login, password reset and magic-link requests reviewed together; security headers; session cookie flags; a dependency audit step in CI.
- **Files likely touched:** new `apps/api/src/config.ts`, `apps/api/src/server.ts`, `apps/worker/src/index.ts`, `apps/api/src/app.ts`, `apps/web/next.config.ts`, `.github/workflows/ci.yml`.
- **Acceptance test:** tests that production boot fails for each missing secret and development falls back to test providers; header and cookie flag tests; rate-limit tests.
- **Depends on:** nothing (W2.3 adds the reset route; whichever lands second covers it).

### W3.4 Observability

- **Scope:** Structured JSON logs with request and organization ids; error tracking behind a small interface with a no-op default (Sentry when a DSN is set); an alert when the worker queue stalls or a filing task fails repeatedly; an uptime check target.
- **Files likely touched:** `apps/api/src/app.ts`, `apps/worker/src/index.ts`, `packages/tasks/src/`, new error-reporting module, `.env.example`.
- **Acceptance test:** tests that a stalled queue and repeated filing failures raise the alert (through a test reporter), and that errors are reported with the organization id.
- **Depends on:** nothing.
- **Needs from Justin:** an error-tracking account (for example Sentry).

### W3.5 Backups and restore runbook

- **Scope:** Daily Postgres backups on the chosen host, and a restore procedure in `docs/engineering/RUNBOOK.md`, run once against staging and written down with the date and result.
- **Files likely touched:** host config, `docs/engineering/RUNBOOK.md`, possibly a restore-check script under `scripts/`.
- **Acceptance test:** the runbook records one completed restore with the row counts checked.
- **Depends on:** W1.1 (and staging being up).

## W4. Aerowise billing

### W4.1 Plan states and read-only mode

- **Scope:** Each organization has a plan state (`design_partner`, `trial`, `active`, `past_due`, `read_only`) with start and end dates and an optional price override (founder price), editable in `/admin`. A read-only organization can read everything, export everything, and still sees due inspections, filings and deadlines; writes are refused with a clear message. Prices, minimums and trial lengths are configuration, not constants.
- **Files likely touched:** new migration (organization plans), `packages/domain/src/` (plan states and transitions), `apps/api/src/auth/plugin.ts` (write guard), `apps/api/src/routes/admin.ts`, `apps/web/app/admin/`, `docs/DECISIONS.md`.
- **Acceptance test:** domain tests for allowed transitions; API tests that a read-only organization's writes fail and its compliance views and export still work.
- **Depends on:** W2.1.

### W4.2 Active-contract count and Stripe Billing provider

- **Scope:** A monthly job counts active contracts per organization on the billing date (status active, including "Ending") and stores the count with each billing period. A `BillingProvider` interface with a test stand-in like the payments test provider, and a Stripe Billing implementation: one Stripe customer per organization, usage-based per-contract price, monthly minimum, founder price override. Kept separate from Stripe Connect.
- **Files likely touched:** new package or module (for example `packages/billing/`), new migration (billing periods, invoices), `apps/worker/src/index.ts`, `packages/tasks/src/`, webhook route, `.env.example`.
- **Acceptance test:** tests for the count rule (ending contracts counted, ended ones not), minimum and override, the stored count, and idempotent monthly runs.
- **Depends on:** W4.1.
- **Needs from Justin:** Stripe Billing enabled, price ids and webhook secret.

### W4.3 Owner subscription page

- **Scope:** Owner-only page: plan, trial or design-partner days left, this month's estimated bill, payment method, past invoices. Separate from the existing `/settings/billing` (Stripe Connect) page.
- **Files likely touched:** `apps/api/src/routes/` (subscription), new `apps/web/app/(office)/settings/subscription/`.
- **Acceptance test:** API tests for owner-only access and the estimate; a screenshot in the PR.
- **Depends on:** W4.2.

### W4.4 Expiry reminders and the full lifecycle

- **Scope:** Reminder emails 14, 7 and 1 days before a trial or design-partner period ends; unpaid accounts move to `read_only` at the end; `past_due` from Stripe payment failure; payment brings an account back to `active`.
- **Files likely touched:** `apps/worker/src/index.ts`, billing module, email templates.
- **Acceptance test:** the brief's test: an organization goes trial → active → past_due → read_only and back with the correct per-contract amount, and while read-only still sees due inspections and can export.
- **Depends on:** W4.2, W4.3.

### W4.5 Platform fee on homeowner payments

- **Scope:** A Stripe Connect application fee per organization, default 0, set in `/admin` and applied to homeowner card and ACH payments.
- **Files likely touched:** `packages/payments/src/stripe.ts`, `packages/payments/src/provider.ts`, `apps/api/src/lib/checkout.ts`, admin page, migration.
- **Acceptance test:** payment tests showing the fee passed to the provider, and 0 by default.
- **Depends on:** W4.1.

## W5. "Send us your spreadsheet" onboarding

### W5.1 Import: several sheets and saved mappings

- **Scope:** Import reads every sheet of an XLSX file and lets the user choose; column mappings are saved per organization and offered on the next import.
- **Files likely touched:** `apps/api/src/lib/import-parse.ts`, `apps/api/src/routes/imports.ts`, `packages/domain/src/imports.ts`, new migration (saved mappings), `apps/web/app/(office)/import/`.
- **Acceptance test:** domain and API tests with a synthetic multi-sheet workbook; saved mapping isolation test; import e2e still passes.
- **Depends on:** W2.1 (organizations created outside the seed).

### W5.2 Import: contracts, last inspection, permits, make and model

- **Scope:** New columns: contract start and end dates, last inspection date, permit number, system make and model. Imported contracts and last inspections create the right next visits, so renewals and overdue visits show up immediately.
- **Files likely touched:** `packages/domain/src/imports.ts`, `apps/api/src/routes/imports.ts`, `apps/api/src/lib/contracts.ts`, `apps/web/app/(office)/import/`.
- **Acceptance test:** tests that an imported contract ending in 20 days shows in renewals and a last inspection 5 months ago shows as overdue.
- **Depends on:** W5.1.

### W5.3 Undo a committed import

- **Scope:** Undo by `import_id`, removing everything that import created, only while no work has been done on those records; otherwise list exactly what blocks it. Audited.
- **Files likely touched:** `apps/api/src/routes/imports.ts`, new migration if import provenance needs more columns, `apps/web/app/(office)/import/[id]/`.
- **Acceptance test:** API tests for a clean undo and for each blocker (a job, an inspection, an invoice, a filing).
- **Depends on:** W5.2.

### W5.4 Onboarding summary

- **Scope:** After import: active contracts, contracts expiring in 30/60/90 days, inspections overdue or due this month, sites with no authority assigned, missing permit numbers. This screen is the demo.
- **Files likely touched:** `packages/domain/src/`, `apps/api/src/routes/imports.ts` or a new route, `apps/web/app/(office)/import/[id]/`.
- **Acceptance test:** the brief's test: a messy synthetic 500-row spreadsheet (generated in the test, no real data) imports and the summary shows correct counts.
- **Depends on:** W5.2.

### W5.5 Full data export

- **Scope:** Owner downloads a zip of CSVs (customers, sites, systems, contracts, visits, inspections, invoices) plus all PDFs, built by a worker task, at any time, including in read-only.
- **Files likely touched:** new route, `apps/worker/src/index.ts`, `packages/tasks/src/`, `apps/web/app/(office)/settings/`.
- **Acceptance test:** API test that the zip contains each table's rows for this organization only, and that it works for a read-only organization once W4.1 lands.
- **Depends on:** W2.1.

### W5.6 Organization data deletion and data-handling page

- **Scope:** A platform admin deletes an organization's data on request, with a confirmation step and an audit record kept outside the deleted data. A short public data-handling statement page (placeholder text until Justin supplies it).
- **Files likely touched:** `apps/api/src/routes/admin.ts`, `apps/web/app/admin/`, new public page under `apps/web/app/`.
- **Acceptance test:** API test that deletion removes every tenant table's rows for that organization (checked against the full table list) and leaves others untouched.
- **Depends on:** W2.1, W5.5 (offer an export first).
- **Needs from Justin:** data-handling statement text.

## W6. Jurisdiction engine and county expansion

### W6.1 Per-ruleset service intervals

- **Scope:** A ruleset sets the service interval: 4 months by default, quarterly, or monthly for commercial systems. Contract visit schedules follow the site's ruleset. Published versions stay immutable; existing rulesets keep their behavior.
- **Files likely touched:** `packages/compliance/src/rulesets.ts`, ruleset JSON schema, `packages/domain/src/contracts.ts`, `apps/api/src/lib/contracts.ts`, `docs/product/COMPLIANCE-ENGINE.md`.
- **Acceptance test:** fixture tests for each interval, including a commercial site under a monthly rule; existing schedule tests unchanged.
- **Depends on:** nothing.

### W6.2 Annual lab tests

- **Scope:** A ruleset can require annual lab tests (BOD/TSS) as required tests: a due date, a place to record results and the lab, and an inbox item when one is late.
- **Files likely touched:** `packages/compliance/src/`, new migration (lab tests, tenant-scoped), `packages/domain/src/inspections.ts`, `apps/api/src/routes/`, `packages/domain/src/inbox.ts`.
- **Acceptance test:** fixture and API tests for due, recorded and late lab tests; isolation test.
- **Depends on:** W6.1.

### W6.3 Six-month schedule with electronic monitoring

- **Scope:** Record qualifying electronic monitoring (autodialer) on a system; allow a 6-month interval only where the ruleset permits it and monitoring is recorded.
- **Files likely touched:** migration (system monitoring), `packages/compliance/src/rulesets.ts`, `packages/domain/src/contracts.ts`, site screen.
- **Acceptance test:** tests that 6 months is refused without monitoring or without ruleset permission.
- **Depends on:** W6.1.

### W6.4 Per-authority report templates and fees

- **Scope:** A ruleset can define its report's field list and layout, and its filing and late fees; fees are recorded on the filing.
- **Files likely touched:** `packages/compliance/src/reports.ts`, `packages/reports/src/`, `packages/compliance/src/filings.ts`, migration (fees on filings).
- **Acceptance test:** fixture tests for a template-driven report and a late fee applied after the deadline.
- **Depends on:** W6.1.

### W6.5 Ruleset verification workflow and badge

- **Scope:** A ruleset moves from draft to verified only when a person records who confirmed it with the authority and when. Sites, filings and the coverage page show "Verified with <authority> on <date>". Verification never loosens the send guards for drafts.
- **Files likely touched:** migration (verification records), `packages/compliance/src/rulesets.ts`, `apps/api/src/routes/filings.ts`, site and filing screens.
- **Acceptance test:** tests that verification requires the confirmation fields, that drafts still never auto-send, and that the badge appears only for verified rulesets.
- **Depends on:** nothing.

### W6.6 Ruleset coverage page

- **Scope:** `/admin` page listing every authority: status, sources date, open questions (`profile.unresolved`), and how many sites use it.
- **Files likely touched:** `apps/api/src/routes/admin.ts`, `apps/web/app/admin/`.
- **Acceptance test:** API test of the counts across two organizations.
- **Depends on:** W2.1, W6.5.

### W6.C County rulesets, one authority per PR

Each follows the brief's research protocol: `packages/compliance/rulesets/<key>/v1.json` with `profile.status: "draft"`, every source with URL and read date, unknowns in `profile.unresolved`, `docs/jurisdictions/<key>.md` from TEMPLATE.md with Justin's questions at the top, and fixture tests (valid inspection, missing field, deadline calculation). A county whose sources cannot be read says so in the profile. Acceptance for the stream: adding a county needs no engine code change. Depends on W6.1 and W6.2.

Priority 1 is whatever the first design partner works in; it jumps the queue when Justin names it.

| ID | Authority | Priority | Status |
| --- | --- | --- | --- |
| W6.C1 | Williamson County | 2 | not started |
| W6.C2 | Travis County | 2 | not started |
| W6.C3 | Hays County | 2 | not started |
| W6.C4 | Comal County | 2 | not started |
| W6.C5 | Bexar County | 2 | not started |
| W6.C6 | Johnson County | 3 | not started |
| W6.C7 | Ellis County | 3 | not started |
| W6.C8 | Collin County | 3 | not started |
| W6.C9 | Denton County (and the City of Denton) | 3 | not started |
| W6.C10 | Kaufman County | 3 | not started |
| W6.C11 | Bell County | 4 | not started |
| W6.C12 | McLennan County | 4 | not started |
| W6.C13 | Hill County | 4 | not started |
| W6.C14 | Bastrop County | 4 | not started |
| W6.C15 | Montgomery County | 5 | not started |
| W6.C16 | Harris County v2 (quarterly residential, monthly commercial, annual tests) | 5 | blocked: needs the submission channel confirmed |
| W6.C17 | Grimes County | 5 | not started |
| W6.C18 | Brazoria County | 5 | not started |
| W6.C19 | LCRA (finish verification) | 5 | blocked: needs LCRA to confirm the emailed cover sheet |
| W6.C20 | San Jacinto River Authority | 5 | not started |

## W7. Integrations to live readiness

### W7.1 Stripe Connect live readiness

- **Scope:** Run Connect end to end on staging with test cards in Stripe's test mode, fix what breaks, then document switching to production keys. Starts `docs/engineering/INTEGRATIONS.md`.
- **Files likely touched:** `packages/payments/src/`, `docs/engineering/INTEGRATIONS.md`, `docs/engineering/QUICKBOOKS-STRIPE.md`.
- **Acceptance test:** a recorded staging run (onboarding, card and ACH payment, refund, webhook) in the PR; any fixes ship with tests.
- **Depends on:** W1.3.
- **Needs from Justin:** Stripe account with Connect.

### W7.2 QuickBooks against an Intuit sandbox

- **Scope:** Run the sync against an Intuit sandbox company, fix what breaks, document the Intuit app review steps.
- **Files likely touched:** `packages/quickbooks/src/`, `docs/engineering/INTEGRATIONS.md`.
- **Acceptance test:** a recorded sandbox sync in the PR; fixes ship with tests.
- **Depends on:** W1.3.
- **Needs from Justin:** Intuit developer app.

### W7.3 Twilio on a real account

- **Scope:** Run texting against a real Twilio account, document A2P 10DLC registration.
- **Files likely touched:** `packages/sms/src/`, `docs/engineering/INTEGRATIONS.md`.
- **Acceptance test:** a recorded send, delivery receipt and STOP in the PR; fixes ship with tests.
- **Depends on:** W1.3.
- **Needs from Justin:** Twilio account and A2P 10DLC registration (can take weeks; start early).

## W8. Marketing site and demo request

### W8.1 Public marketing page

- **Scope:** One public page: the problem, how it works, county coverage (read from the rulesets, with verified ones marked), pricing ("free for 90 days for design partners").
- **Files likely touched:** `apps/web/app/page.tsx` or a new public route group, `apps/web/components/`.
- **Acceptance test:** an e2e check that the page renders signed out and the coverage list matches the rulesets; screenshots in the PR.
- **Depends on:** W6.5 (for the verified marks).

### W8.2 Demo request form

- **Scope:** A public form that lands in the `/admin` console and emails Justin; rate-limited, with basic spam protection.
- **Files likely touched:** new public route, new migration (demo requests, platform-level), `apps/web/app/admin/`.
- **Acceptance test:** API tests for submission, rate limit, and the email in the outbox.
- **Depends on:** W2.1, W8.1.
- **Needs from Justin:** the address to notify.

### W8.3 Terms and privacy with recorded acceptance

- **Scope:** Privacy policy and terms pages with placeholder text until Justin supplies lawyer-reviewed text. Each owner's acceptance is recorded with a timestamp and the document version; a new version asks again.
- **Files likely touched:** new public pages, new migration (acceptances), `apps/api/src/routes/auth.ts` or the invite accept flow.
- **Acceptance test:** API tests that acceptance is recorded with version and time, and that a new version asks again.
- **Depends on:** W2.1.
- **Needs from Justin:** terms of service and privacy policy text.

## W9. Later

Not started until a paying customer asks: autopay and saved payment methods, organization switcher, technician-app signing for MPs, two-way QuickBooks sync, IoT/alarm monitoring, other states.
