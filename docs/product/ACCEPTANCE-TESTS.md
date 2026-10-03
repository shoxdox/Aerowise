# ACCEPTANCE-TESTS.md

These are product-level tests, not only unit tests.

## Tenancy

- User from Org A cannot read/update any Org B customer/site/job/inspection/file.
- Signed file URLs cannot cross tenants.
- Background jobs preserve tenant context.

## Import

- Import 500-row messy CSV.
- Detect customer/site/permit/phone/email columns.
- Flag duplicates and ambiguous rows.
- Preview before commit.
- Rollback failed import.

## Contracts

- Annual contract creates expected recurring obligations.
- Renewal creates new term without corrupting history.
- Expired contract appears as exception when required.

## Scheduling

- Due obligation appears in unscheduled work.
- Job assignment updates tech route.
- Customer scheduling restrictions are visible.

## Offline technician flow

- Load route online.
- Disconnect network.
- Complete two inspections with photos.
- Close/reopen app.
- Drafts remain.
- Reconnect.
- Sync succeeds exactly once.
- No duplicate inspections or photos.

## Inspection validation

- Required jurisdiction field missing -> cannot complete.
- Supervisor override requires reason.
- Conditional fields appear correctly.
- Required photo count enforced.

## Reports

- Completed inspection produces immutable report artifact.
- Customer report and jurisdiction report can differ.
- Historical report remains unchanged after template update.

## Filing

- READY -> SENT does not imply CONFIRMED.
- Email failure creates exception.
- Retry is idempotent.
- Confirmation reference stored.
- Deadline warning appears at configured threshold.

## Renewal

- 60-day renewal campaign sends link.
- Customer signs and pays.
- New contract activates.
- Future obligations generated.
- Old contract remains historical.

## Payments

- successful card
- failed card
- ACH pending
- refund
- duplicate webhook replay
- partial payment if supported

## QuickBooks

- exact match
- ambiguous match
- deleted QBO item
- sync retry
- conflict requires human choice

## Customer portal

- magic link scoped to correct customer/site
- report is viewable
- another customer's report cannot be guessed/accessed
