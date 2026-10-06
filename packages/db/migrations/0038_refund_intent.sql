-- A refund is either a credit (the customer no longer owes it; the invoice stays paid) or
-- reverses a payment taken by mistake (the customer owes it again). Refunds made before this
-- reopened the balance, so they keep doing so; new ones default to a credit.
alter table refunds add column intent text not null default 'reverse' check (intent in ('credit', 'reverse'));
alter table refunds alter column intent set default 'credit';

-- What was refunded as a credit, no longer owed (kept by recalcInvoice like the other sums).
alter table invoices add column credited_cents integer not null default 0 check (credited_cents >= 0);

-- A credit refund goes to QuickBooks as its own Refund Receipt.
alter table quickbooks_links drop constraint quickbooks_links_entity_type_check;
alter table quickbooks_links add constraint quickbooks_links_entity_type_check check (entity_type in ('customer', 'plan', 'invoice', 'payment', 'refund'));

-- Where Refund Receipts go in QuickBooks, chosen by the company: the item (income account)
-- they reduce, the account Stripe refunds leave from (Undeposited Funds or a Stripe clearing
-- account), and the account check and cash refunds are paid from. Unset until chosen.
alter table quickbooks_connections
  add column refund_item_id text,
  add column refund_item_name text,
  add column stripe_refund_account_id text,
  add column stripe_refund_account_name text,
  add column manual_refund_account_id text,
  add column manual_refund_account_name text;
