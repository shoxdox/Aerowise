-- Plans, contracts and recurring service obligations.
--
-- A contract copies term, visit count and price from its plan when it is created, so
-- later plan edits never rewrite existing contracts. Each contract materializes one
-- service_obligations row per visit in its term; scheduling picks these up.

create extension if not exists btree_gist;

create table plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name text not null,
  customer_type text not null default 'residential' check (customer_type in ('residential', 'commercial')),
  term_months integer not null check (term_months between 1 and 60),
  visits_per_term integer not null check (visits_per_term between 1 and 24),
  price_cents integer not null check (price_cents >= 0),
  billing_frequency text not null default 'annual' check (billing_frequency in ('annual', 'semiannual', 'quarterly', 'monthly')),
  service_type text not null default 'aerobic_inspection',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (term_months % visits_per_term = 0)
);

create table contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  plan_id uuid,
  plan_name text not null,
  start_on date not null,
  end_on date not null,
  term_months integer not null check (term_months between 1 and 60),
  visits_per_term integer not null check (visits_per_term between 1 and 24),
  price_cents integer not null check (price_cents >= 0),
  billing_frequency text not null check (billing_frequency in ('annual', 'semiannual', 'quarterly', 'monthly')),
  service_type text not null,
  auto_renew boolean not null default false,
  -- 'expired' and 'upcoming' are derived from the dates, never stored.
  status text not null default 'active' check (status in ('active', 'cancelled')),
  -- Seam for the renewals module (campaigns, e-sign, payment).
  renewal_status text not null default 'not_started',
  previous_contract_id uuid,
  cancelled_at timestamptz,
  cancel_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- Lets obligations prove they belong to the same site as their contract.
  unique (organization_id, id, site_id),
  -- A contract can be renewed at most once; renewals form a chain.
  unique (previous_contract_id),
  check (end_on >= start_on),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, plan_id) references plans (organization_id, id),
  foreign key (organization_id, previous_contract_id) references contracts (organization_id, id),
  -- A site never has two live contracts covering the same day.
  exclude using gist (
    organization_id with =,
    site_id with =,
    daterange(start_on, end_on, '[]') with &&
  ) where (status = 'active')
);
create index contracts_site_idx on contracts (organization_id, site_id, start_on);

create table service_obligations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contract_id uuid not null,
  site_id uuid not null,
  service_type text not null,
  sequence integer not null check (sequence >= 1),
  window_start date not null,
  window_end date not null,
  due_on date not null,
  status text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (contract_id, sequence),
  check (window_end >= window_start),
  check ((status = 'completed') = (completed_at is not null)),
  foreign key (organization_id, contract_id, site_id) references contracts (organization_id, id, site_id)
);
-- The office's "what is due" query: open visits ordered by due date.
create index service_obligations_open_due_idx on service_obligations (organization_id, due_on) where status = 'open';
create index service_obligations_site_idx on service_obligations (organization_id, site_id);
