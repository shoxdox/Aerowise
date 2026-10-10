-- Pay links and renewal links are signed from the row's id under the server's signing secret
-- (packages/tasks/src/links.ts) instead of being stored in plaintext. A copy of the database
-- no longer holds a working link to anyone's invoice or renewal offer. Links sent before this
-- migration stop working; an open invoice's next reminder, the portal and the office's invoice
-- page all carry the new link. (The invoice's freeze trigger and issued-state check listed the
-- column, so both are restated without it.)

alter table invoices drop constraint invoices_check3;
alter table invoices add constraint invoices_issued_fields_check
  check (status = 'draft' or (issued_on is not null and due_on is not null and snapshot is not null));
alter table invoices drop column public_token;
alter table renewals drop column public_token;

create or replace function invoices_freeze() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' and (
    new.customer_id, new.site_id, new.number, new.memo, new.terms_days, new.tax_rate_bps, new.discount_cents,
    new.subtotal_cents, new.taxable_cents, new.tax_cents, new.total_cents, new.issued_on, new.due_on,
    new.snapshot
  ) is distinct from (
    old.customer_id, old.site_id, old.number, old.memo, old.terms_days, old.tax_rate_bps, old.discount_cents,
    old.subtotal_cents, old.taxable_cents, old.tax_cents, old.total_cents, old.issued_on, old.due_on,
    old.snapshot
  ) then
    raise exception 'issued invoices cannot be edited';
  end if;
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'void invoices stay void';
  end if;
  if old.pdf_storage_key is not null and new.pdf_storage_key is distinct from old.pdf_storage_key then
    raise exception 'an invoice PDF is never replaced';
  end if;
  return new;
end $$;
