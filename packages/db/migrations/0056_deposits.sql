-- SW-5b: estimate deposits on an append-only ledger, the final invoice they are applied to,
-- and refunds of deposit money that are reserved first and booked only when the provider
-- says the money moved (service workflows plan §3.6).

-- The deposit asked for, on the draft and frozen into each sent version.
alter table estimates add column deposit_cents integer check (deposit_cents is null or deposit_cents between 1 and 100000000);
alter table estimate_versions add column deposit_cents integer check (deposit_cents is null or deposit_cents between 1 and 100000000);

-- Deposit money applied to a final invoice comes off its total. Every existing invoice has 0,
-- so its total, PDF and QuickBooks payload are unchanged.
alter table invoices add column deposit_applied_cents integer not null default 0 check (deposit_applied_cents >= 0);
do $$
declare c text;
begin
  select conname into strict c from pg_constraint
  where conrelid = 'invoices'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) = 'CHECK ((total_cents = ((subtotal_cents - discount_cents) + tax_cents)))';
  execute format('alter table invoices drop constraint %I', c);
end $$;
alter table invoices add constraint invoices_total_check check (total_cents = subtotal_cents - discount_cents + tax_cents - deposit_applied_cents);
-- I4: a final invoice is never negative.
alter table invoices add constraint invoices_deposit_applied_check check (deposit_applied_cents <= subtotal_cents - discount_cents + tax_cents);

-- Which invoices belong to an estimate: at most one active deposit invoice and one active
-- final invoice, with every voided one kept.
create table estimate_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  estimate_id uuid not null,
  invoice_id uuid not null unique,
  role text not null check (role in ('deposit', 'final')),
  replaces_invoice_id uuid,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, estimate_id) references estimates (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id),
  foreign key (organization_id, replaces_invoice_id) references invoices (organization_id, id)
);
create unique index estimate_invoices_one_active on estimate_invoices (estimate_id, role) where voided_at is null;

-- Refunds of a deposit's money. A refund Aerowise starts is reserved (pending, no provider id
-- yet) and carries its idempotency key, so a lost answer is asked for again with the same key.
-- `deposit_free` comes out of the free deposit money; `deposit_applied` returns money applied
-- to a final invoice ("Refund the job") and names that invoice.
alter table refunds add column idempotency_key text unique;
alter table refunds add column reservation text check (reservation is null or reservation in ('deposit_free', 'deposit_applied'));
alter table refunds add column final_invoice_id uuid;
alter table refunds add foreign key (organization_id, final_invoice_id) references invoices (organization_id, id);
alter table refunds add constraint refunds_reservation_final_check check ((reservation = 'deposit_applied') = (final_invoice_id is not null));

-- The deposit ledger: one per deposit invoice D, append-only. A replayed event finds its rows
-- by (D, cause_key, kind) and writes nothing; one event may write several kinds.
create table deposit_ledger (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null,
  deposit_invoice_id uuid not null,
  estimate_id uuid not null,
  kind text not null check (kind in ('received', 'refunded', 'refunded_external', 'applied', 'unapplied', 'retained', 'retain_reversed', 'shortfall', 'shortfall_released', 'deposit_reversal')),
  amount_cents integer not null check (amount_cents > 0),
  cause_key text not null check (length(cause_key) between 1 and 200),
  payment_id uuid,
  refund_id uuid,
  final_invoice_id uuid,
  actor_user_id uuid references users (id),
  reason text check (reason is null or length(reason) <= 2000),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (deposit_invoice_id, cause_key, kind),
  foreign key (organization_id, deposit_invoice_id) references invoices (organization_id, id),
  foreign key (organization_id, estimate_id) references estimates (organization_id, id),
  foreign key (organization_id, payment_id) references payments (organization_id, id),
  foreign key (organization_id, refund_id) references refunds (organization_id, id),
  foreign key (organization_id, final_invoice_id) references invoices (organization_id, id),
  check ((kind in ('applied', 'unapplied', 'deposit_reversal')) = (final_invoice_id is not null)),
  check (kind not in ('retained', 'retain_reversed') or reason is not null)
);
create index deposit_ledger_deposit_idx on deposit_ledger (organization_id, deposit_invoice_id, seq);
create index deposit_ledger_final_idx on deposit_ledger (organization_id, final_invoice_id) where final_invoice_id is not null;
create or replace function deposit_ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'deposit_ledger rows are never changed; add a correcting entry';
end $$;
create trigger deposit_ledger_append_only before update or delete on deposit_ledger
  for each row execute function deposit_ledger_append_only();

-- How a shortfall was dealt with: a supplemental invoice or a written-off amount. Never
-- changes the ledger's balances; the inbox compares it with the current shortfall.
create table deposit_shortfall_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  deposit_invoice_id uuid not null,
  amount_cents integer not null check (amount_cents > 0),
  kind text not null check (kind in ('supplemental_invoice', 'write_off')),
  invoice_id uuid,
  reason text not null check (length(trim(reason)) between 1 and 2000),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, deposit_invoice_id) references invoices (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id),
  check ((kind = 'supplemental_invoice') = (invoice_id is not null))
);
create or replace function deposit_shortfall_resolutions_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'deposit_shortfall_resolutions rows are never changed';
end $$;
create trigger deposit_shortfall_resolutions_append_only before update or delete on deposit_shortfall_resolutions
  for each row execute function deposit_shortfall_resolutions_append_only();

-- I1, checked at commit so a half-written transaction is never judged: for every deposit
-- invoice touched, the shortfall is exactly the current deficit and free money is never
-- negative.
create or replace function deposit_check(d uuid) returns void language plpgsql as $$
declare
  r bigint; x bigint; a bigint; t bigint; s bigint; q bigint; need bigint;
begin
  select
    coalesce(sum(amount_cents) filter (where kind = 'received'), 0),
    coalesce(sum(amount_cents) filter (where kind in ('refunded', 'refunded_external', 'deposit_reversal')), 0),
    coalesce(sum(case kind when 'applied' then amount_cents when 'unapplied' then -amount_cents when 'deposit_reversal' then -amount_cents else 0 end), 0),
    coalesce(sum(case kind when 'retained' then amount_cents when 'retain_reversed' then -amount_cents else 0 end), 0),
    coalesce(sum(case kind when 'shortfall' then amount_cents when 'shortfall_released' then -amount_cents else 0 end), 0)
  into r, x, a, t, s
  from deposit_ledger where deposit_invoice_id = d;
  select coalesce(sum(f.amount_cents), 0) into q
  from refunds f join payments p on p.id = f.payment_id
  where p.invoice_id = d and f.status = 'pending' and f.reservation = 'deposit_free';
  need := greatest(0, x + q + a + t - r);
  if a < 0 or t < 0 or s <> need then
    raise exception 'deposit ledger for invoice % is not reconciled (R % X % Q % A % T % S %, needs S %)', d, r, x, q, a, t, s, need
      using errcode = 'check_violation';
  end if;
end $$;

create or replace function deposit_ledger_check() returns trigger language plpgsql as $$
begin
  perform deposit_check(new.deposit_invoice_id);
  return null;
end $$;
create constraint trigger deposit_ledger_reconciled after insert on deposit_ledger
  deferrable initially deferred for each row execute function deposit_ledger_check();

create or replace function deposit_refund_check() returns trigger language plpgsql as $$
declare d uuid;
begin
  select ei.invoice_id into d
  from payments p join estimate_invoices ei on ei.invoice_id = p.invoice_id and ei.role = 'deposit'
  where p.id = new.payment_id;
  if d is not null then perform deposit_check(d); end if;
  return null;
end $$;
create constraint trigger deposit_refund_reconciled after insert or update on refunds
  deferrable initially deferred for each row execute function deposit_refund_check();

-- An invoice involving a deposit stays out of QuickBooks until the deposit mapping is decided
-- (gate G-QBO-DEPOSIT), the way an untaxed mapping keeps a taxed invoice out.
alter table quickbooks_links drop constraint quickbooks_links_conflict_kind_check;
alter table quickbooks_links add constraint quickbooks_links_conflict_kind_check
  check (conflict_kind in ('ambiguous_match', 'changed_in_both', 'deleted_in_quickbooks', 'item_missing', 'tax_mapping_missing', 'payment_mismatch', 'duplicate_number', 'tax_total_mismatch', 'deposit_mapping_missing'));

-- One row per office deposit action (refund, keep, put back, shortfall, refund the job), keyed
-- by the id the office's screen made for it. A retry or double submit with the same id finds
-- this row and gets the first result back instead of moving money again; the same id with a
-- different action, invoice or body is refused. Kept per company: another company's id is
-- never looked at.
create table deposit_requests (
  organization_id uuid not null references organizations (id),
  request_id uuid not null,
  action text not null check (action in ('refund', 'retain', 'retain_reverse', 'shortfall', 'refund_job')),
  invoice_id uuid not null,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  -- {refundIds: [...]} once the action committed; written in the same transaction.
  result jsonb not null default '{}'::jsonb,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  primary key (organization_id, request_id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id)
);
