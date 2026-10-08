-- SW-4: sales tax on invoices sent to QuickBooks. Off by default: with tax_mode 'off', a
-- taxed invoice stays out of QuickBooks with today's tax_mapping_missing conflict.
-- With 'taxcode', each line carries the taxable or non-taxable QuickBooks tax code, and the
-- invoice carries its sales tax code (tax_rate_ref, sent as TxnTaxDetail.TxnTaxCodeRef)
-- and Aerowise's tax total. The names are kept for display, as for items and accounts.
alter table quickbooks_connections
  add column tax_mode text not null default 'off' check (tax_mode in ('off', 'taxcode')),
  add column taxable_code_ref text,
  add column taxable_code_name text,
  add column nontaxable_code_ref text,
  add column nontaxable_code_name text,
  add column tax_rate_ref text,
  add column tax_rate_name text,
  add constraint quickbooks_connections_tax_mapping_check
    check (tax_mode = 'off' or (taxable_code_ref is not null and nontaxable_code_ref is not null and tax_rate_ref is not null));

-- An invoice QuickBooks created with different totals than Aerowise's is 'quarantined': its
-- QuickBooks id is kept (nothing is created again for it), nothing more is sent for it, and
-- its payments and refunds wait until a person settles it.
alter table quickbooks_links drop constraint quickbooks_links_status_check;
alter table quickbooks_links add constraint quickbooks_links_status_check
  check (status in ('new', 'queued', 'syncing', 'synced', 'conflict', 'quarantined', 'failed', 'ignored'));
alter table quickbooks_links drop constraint quickbooks_links_conflict_kind_check;
alter table quickbooks_links add constraint quickbooks_links_conflict_kind_check
  check (conflict_kind in ('ambiguous_match', 'changed_in_both', 'deleted_in_quickbooks', 'item_missing', 'tax_mapping_missing', 'payment_mismatch', 'duplicate_number', 'tax_total_mismatch'));
alter table quickbooks_links drop constraint quickbooks_links_check;
alter table quickbooks_links add constraint quickbooks_links_check
  check ((status in ('conflict', 'quarantined')) = (conflict_kind is not null));
alter table quickbooks_links drop constraint quickbooks_links_check1;
alter table quickbooks_links add constraint quickbooks_links_check1
  check (status not in ('synced', 'quarantined') or external_id is not null);
