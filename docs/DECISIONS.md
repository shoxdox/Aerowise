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
