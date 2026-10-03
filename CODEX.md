# CODEX.md

## Mission

Build a direct, clean-room competitor to existing aerobic septic maintenance operating software.

Read in this order:

1. `PRODUCT-SPEC.md`
2. `PARITY-MATRIX.md`
3. `BUILD-HORIZON.md`
4. `docs/product/DOMAIN-MODEL.md`
5. `docs/product/UX-FLOWS.md`
6. `docs/engineering/ARCHITECTURE.md`
7. `docs/product/COMPLIANCE-ENGINE.md`
8. `docs/engineering/QUICKBOOKS-STRIPE.md`
9. `docs/product/ACCEPTANCE-TESTS.md`

## Product standard

The app must be capable of replacing an incumbent, not merely supplementing it.

Core product areas:
- CRM
- sites/systems
- contracts
- recurring service
- scheduling
- routing
- technician inspections
- compliance reporting
- renewals
- invoicing/payments
- QuickBooks
- customer portal

## Engineering principles

- TypeScript
- PostgreSQL
- explicit migrations
- tenant isolation
- strict server authorization
- OpenAPI/typed API
- background queue
- versioned state machines
- versioned jurisdiction rules
- offline-first field workflow
- immutable filed artifacts
- idempotent webhooks
- structured audit log

## Build order

Do not build the entire product in parallel.

Sequence:

1. tenancy/auth
2. customer/site/system
3. contracts/service obligations
4. jobs/scheduling
5. technician inspection
6. offline/sync
7. reports/compliance ledger
8. jurisdiction adapters
9. renewals/e-sign
10. invoices/payments
11. customer portal
12. imports
13. QuickBooks
14. routing optimization
15. SMS/automation

## Definition of done

A first pilot must be able to:
- import existing customers/sites
- schedule recurring inspections
- assign technicians
- complete inspections offline
- create reports
- track filing status
- renew contracts
- collect payment
- invoice
- provide customer report access
- show compliance exceptions

The product is not "done" merely because CRUD screens exist.
