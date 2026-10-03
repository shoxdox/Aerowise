# QUICKBOOKS-STRIPE.md

## QuickBooks Online

### Objective

Avoid duplicate accounting entry without turning Aerowise into accounting software.

### V1 mappings

Aerowise Customer/Site
-> QBO Customer/Subcustomer mapping

Aerowise Product/Service
-> QBO Item

Aerowise Invoice
-> QBO Invoice

Aerowise Payment
-> QBO Payment

### Required data per syncable entity

- external_id
- sync_status
- last_synced_at
- last_source_modified_at
- sync_error
- mapping/version
- retry_count

### Status

- NOT_CONNECTED
- NEW
- QUEUED
- SYNCING
- SYNCED
- CONFLICT
- FAILED
- IGNORED

### Conflict center

Never silently overwrite.

Examples:
- customer name/address changed in both
- invoice deleted in QBO
- item archived
- tax mapping missing
- payment amount mismatch

### First-sync UX

1. connect OAuth
2. fetch QBO entities
3. match by exact identifiers where possible
4. fuzzy match candidates
5. show uncertain matches
6. user approves
7. commit
8. sync

Do not create dozens of duplicate customers.

---

## Stripe

Use Stripe Connect if provider funds need to settle to provider accounts.

Support:
- card
- ACH
- payment methods
- invoice checkout
- renewal checkout
- autopay later
- refund
- failed payment

Webhook events must be:
- signature validated
- idempotent
- replay safe

Payment status must be independent from invoice status.
