-- A refund is either a credit (an ordinary refund: the customer no longer owes it, so the
-- invoice stays paid) or reverses a payment taken by mistake (the customer owes it again).
-- Existing refunds become credits too: no production company has refunds yet, and staging's
-- test refunds were ordinary ones.
alter table refunds add column intent text not null default 'credit' check (intent in ('credit', 'reverse'));

-- What was refunded as a credit, no longer owed (kept by recalcInvoice like the other sums).
alter table invoices add column credited_cents integer not null default 0 check (credited_cents >= 0);
update invoices i set credited_cents = coalesce((
  select sum(r.amount_cents) from refunds r join payments p on p.id = r.payment_id
  where p.invoice_id = i.id and r.status = 'succeeded'
), 0);
update invoices set payment_status = case
    when paid_cents > total_cents - credited_cents then 'overpaid'
    when paid_cents = total_cents - credited_cents and (total_cents - credited_cents > 0 or refunded_cents = 0) then 'paid'
    when paid_cents > 0 then 'partial'
    when pending_cents > 0 then 'processing'
    when refunded_cents > 0 then 'refunded'
    else 'unpaid'
  end
where credited_cents > 0 and status <> 'void';
update invoices set paid_at = coalesce(paid_at, now()) where credited_cents > 0 and status <> 'void' and payment_status in ('paid', 'overpaid');

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
