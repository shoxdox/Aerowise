# Decisions

Choices made where the spec was silent or ambiguous. Newest at the bottom.

## 2026-10-03 · Foundation, tenancy and CRM

- **API framework: Fastify + Zod.** Request and response schemas live in `packages/domain` as Zod objects; the API validates with them and publishes OpenAPI from them (`/openapi.json`, dev only). The web app imports the same types, so there is one source of truth instead of a generated client.
- **Database access: Kysely over `pg`, plain SQL migrations.** Migrations are numbered `.sql` files in `packages/db/migrations`, applied in order by a ~50-line runner that records them in `schema_migrations`. Applied files are never edited. The API applies pending migrations on startup.
- **Tenant isolation is enforced twice.** Every query is scoped by the session's `organization_id`, and child tables reference parents through composite `(organization_id, parent_id)` foreign keys, so the database rejects a row whose parent belongs to another organization. Postgres row-level security was considered and deferred: it needs a separate non-owner database role, which complicates local setup; revisit before production.
- **Other organizations' records return 404, not 403**, so ids cannot be probed across tenants.
- **Auth: email + password, server-side sessions.** Passwords are hashed with scrypt (`node:crypto`, no native modules). The session token is a random 256-bit value in an `httpOnly`, `SameSite=Lax` cookie (Secure in production); only its SHA-256 hash is stored. Sessions last 30 days so technicians stay signed in on their phones; deactivating a user or membership cuts off existing sessions immediately. Magic links / SSO can come later.
- **One session = one organization.** A user in several organizations picks one at sign-in (`organizationId`, defaulting to their oldest membership). An organization switcher can be added when someone needs it.
- **Deny by default is checked at startup.** Every route must declare `config.permission` (or `config.public`), or the app refuses to register it. Role → permission mapping lives only in `packages/domain/src/roles.ts`. Technicians and read-only users can read CRM records but not change them.
- **CSRF:** `SameSite=Lax` plus a rule that every state-changing request must be `application/json`, which a cross-site form cannot send without a CORS preflight.
- **Sign-in rate limit:** 10 attempts per minute per IP + email.
- **Audit log:** `audit_events` is append-only (a trigger rejects UPDATE/DELETE). Every create/update in the API writes one event with the actor, request id and submitted fields. The per-site compliance ledger (`compliance_events`) is a separate table that arrives with the reports module.
- **Sites, not jurisdictions yet.** `sites.jurisdiction_id` is left out until the compliance module adds the `jurisdictions` table, so there is no dangling column. `sites.county` holds the free-text county for now.
- **Equipment table deferred.** Not needed for the core loop; `wastewater_systems` carries manufacturer/model/serial.
- **Object storage deferred to the reports module.** The `minio/minio` image is no longer published on Docker Hub, so the S3-compatible service will be chosen when photos and PDFs need it.
- **Web app talks to the API through a same-origin `/api` rewrite**, so the session cookie is first-party and no CORS is needed. Pages are client components for now; the technician PWA will be offline-first anyway.
- **TypeScript runs directly via `tsx`** in the API and scripts; internal packages export `.ts` source. A compile step can be added when deploy targets are chosen.

## 2026-10-03 · Plans, contracts and service obligations

- **One obligation row per visit.** A contract materializes a `service_obligations` row for each visit in its term (an annual plan with 3 visits makes 3 rows). Each row is the unit the office schedules, a job is assigned to and an inspection completes. This is simpler to schedule and audit than one rolling row per contract.
- **Visit windows split the term evenly.** A 12-month term with 3 visits gives three 4-month windows; each visit is due on the last day of its window, and is overdue the day after. Plans must divide the term into whole months (12/3, 12/4, 24/6…), enforced in the API and by a database check. Shifting later windows after an early or late inspection is a decision for the inspections module.
- **Visit counts and intervals are provider plan settings, not jurisdiction rules.** No county requirement is assumed here; when the compliance engine arrives, a ruleset can require a minimum visit count and the contract form can warn.
- **Contracts copy their plan's terms** (name, term, visits, price, billing frequency) when created, so editing or retiring a plan never rewrites an existing contract. A negotiated price can override the plan price.
- **Contract state is derived, not stored.** The table stores `active` or `cancelled`; `upcoming` and `expired` come from the start/end dates and the organization's own "today" (its timezone, default America/Chicago). No nightly job has to flip statuses.
- **No overlapping contracts per site.** A Postgres exclusion constraint rejects two non-cancelled contracts on one site whose dates overlap; the API answers 409.
- **Renewal, minimal version.** "Renew" creates the next term starting the day after the old one ends, linked by `previous_contract_id`, with the same terms unless a plan or price is given. The old contract and its visits are untouched. A contract can be renewed once. Campaigns, e-signature and payment stay out of scope; `renewal_status` is the seam for them.
- **Cancelling** keeps the contract with its reason and time, cancels its open visits and keeps completed ones as history.
- **The due-inspections list** shows open visits due on or before a date (default today + 30 days), overdue first. It becomes the left column of the scheduling screen in the next module.

## 2026-10-04 · Jobs and scheduling

- **A job is a visit put on a technician's day.** It has a date and a stop order, not a clock time; providers plan by day and route. A clock-time window can be added if customers need appointments.
- **Unscheduled work is derived:** an open visit with no live job. Cancelling (unscheduling) a job puts its visit back in the list. A partial unique index allows at most one live job per visit.
- **Versioned job state machine** (`packages/domain/src/jobs.ts`): scheduled → in progress → completed, with cancel from scheduled or in progress. Each job stores the version it was created under. This module only uses scheduled and cancelled; the inspection module drives the rest.
- **Who can be assigned:** active members with the technician or owner role, because small providers often have the owner inspecting too. Office and read-only members cannot be put on a route.
- **Stop order is manual** (move up/down, or `POST /schedule/reorder` with the full list). A moved job goes to the end of its new day. Route optimization stays out of scope.
- **The technician route** (`GET /route`) returns only the signed-in user's stops for a day, with what the stop card needs: address and coordinates, gate code, access and scheduling notes, safety flags, permit, customer phone and the system on site. The technician app in the next module reads this.
