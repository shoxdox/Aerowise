-- W4.2: what each organization owes Aerowise each month. One row per organization per
-- calendar month, written once on the month's first billing run. The count of active
-- contracts and the price used are stored with it and never change afterwards, so every
-- invoice can be explained from its own row. Only the invoice's progress (status, the
-- provider's invoice) moves.

alter table organizations add column billing_customer_id text unique;

create table billing_periods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  starts_on date not null,
  ends_on date not null,
  -- The day the contracts were counted: the month's first day, in the organization's time zone.
  counted_on date not null,
  active_contracts integer not null check (active_contracts >= 0),
  subscription_state text not null
    check (subscription_state in ('design_partner', 'trial', 'active', 'past_due', 'read_only')),
  price_per_contract_cents integer not null check (price_per_contract_cents >= 0),
  monthly_minimum_cents integer not null check (monthly_minimum_cents >= 0),
  amount_cents integer not null check (amount_cents >= 0),
  -- free: nothing to charge (free period, read-only, or a zero total). pending: to be
  -- invoiced. open: invoiced, not paid yet. paid, failed, void: as the provider reports.
  status text not null check (status in ('free', 'pending', 'open', 'paid', 'failed', 'void')),
  provider text check (provider in ('stripe', 'test')),
  provider_invoice_id text unique,
  hosted_invoice_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, starts_on),
  check (ends_on >= starts_on),
  check ((status = 'free') = (amount_cents = 0))
);

create function reject_billing_period_recount() returns trigger language plpgsql as $$
begin
  if (new.organization_id, new.starts_on, new.ends_on, new.counted_on, new.active_contracts, new.subscription_state,
      new.price_per_contract_cents, new.monthly_minimum_cents, new.amount_cents)
     is distinct from
     (old.organization_id, old.starts_on, old.ends_on, old.counted_on, old.active_contracts, old.subscription_state,
      old.price_per_contract_cents, old.monthly_minimum_cents, old.amount_cents) then
    raise exception 'a billing period''s count and amount never change';
  end if;
  return new;
end;
$$;

create trigger billing_periods_counted_once
  before update on billing_periods
  for each row execute function reject_billing_period_recount();

-- Stripe Billing webhook events already applied (Stripe may deliver one more than once).
-- Separate from stripe_events, which belongs to Stripe Connect (homeowner payments).
create table billing_events (
  id text primary key,
  type text not null,
  organization_id uuid references organizations (id),
  received_at timestamptz not null default now()
);
