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

## 2026-10-04 · Inspections, photos and templates (API)

- **Templates are data with immutable versions.** The built-in "Aerobic maintenance inspection" covers the canonical fields in PRODUCT-SPEC §5.7 and is stored on first use from `packages/domain/src/inspections.ts`. An owner customizes it by saving a new version for their organization; a database trigger rejects edits to a saved version. New inspections use the newest version; each inspection keeps the version it started with.
- **Required and optional choices in the built-in template are a provider default, not a county rule.** The compliance module will add jurisdiction requirements on top. Chlorine level is required only when a chlorinator is present; an aerator marked "fail" requires a photo of the problem.
- **One validation function, shared.** `validateInspection` runs in the phone app before completing and in the API when the completion arrives, so they cannot disagree. A completion that fails validation (for example, photos not uploaded yet) is stored as a draft marked `invalid` with the list of problems, not rejected with an error, so nothing the technician entered is lost.
- **The phone creates the ids.** Inspections, photos and issues carry a client-generated UUID, unique per organization. The phone sends the whole inspection after every change and on every retry (`PUT /inspections/sync`); the same id always means the same record, which is what makes offline replay exactly-once. Photos upload one at a time to `PUT /inspections/:clientId/photos/:photoClientId` as the raw image body, with metadata in headers; a retry returns the stored photo.
- **Completed is final.** Once an inspection is completed, later syncs (a retried completion, or a stale draft arriving late) get the completed record back unchanged, and photos can no longer be added. Corrections after completion are a later feature (an amendment with its own audit trail), so filed reports stay trustworthy. `locked_at` is the seam for locking at filing.
- **Answers to hidden fields are dropped on completion,** for example a chlorine level entered before switching the chlorinator to "not present", so reports never show answers the final form did not ask for.
- **Only the assigned technician records the inspection.** Completing it completes the job and its visit. Office and owner users with `inspections:review` can accept an inspection that failed validation, with a written reason; the override and the problems it overrode go in the audit log.
- **Photos are stored behind an `ObjectStore` interface.** Local disk is the only implementation for now (a Docker volume in Compose); an S3-compatible store can be added behind the same interface for production. Files are never public: the API hands out links that expire after 15 minutes, signed with an HMAC over the organization id, file id and expiry, so a link opens exactly one file in one tenant. `FILE_SIGNING_SECRET` is required in production.
- **Photo uploads are the one exception to the JSON-only rule.** Routes that opt in accept `image/jpeg`, `png`, `webp`, `heic` or `heif` up to 15 MB. `image/*` is not a CORS-safelisted type and the route uses PUT, so a cross-site form still cannot reach it.
- **Issues found on a visit** (repair needed, pump-out, part replacement, callback, estimate, noncompliance) are recorded with the inspection and stay open for the exception inbox to pick up.

## 2026-10-04 · Technician phone app (offline)

- **A web app installed to the home screen, not a native app.** `/tech` is a Progressive Web App: one page with its own phone-first screens (today's route, stop card, inspection form). Technicians land there after signing in. Native apps can come later if the camera or background sync need them.
- **The app itself works offline through a service worker** (`apps/web/public/sw.js`). It keeps the `/tech` page and its scripts cached, loads the page from the network when there is signal and from the cache when there is not. It never handles `/api` requests, so it cannot serve stale data or swallow a write.
- **Data lives in IndexedDB on the phone:** the day's route, the template versions, inspections in progress, photos not yet sent, and an outbox. The route is saved whenever the app opens with signal; a technician should open the app once in the morning.
- **Every change goes through the outbox.** Saving an inspection and queueing its sync happen in one IndexedDB transaction, so a change is never saved without being queued. The outbox is sent oldest first, one item at a time and one browser tab at a time (Web Locks). A sync always sends the newest saved state, so queued edits collapse into one request. Completion is held back until that inspection's photos are uploaded, so the server's validation sees them.
- **Retries are safe because the server is idempotent** (see the inspections API decisions). No signal, a timeout, a server error or an expired session leaves the item queued and retries when the phone comes back online, every 20 seconds while anything is waiting, or when the technician taps "Try now". A request the server refuses (for example, the office unscheduled the job) is set aside and shown as needing attention instead of blocking everything behind it.
- **Photos are shrunk on the phone** to at most 2000 px JPEG before queueing, and deleted from the phone once uploaded.
- **Signing out with unsent changes asks first.** The changes stay on the phone either way.
- **Tested end to end:** `apps/web/e2e/offline-sync.spec.ts` signs in, goes offline, does two inspections with photos, reloads the app offline, comes back online, drops the first response to the completing request (the server records it but the phone never hears back), and checks the server ends up with exactly two inspections, four photos and two completions. It runs in CI against a fresh seeded database.
