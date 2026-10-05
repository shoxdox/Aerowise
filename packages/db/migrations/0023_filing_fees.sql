-- Per-authority filing fees (W6.4). A filing records the fee its authority charged when it
-- opened, the late fee that would apply, and (once it first reaches the authority) the late
-- fee actually owed, so a later fee schedule never changes what an earlier filing owed.
alter table filings add column filing_fee_cents integer check (filing_fee_cents >= 0);
alter table filings add column late_fee_rule_cents integer check (late_fee_rule_cents >= 0);
-- Null until the filing is first sent; then the late fee owed (0 when on time), never changed.
alter table filings add column late_fee_cents integer check (late_fee_cents >= 0);
alter table filings add column fee_basis text;
