-- Invoices, payments, refunds and Stripe.
--
-- An invoice is a draft (editable, no number), open (issued: numbered, frozen, payable)
-- or void. How much has been paid is tracked separately (payment_status and the cached
-- sums), recomputed from payments and refunds in the same transaction that changes them.

alter table organizations
  add column invoice_terms_days integer not null default 30 check (invoice_terms_days between 0 and 120),
  add column default_tax_rate_bps integer not null default 0 check (default_tax_rate_bps between 0 and 2000),
  -- Next number to give an issued invoice. Drafts have no number, so numbers have no gaps.
  add column next_invoice_number integer not null default 1001 check (next_invoice_number > 0),
  -- The provider's own Stripe account (Connect): customers' money settles there.
  add column stripe_account_id text unique,
  add column stripe_charges_enabled boolean not null default false,
  add column stripe_details_submitted boolean not null default false;

create table invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  customer_id uuid not null,
  site_id uuid,
  number integer,
  status text not null default 'draft' check (status in ('draft', 'open', 'void')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'processing', 'partial', 'paid', 'overpaid', 'refunded')),
  memo text,
  terms_days integer not null check (terms_days between 0 and 120),
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 2000),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  taxable_cents integer not null default 0 check (taxable_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  total_cents integer not null default 0 check (total_cents >= 0),
  -- Cleared payments less cleared refunds, and bank payments still clearing.
  paid_cents integer not null default 0,
  pending_cents integer not null default 0 check (pending_cents >= 0),
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  issued_on date,
  due_on date,
  -- The customer's pay link. A bearer secret like a signed link; voiding stops it working.
  public_token text unique,
  -- Exactly what the issued invoice says (see InvoiceSnapshot in packages/domain).
  snapshot jsonb,
  pdf_storage_key text,
  pdf_sha256 text,
  pdf_byte_size integer,
  sent_at timestamptz,
  send_count integer not null default 0,
  paid_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, number),
  check (discount_cents <= subtotal_cents),
  check (total_cents = subtotal_cents - discount_cents + tax_cents),
  -- A number, dates, pay link and snapshot exactly when issued.
  check ((status = 'draft') = (number is null)),
  check (status = 'draft' or (issued_on is not null and due_on is not null and public_token is not null and snapshot is not null)),
  check ((status = 'void') = (voided_at is not null)),
  check ((pdf_storage_key is null) = (pdf_sha256 is null)),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id)
);
create index invoices_org_status_idx on invoices (organization_id, status, due_on);
create index invoices_customer_idx on invoices (organization_id, customer_id, created_at desc);

-- An issued invoice says what it said. Payment fields, delivery, the PDF (once) and
-- voiding may still change.
create or replace function invoices_freeze() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' and (
    new.customer_id, new.site_id, new.number, new.memo, new.terms_days, new.tax_rate_bps, new.discount_cents,
    new.subtotal_cents, new.taxable_cents, new.tax_cents, new.total_cents, new.issued_on, new.due_on,
    new.public_token, new.snapshot
  ) is distinct from (
    old.customer_id, old.site_id, old.number, old.memo, old.terms_days, old.tax_rate_bps, old.discount_cents,
    old.subtotal_cents, old.taxable_cents, old.tax_cents, old.total_cents, old.issued_on, old.due_on,
    old.public_token, old.snapshot
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
create trigger invoices_freeze before update on invoices for each row execute function invoices_freeze();

create or replace function invoices_delete_drafts_only() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'issued invoices are voided, never deleted';
  end if;
  return old;
end $$;
create trigger invoices_delete_drafts_only before delete on invoices for each row execute function invoices_delete_drafts_only();

create table invoice_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  invoice_id uuid not null,
  position integer not null check (position >= 1),
  description text not null,
  quantity integer not null check (quantity between 1 and 10000),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  amount_cents integer not null check (amount_cents = quantity * unit_price_cents),
  taxable boolean not null default false,
  -- What the line bills for, when it is a contract installment or a job.
  contract_id uuid,
  installment integer check (installment >= 1),
  period_start date,
  period_end date,
  job_id uuid,
  unique (organization_id, id),
  unique (invoice_id, position) deferrable initially deferred,
  check ((contract_id is null) = (installment is null)),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id) on delete cascade,
  foreign key (organization_id, contract_id) references contracts (organization_id, id),
  foreign key (organization_id, job_id) references jobs (organization_id, id)
);
create index invoice_lines_invoice_idx on invoice_lines (invoice_id, position);
create index invoice_lines_contract_idx on invoice_lines (organization_id, contract_id, installment) where contract_id is not null;

create or replace function invoice_lines_draft_only() returns trigger language plpgsql as $$
declare
  s text;
begin
  select status into s from invoices where id = coalesce(new.invoice_id, old.invoice_id);
  -- The invoice itself is gone (cascade from deleting a draft).
  if s is null then
    return coalesce(new, old);
  end if;
  if s <> 'draft' then
    raise exception 'lines of an issued invoice cannot change';
  end if;
  return coalesce(new, old);
end $$;
create trigger invoice_lines_draft_only before insert or update or delete on invoice_lines
  for each row execute function invoice_lines_draft_only();

create table payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  invoice_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  method text not null check (method in ('card', 'ach', 'check', 'cash', 'other')),
  source text not null check (source in ('stripe', 'manual')),
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  -- Cleared refunds against this payment.
  refunded_cents integer not null default 0 check (refunded_cents >= 0 and refunded_cents <= amount_cents),
  -- Stripe's PaymentIntent and Checkout Session. One payment per PaymentIntent, so a
  -- replayed or out-of-order webhook finds the payment it already made.
  provider_payment_id text unique,
  provider_session_id text,
  received_on date,
  reference text,
  note text,
  failure_reason text,
  recorded_by uuid references users (id),
  succeeded_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((source = 'stripe') = (provider_payment_id is not null)),
  check ((status = 'succeeded') = (succeeded_at is not null)),
  check ((status = 'failed') = (failed_at is not null)),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id)
);
create index payments_invoice_idx on payments (organization_id, invoice_id);
create index payments_failed_idx on payments (organization_id, failed_at) where status = 'failed';

create table refunds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  payment_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  provider_refund_id text unique,
  reason text,
  failure_reason text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, payment_id) references payments (organization_id, id)
);
create index refunds_payment_idx on refunds (organization_id, payment_id);

-- Stripe Checkout pages opened for an invoice. An open one for the same amount is reused,
-- so a customer clicking "Pay" twice does not get two payable pages.
create table checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  invoice_id uuid not null,
  provider_session_id text not null unique,
  amount_cents integer not null check (amount_cents > 0),
  url text not null,
  expires_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'complete', 'expired')),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id)
);
create index checkout_sessions_invoice_idx on checkout_sessions (organization_id, invoice_id, created_at desc);

-- Every webhook Stripe delivered, by its event id. Recording the event and applying it
-- happen in one transaction, so a replay is recognized and skipped, and a failure leaves
-- nothing behind for Stripe's retry to trip over.
create table stripe_events (
  id text primary key,
  type text not null,
  account text,
  livemode boolean not null,
  organization_id uuid references organizations (id),
  payload jsonb not null,
  outcome text not null,
  received_at timestamptz not null default now()
);

-- What happened to an invoice, in order, written for people. Append-only.
create table invoice_events (
  id uuid primary key default gen_random_uuid(),
  -- Insertion order, so events written in the same instant still list in order.
  seq bigint generated always as identity,
  organization_id uuid not null,
  invoice_id uuid not null,
  event_type text not null,
  summary text not null,
  actor_user_id uuid references users (id),
  payment_id uuid,
  details jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id) on delete cascade,
  foreign key (organization_id, payment_id) references payments (organization_id, id)
);
create index invoice_events_invoice_idx on invoice_events (organization_id, invoice_id, seq);
create or replace function invoice_events_append_only() returns trigger language plpgsql as $$
begin
  -- Deleting a draft takes its events with it; nothing else may change them.
  if tg_op = 'DELETE' and not exists (select 1 from invoices where id = old.invoice_id and status <> 'draft') then
    return old;
  end if;
  raise exception 'invoice_events rows are immutable';
end $$;
create trigger invoice_events_append_only before update or delete on invoice_events
  for each row execute function invoice_events_append_only();

-- Payments show on the site's compliance timeline beside the visits they paid for.
alter table compliance_events add column invoice_id uuid;
alter table compliance_events add foreign key (organization_id, invoice_id) references invoices (organization_id, id);
