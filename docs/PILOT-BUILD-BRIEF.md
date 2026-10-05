# Aerowise — Pilot Build Brief

Oct 5, 2026 · @Justin

> Committed from Justin's Oct 5, 2026 export. Text is unchanged; tables and lists were rebuilt as Markdown. The export did not keep bold, so the "pilot blockers in bold" marking in the gap table and the source links (TCEQ, Bexar County, Williamson, Hays, SJRA, Denton) are not reproduced.

## How to use this doc

This is the single source of direction for taking Aerowise from a local, demo-only codebase to a product a real Texas maintenance company can pilot. It is written for two readers: Justin (founder), and the Claude coding agents working in the Aerowise repo.

- Agents: read every section before starting. Work the workstreams in the order given; each one lists tasks and acceptance criteria. One workstream (or one clearly scoped slice of one) per thread and per PR.
- Justin: the section "Human-only tasks" lists what only you can do (accounts, keys, calls to counties, legal). Agents will hit those as blockers; they should stub behind the existing test providers and keep going, not wait.
- The kickoff prompt is the last section. Paste it into the Claude project together with this doc (export as Markdown, or commit it to the repo as docs/PILOT-BUILD-BRIEF.md).

Out of scope here: outbound sales and prospect outreach. Justin runs that separately.

## What Aerowise is and the goal

**The goal:** get 3–5 Texas aerobic maintenance companies running real operations on Aerowise as design partners, then convert them to paying customers.

**The problem.** Texas requires every aerobic septic system to be under a maintenance contract. The licensed maintenance provider inspects it at least every four months and reports to the permitting authority and the owner within 14 days of the test (TCEQ). The permitting authority can be a county, a city or a river authority, and each runs its own forms, submission channel, deadlines, fees and renewal rules. Bexar County, for example, describes "quarterly maintenance reports" to a "Designated Representative" (Bexar County).

**The product.** An operating system for aerobic maintenance companies: customers, sites, contracts, recurring inspections, an offline technician app, county reporting with proof of filing, renewals, invoicing and payments, QuickBooks and a customer portal. The office sees only exceptions.

**The moat.** A library of verified, versioned jurisdiction rulesets. Generic field-service tools (ServiceTitan, Housecall Pro, Jobber) do not know county rules. Each county added makes Aerowise harder to copy.

**Target customer.** A Texas maintenance provider with roughly 200–2,500 active contracts and 1–15 technicians, statewide. Not limited to San Antonio: the prospect list (from the TOWA maintenance-provider directory) clusters in Montgomery, Johnson, Ellis, Williamson, Harris, Hill, Bell, Kaufman, Grimes, McLennan, Collin, Bastrop, Comal, Travis and Denton counties.

**Main competitor: FieldBase OS.** From a call with its owner and developer on 2026-10-05: about 50 provider customers and about 160 technicians, mostly small crews (largest about 15 techs). Native offline app, e-signatures, Stripe Connect, QuickBooks Online and renewals. County-specific plans for about 20 authorities, mostly East and Southeast Texas plus LCRA and the cities of Ennis and Red Oak. Reports are generated as PDFs and emailed; no direct portal filing; formal county acceptance unknown. Sells only to providers. Other incumbents: ServiceTitan, and "SAFE" (named in PRODUCT-SPEC.md).

**Positioning that follows.** Feature parity is table stakes, not the pitch. Aerowise wins on four things, and agents should build toward them:

1. County rules verified with the authority, and shown to the provider as such
2. A real rules engine (deadlines, versions, signature and license checks), not per-county plan templates
3. Fastest switching: free import and an onboarding summary within a day
4. Coverage first where FieldBase is absent

## Where the repo stands (verified 2026-10-05)

The core product is built and green; what is missing is everything needed to run it for a real company on the internet. Checked on a fresh install against Postgres 16: pnpm typecheck and pnpm lint pass, and all ~315 tests pass (api 228, domain 59, routing 14, quickbooks 10, sms 4). About 39,000 lines of TypeScript and SQL across apps/ (api, web, worker) and packages/.

**Built and tested (with built-in test stand-ins for outside services):**

- Tenancy, sign-in, sessions, four roles, tenant isolation, append-only audit log
- Customers, contacts, sites, wastewater systems; CSV/XLSX import with preview and duplicate flags
- Plans, contracts, renewals, recurring visits, due list, scheduling, technician route
- Offline technician PWA with exactly-once sync, photos, inspection templates
- Immutable customer and authority PDFs; exception inbox as the office home screen
- Compliance engine: versioned jurisdiction rulesets, filing state machine, immutable submission packages, licensed-MP signature (30 TAC 285.7(b)(3)), contract deadlines by kind, discontinuation notices, complaint handling, corrected versions
- Invoices, manual payments, refunds; Stripe Connect card/ACH (test provider by default)
- QuickBooks Online one-way sync with first-sync review and conflict center (test company by default)
- Twilio texts with consent, STOP/START, quiet hours (test provider by default)
- Renewal campaigns with e-sign and pay; customer portal by magic link; geocoding and route estimates

**Missing or stubbed (pilot blockers in bold):**

| Gap | Today | Needed |
| --- | --- | --- |
| Company signup and user management | Organizations and users exist only via the seed script; auth routes are /auth/login, /auth/logout, /auth/me | Founder-run org creation, user invites, password reset, user deactivation |
| Hosting | Local Docker Compose only | A deployed staging (demo) and production environment |
| Real email | Filing and invoice emails written as .eml files to an outbox | Mail provider behind EmailTransport, with idempotency and bounce handling |
| File storage | LocalDiskStore on the server's disk | S3-compatible store (Cloudflare R2) behind ObjectStore |
| Charging companies for Aerowise | Nothing; Stripe Connect only covers homeowners paying the provider | Subscription billing, trials, per-contract pricing, optional platform fee |
| Counties near prospects | Draft rulesets for LCRA and Harris (contracts only); fictional tx-example-county | Verified rulesets for the counties the first design partners work in |
| Authority acceptance | Typed signature and emailed LCRA cover sheet unconfirmed | Confirmation from each authority (human task) |
| Import undo | Committed import cannot be undone from the UI | Undo by import_id |
| Six-month schedule | Not modeled (autodialer / electronic monitoring) | Record monitoring on the system; allow 6-month interval where the ruleset permits |
| Autopay, saved cards | Not built | Later (after first paying customer) |
| Organization switcher | API only | Later |
| IoT monitoring | Not built (P2 in PARITY-MATRIX.md) | Out of scope for the pilot |

## Ground rules for every agent

These rules protect the two things that matter most: homeowner data and the provider's legal standing with the county.

1. Read first. README.md, PRODUCT-SPEC.md, CODEX.md, docs/DECISIONS.md, docs/product/PILOT-FILING-READINESS.md and the docs for the area you touch. Follow existing patterns (Fastify routes declare a permission, Kysely, Zod schemas in packages/domain, tasks in the Postgres queue).
2. Keep it green. Every PR passes pnpm lint, pnpm typecheck, pnpm test, pnpm build, and the e2e suite when web flows change. New behavior ships with tests. Never weaken or delete a test to make it pass.
3. Never auto-file. Draft ruleset profiles never send to an authority without a person pressing Send. Do not loosen the guards in submitFiling or the signature rules in packages/compliance/src/signatures.ts.
4. Never invent county rules. A ruleset field is written only from a source someone actually read, with the URL and date in profile.sources. Unknown = null or "unknown" plus an entry in profile.unresolved. Published ruleset versions are immutable; changes go in a new version.
5. Synthetic data only in seeds, tests and fixtures. No real customer, homeowner or provider data in the repo, ever.
6. Secrets stay out of git. New config goes in .env.example with a comment. Production refuses to start when a required secret is missing; development falls back to the built-in test provider.
7. Tenant isolation is non-negotiable. Every new table carries organization_id with composite foreign keys, and every query is scoped. Add an isolation test for new data.
8. Migrations are forward-only and numbered (packages/db/migrations/00NN_*.sql). Never edit a merged migration.
9. Small PRs. One workstream slice per PR, with a description listing what changed, how it was tested, and any open question for Justin.
10. Log decisions. Any choice the spec leaves open goes in docs/DECISIONS.md with the reason.
11. Blocked on a human task (keys, accounts, county answers)? Build behind the existing provider interface with the test stand-in, note it in the PR, and move on.

## Business model the code must support

Aerowise charges maintenance companies a subscription priced per active contract, after a free start. Prices below are starting assumptions, so every number must be configurable, not hard-coded.

| Stage | Who | Terms |
| --- | --- | --- |
| Design partner | First 3–5 companies | Free for 90 days. Justin imports their data and configures their counties. Then a locked "founder" price for life. |
| Free trial | Everyone after | 30 days, full product, free import. Converts to paid or goes read-only (data kept, export always allowed). |
| Paid | Converted accounts | About $1–2 per active contract per month, monthly minimum around $99 (assumption, to be tested). |
| Optional platform fee | Any paying account | Small application fee on homeowner payments through Stripe Connect, configurable per organization, default 0. |
| Onboarding fee | Large or messy migrations, later | One-time, invoiced manually. Not built now. |

**Billing rules for the code:**

- An "active contract" is a contract in force on the billing date (status active, including "Ending"). Count it per organization per billing period and store the count used for each invoice.
- Each organization has a plan state: design_partner, trial, active, past_due, read_only, with start and end dates and a price override (founder price).
- Lapsed accounts are never locked out of their data: read-only access and full export stay available. Compliance-critical views (due inspections, filings, deadlines) stay visible so a lapse never causes a missed county deadline.
- Two separate Stripe relationships: Stripe Billing for Aerowise charging the company (new), and Stripe Connect for the company charging homeowners (exists). Do not mix them.

## Workstreams, in priority order

Work W1–W5 first: together they turn Aerowise into something Justin can demo by link and onboard a real company onto. W6 runs in parallel from day one. W7–W9 follow.

### W1. Hosted demo and staging

A public demo link with fictional seed data, so Justin can screen-share a real product during outreach.

- Pick a host that runs the existing Dockerfile (api, web, worker) plus managed Postgres 16. Candidates: Render, Railway, Fly.io. Record the choice and monthly cost in DECISIONS.md.
- Two environments: staging (demo, reseeded nightly, test providers on) and production (real data, test providers off).
- Infrastructure as code or a documented one-command deploy; deploy from main via CI after checks pass.
- HTTPS on a custom domain (placeholder until Justin buys one), health checks for api and worker, automatic migrations on deploy.
- Demo banner in staging: "Demo data. Nothing is sent."

**Done when:** a fresh visitor can open the staging URL, sign in as the demo owner, office or tech user, and walk every flow in the README without anything leaving the system.

### W2. Company onboarding and user management

Today organizations exist only through the seed script. Build the path for a real company.

- Founder admin console (/admin, platform-admin role separate from tenant roles): create an organization, set its plan state and price override, invite its first owner, see usage (active contracts, users, last activity), impersonate read-only for support with an audit event.
- Invites: owner and office can invite users by email with a role; the invite link sets a password; expiring, single-use tokens.
- Password reset by email; deactivate user (sessions revoked immediately).
- Organization settings: company name, TCEQ MP license, address, phone, logo for PDFs, service counties.
- First-run checklist for a new organization: company details, responsible MP, technicians and their credentials, service counties, import customers, connect Stripe, connect QuickBooks (optional).
- Optional later: self-serve signup that lands an organization in trial. Build the console first.

**Done when:** Justin can create a company from /admin, its owner accepts an invite, invites a technician, and the technician signs into /tech. All covered by API tests and one e2e test.

### W3. Production plumbing

- Email: implement EmailTransport with a real provider (Resend or Postmark; record the choice). Idempotency keys; reconcile uncertain sends before any retry past the provider's idempotency window (see PILOT-FILING-READINESS.md item 5). Bounce and complaint webhooks recorded on the delivery. Verified sending domain.
- Storage: implement ObjectStore for Cloudflare R2 (S3 API). Private bucket, signed URLs only, keys prefixed by organization id, a migration script from local disk.
- Secrets: production refuses to boot when a required secret is missing (FILE_SIGNING_SECRET, QUICKBOOKS_TOKEN_KEY, mail and storage keys).
- Backups: daily Postgres backups with a tested restore procedure documented in docs/engineering/RUNBOOK.md.
- Observability: structured logs, error tracking (for example Sentry), an uptime check, an alert when the worker queue stalls or a filing task fails repeatedly.
- Hardening: rate limits on login, password reset and magic-link requests; security headers; session cookie flags; dependency audit in CI.

**Done when:** a filing email and an invoice email really arrive in a test inbox from staging, a photo round-trips through R2, and a restore from backup has been run once and written down.

### W4. Aerowise billing (charging the companies)

Implement the business model section above.

- Plan state per organization (design_partner, trial, active, past_due, read_only), dates and price override, editable in /admin.
- Monthly active-contract count job; Stripe Billing customer per organization with usage-based price (per contract) and minimum. The count used is stored with each invoice.
- Owner-only Billing page: plan, trial days left, this month's estimated bill, payment method, invoices.
- Trial and design-partner expiry: reminders by email at 14, 7 and 1 days; then read_only if unpaid (rules in the business model section).
- Configurable Stripe Connect application fee per organization (default 0).
- A test Stripe Billing stand-in like the existing payments test provider.

**Done when:** an organization goes trial → active → past_due → read_only and back in tests, with the correct per-contract amount, and a read-only organization can still see due inspections and export everything.

### W5. "Send us your spreadsheet" onboarding

The sales hook is: import a prospect's real customer list and show their book in Aerowise within a day. Make that fast and safe.

- Import improvements: multiple sheets, saved column mappings per organization, contract and last-inspection columns, permit numbers, system make/model, and import of contract end dates so renewals and overdue visits appear immediately.
- Undo a committed import by import_id (only while no work has been done on those records, otherwise explain what blocks it).
- An onboarding summary after import: active contracts, contracts expiring in 30/60/90 days, inspections overdue or due this month, sites with no authority assigned, missing permit numbers. This screen is the demo.
- Full data export (CSV zip of customers, sites, systems, contracts, visits, inspections, invoices; plus all PDFs) available to the owner at any time.
- Data-handling basics: data deletion of an organization on request (with audit), and a short data-handling statement page.

**Done when:** a messy synthetic spreadsheet of 500 rows imports in under 5 minutes of human effort and the onboarding summary shows correct counts, tested.

### W6. Jurisdiction engine and county expansion

Runs in parallel from day one; see the next section for the research protocol and the county list.

- Engine: per-ruleset service intervals (quarterly, monthly for commercial, 4-month default), annual lab tests (BOD/TSS) as required tests, and the 6-month schedule where the system records qualifying electronic monitoring.
- Per-authority report templates (field list and layout) and per-authority filing fees and late fees recorded on the filing.
- Ruleset status workflow: draft → verified only after a human records who confirmed it with the authority and when. Show providers a "Verified with <authority> on <date>" badge on sites, filings and the coverage page; this is the headline differentiator.
- A ruleset coverage page in /admin: every authority, status, sources date, open questions, and how many sites use it.
- Harris County v2 profile (quarterly residential, monthly commercial, annual tests) once the submission channel is confirmed.

**Done when:** adding a new county is a JSON ruleset plus a markdown profile plus fixture tests, with no engine code change.

### W7. Integrations to live readiness

The code exists; this is configuration, real-account test runs, and documentation.

- Stripe Connect in live mode end to end on staging with test cards, then production keys.
- QuickBooks: run the sync against an Intuit sandbox company; fix what breaks; document the Intuit app review steps.
- Twilio: run against a real account; document A2P 10DLC registration.
- A setup guide per integration in docs/engineering/INTEGRATIONS.md.

### W8. Marketing site and demo request

- A one-page public site: problem, how it works, county coverage, pricing ("free for 90 days for design partners"), a demo request form that lands in the admin console and emails Justin.
- Privacy policy and terms of service pages (text supplied by Justin after legal review); record each owner's acceptance with timestamp.

### W9. Later (do not start before a paying customer asks)

Autopay and saved payment methods, organization switcher, technician-app signing for MPs, two-way QuickBooks sync, IoT/alarm monitoring, other states.

## County ruleset expansion

Agents draft rulesets from public sources; only Justin, after confirming with the authority, marks one verified. Coverage is statewide, prioritized by where prospects operate and where design partners sign.

**Research protocol, one authority per PR:**

1. Identify the permitting authority. It may be a county, a city (for example Denton, Flower Mound) or a river authority (LCRA, San Jacinto River Authority). One county can contain several, so record the boundary rule and whether assignment must be reviewed.
2. Read the authority's OSSF pages and forms. Capture: service frequency, report deadline (state default is 14 days after the test; some differ, for example Williamson's 10 days), submission channel (email address, portal such as MGO Connect or eTRAKiT, mail), required form or fields, required tests, contract filing rules and renewal timing, filing and late fees, homeowner self-maintenance rules, acknowledgment process.
3. Write packages/compliance/rulesets/<key>/v1.json with profile.status: "draft", every source with URL and read date, and every unknown in profile.unresolved. Add docs/jurisdictions/<key>.md from TEMPLATE.md and fixture tests (valid inspection, missing field, deadline calculation).
4. If a site cannot be read (403, robots.txt, PDF only), say so in the profile, as the Brazoria doc does. Never fill gaps from memory or third-party summaries.
5. List the questions Justin must ask the authority by phone or email at the top of the markdown profile.

**Questions for every authority (Justin asks; answers go into the profile):**

- How do you want maintenance reports and contracts submitted, and to whom?
- Do you accept a PDF with a typed signature by the licensed maintenance provider, plus an audit trail?
- What is your deadline after the inspection, and are there filing or late fees?
- Do you confirm receipt? If so, how?

**Priority list (drafting order):**

| Priority | Authorities | Why |
| --- | --- | --- |
| 1 | Whatever the first design partner works in | Pilot blocker; overrides the rest of this list |
| 2 | Williamson, Travis, Hays, Comal, Bexar | San Antonio–Austin corridor, 11–14 prospects each, no FieldBase coverage named; Williamson, Hays and Comal have known public forms and portals |
| 3 | Johnson, Ellis, Collin, Denton, Kaufman | DFW ring, 11–18 prospects each, no FieldBase coverage named (FieldBase has only the cities of Ennis and Red Oak) |
| 4 | Bell, McLennan, Hill, Bastrop | 11–14 prospects each, no FieldBase coverage named |
| 5 | Montgomery, Harris (v2), Grimes, Brazoria, LCRA (finish verification), SJRA | Many prospects, but FieldBase already covers them; existing drafts or known recipients |

County counts come from Justin's prospect list built from the TOWA maintenance-provider directory on 2026-10-04. Known source pages: Williamson County affidavit, Williamson homeowner packet, Hays County OSSF FAQ, SJRA, City of Denton, Bexar County.

## Human-only tasks for Justin

Agents cannot do these; each one unblocks a workstream. Expected running cost to start is under about $50 a month.

### Accounts and keys

- [ ] Buy a domain (about $12/yr) and set up a business email on it (unblocks W1, W3)
- [ ] Hosting account on the host chosen in W1 (about $10–40/mo to start)
- [ ] Cloudflare account with an R2 bucket and API token (free up to 10 GB, about $0.015/GB-month after, no download fees) (W3)
- [ ] Email provider account (Resend or Postmark) and DNS records for the sending domain (W3)
- [ ] Stripe account: Connect enabled for homeowner payments, Billing for Aerowise subscriptions (W4, W7)
- [ ] Intuit developer app for QuickBooks (W7)
- [ ] Twilio account and A2P 10DLC registration, which can take days to weeks (W7)
- [ ] Error tracking account, for example Sentry (W3)

### Business and legal

- [ ] Form an LLC and open a business bank account before taking money
- [ ] Terms of service and privacy policy, reviewed by a lawyer. Key point: the licensed provider reviews and is responsible for every filing; Aerowise prepares and tracks (W8)
- [ ] A one-page data-handling agreement for design partners (their homeowner data is used only for them, encrypted, deleted on exit)
- [ ] Later: errors-and-omissions insurance

### Counties and customers

- [ ] Ask each priority authority the four questions in the county section; paste answers into the ruleset PR (W6)
- [ ] Confirm with LCRA that an electronically filled, flattened cover sheet sent by email is accepted
- [ ] Outreach to prospects with the free-import offer; send agents each design partner's counties as soon as they sign
- [ ] Collect, with permission, one real (anonymized) inspection form, county report and customer export from each design partner

## Pilot-ready: definition of done

Aerowise is pilot-ready when a design partner can run one full week of maintenance operations on it without returning to spreadsheets, on production, with real email and storage.

- [ ] Justin creates the company in /admin; the owner accepts an invite and invites office staff and technicians
- [ ] The company's real customer spreadsheet imports, and the onboarding summary shows correct counts
- [ ] Rulesets exist for every authority the company works in (draft is acceptable for the pilot, with every filing sent by a person)
- [ ] Technicians complete inspections offline on their phones; photos land in R2
- [ ] Authority reports are signed by the licensed MP and filed by email (real delivery) or by hand, with proof recorded
- [ ] Customer copies reach homeowners by email and the portal
- [ ] Renewals and invoices go out; at least one homeowner pays through Stripe Connect
- [ ] The company is on a design_partner plan with an end date, and Billing shows what they will pay after
- [ ] Backups, error tracking and uptime alerts are on; the restore runbook has been tested
- [ ] All checks green in CI, including e2e

## Kickoff prompt

Paste this into the Claude project, with this doc attached or committed to the repo.

```text
You are the lead engineer on Aerowise, an operating system for Texas aerobic septic maintenance companies. The repo is connected. The attached "Aerowise — Pilot Build Brief" is your direction; treat it as the source of truth alongside README.md, PRODUCT-SPEC.md, CODEX.md and docs/.

Goal: make Aerowise pilot-ready for 3–5 real design-partner companies, as defined in the brief's "Pilot-ready: definition of done".

Step 1 (one small PR, first): commit the brief to docs/PILOT-BUILD-BRIEF.md and add docs/engineering/ROADMAP.md that breaks workstreams W1–W8 into PR-sized tasks (each: title, scope, files likely touched, acceptance test, dependencies). Do not change application code in this PR.

Step 2: start worker threads, one per task, in this order and parallelism:
- In parallel right away: W1 (hosted demo/staging), W2 (founder admin console, invites, password reset), W3 (email transport, R2 storage, secrets, backups, observability), W6 (engine: per-ruleset intervals and annual tests; then one county ruleset per PR from the priority list).
- After W2's org/user model lands: W4 (Aerowise billing with Stripe Billing, plan states, per-contract usage) and W5 (import improvements, undo, onboarding summary, full export).
- Then W7 (integrations to live readiness) and W8 (marketing page, demo request, terms acceptance).
- Do not start W9.

Rules (from the brief, non-negotiable): keep lint, typecheck, tests, build and e2e green; never weaken tests; never let a draft ruleset auto-send; never invent county rules, cite every source with URL and read date and record unknowns in profile.unresolved; synthetic data only; secrets only via env with .env.example updated; every new table tenant-scoped with an isolation test; forward-only migrations; log open choices in docs/DECISIONS.md.

When a task needs something only Justin can provide (accounts, API keys, a domain, answers from a county, legal text), build it behind the existing provider interface with a test stand-in, list exactly what is needed in the PR description under "Needs from Justin", and continue with other work.

Each PR description: what changed, how it was tested, screenshots for UI, "Needs from Justin", open questions. Keep PRs small enough to review in 15 minutes.

At the end of each working session, update docs/engineering/ROADMAP.md with status (done, in progress, blocked and why) so Justin can see progress at a glance.
```
