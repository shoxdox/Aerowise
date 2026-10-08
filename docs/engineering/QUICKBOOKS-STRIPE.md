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
- QUARANTINED (an invoice in QuickBooks whose totals differ; see Sales tax)
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

### Sales tax (SW-4)

Per connection, `tax_mode` is `off` (the default) or `taxcode`.

- **Off:** exactly the behavior before SW-4. A taxed invoice gets the `tax_mapping_missing` conflict ("enter it yourself"), and invoice payloads carry no tax fields.
- **On:** the owner picks three QuickBooks tax codes on the QuickBooks page: one for taxable lines (usually `TAX`), one for untaxed lines (usually `NON`), and the invoice's sales tax code (`tax_rate_ref`, sent as `TxnTaxDetail.TxnTaxCodeRef`). Every invoice then carries `TaxCodeRef` per line and `TxnTaxDetail` with Aerowise's `TotalTax`. Turning it on re-queues invoices waiting in `tax_mapping_missing`.
- **Live companies:** turning it on is refused for a `production` QuickBooks connection until gate G-QBO-TAX (a sandbox round trip, including automated sales tax, recorded by Codex). Lifting that is a reviewed code change (`taxModeAllowed` in `apps/api/src/routes/quickbooks.ts`).
- **Compare after create:** QuickBooks may recalculate tax (automated sales tax), so a mismatch can only be seen once the invoice exists there. After every create in tax mode, `TotalAmt` and `TotalTax` are compared with Aerowise's. A difference makes the link `quarantined` with a `tax_total_mismatch` conflict; its QuickBooks id is stored, so nothing is created again for it.
- **Held:** nothing more is sent for a quarantined invoice (updates, voids), and its payments and refunds wait in `queued` with a "Held" note.
- **Settling it:** "I corrected it in QuickBooks, check again" re-reads the invoice and releases the hold when both totals match; otherwise it stays quarantined with the fresh totals. "Keep it as is and stop syncing this invoice" needs a reason (kept on the record and in the audit log); the invoice then stays out of the sync, and its payments and refunds, including ones already in QuickBooks, wait with a "Not sent" note and keep their QuickBooks ids. Only "check again" can bring it back, and each held change is then sent once. "Check again" writes its result under a row lock and only if the record is unchanged since it was read, so a decision made meanwhile is never overwritten. Aerowise never edits or deletes the QuickBooks invoice.
- **Lost responses:** creates keep the deterministic `requestid` (`aw-<link>-<generation>`), so a replayed create returns the first invoice. A retry after a lost answer also finds the invoice by number for the same customer and compares it, rather than calling it a duplicate number.
- **Tests** use the built-in test company only (`TestCompanies.setAutomatedTax`, `setInvoiceTax`, `loseNext`). No Intuit account or sandbox was used.

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
