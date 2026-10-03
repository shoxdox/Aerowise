# ARCHITECTURE.md

## Recommended stack

### Monorepo
- TypeScript
- pnpm
- Turborepo

### Web
- Next.js
- React
- responsive office/admin UI

### Technician app
Start as PWA:
- service worker
- IndexedDB
- camera
- geolocation
- offline queue
- local drafts

Move to Expo/React Native only if browser/PWA limitations materially hurt technicians.

### API
- TypeScript service
- REST + OpenAPI
- typed client
- background workers

### Database
- PostgreSQL
- explicit migrations
- strong tenant constraints

### Queue
Used for:
- PDF generation
- email
- SMS
- filing
- retries
- renewals
- QuickBooks sync
- import processing

### Storage
S3-compatible object storage:
- signed upload/download URLs
- immutable filed artifacts
- retention policy

### Observability
- structured logs
- request IDs
- job IDs
- filing attempt logs
- error monitoring
- audit trail

## Suggested packages

- `apps/web`
- `apps/api`
- `apps/worker`
- `packages/db`
- `packages/domain`
- `packages/compliance`
- `packages/jurisdictions`
- `packages/reports`
- `packages/integrations`
- `packages/ui`
- `packages/offline-sync`

## Security

- deny by default
- all authorization server-side
- tenant ID validation
- integration tokens encrypted
- webhook signatures
- idempotency keys
- rate limiting
- no tokens in browser-readable records
- no public schema/debug endpoints in production
- cross-tenant tests mandatory
