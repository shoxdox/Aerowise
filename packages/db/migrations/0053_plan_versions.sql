-- SW-8: versioned plan definitions, frozen contract coverage and coverage reservations
-- (service workflows plan §4.2, §4.3). Behind the `plan_builder` feature flag; with it off
-- nothing reads the new terms, options or coverage, so contracts and renewals behave as
-- before.
--
-- Nothing about an existing contract changes: every plan gets a version 1 holding its own
-- term, visits and price with no terms of its own (the organization's terms apply), no
-- options and no coverage, and existing contracts and renewals on a plan only gain a link
-- to it. Their copied term, visits and price stay authoritative.

create table plan_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  plan_id uuid not null,
  version integer not null check (version >= 1),
  -- What the plan was at this version, as a contract copies it.
  name text not null,
  customer_type text not null check (customer_type in ('residential', 'commercial')),
  term_months integer not null check (term_months between 1 and 60),
  visits_per_term integer not null check (visits_per_term between 1 and 24),
  price_cents integer not null check (price_cents >= 0),
  billing_frequency text not null check (billing_frequency in ('annual', 'semiannual', 'quarterly', 'monthly')),
  service_type text not null,
  -- Null: the organization's agreement terms (organizations.renewal_terms or the built-in text).
  terms_text text check (terms_text is null or length(terms_text) between 20 and 20000),
  -- Priced choices offered with the plan at signing (packages/domain/src/plans.ts).
  options jsonb not null default '[]' check (jsonb_typeof(options) = 'array'),
  -- Coverage rules; benefits come only from these, never from the plan's name.
  coverage jsonb not null default '[]' check (jsonb_typeof(coverage) = 'array'),
  -- The plan's service cycles. Only the aerobic cycle exists until SW-9.
  service_cycles jsonb not null default '[]' check (jsonb_typeof(service_cycles) = 'array'),
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, plan_id, id),
  unique (plan_id, version),
  -- Deferred: a new plan's version 1 is inserted just before the plan row itself.
  foreign key (organization_id, plan_id) references plans (organization_id, id) deferrable initially deferred
);

-- A version is a record of what was offered: it never changes and is never deleted.
create or replace function plan_versions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'plan versions cannot be changed or deleted; make a new version';
end $$;
create trigger plan_versions_immutable before update or delete on plan_versions
  for each row execute function plan_versions_immutable();

alter table plans add column current_version_id uuid;
alter table plans add foreign key (organization_id, id, current_version_id) references plan_versions (organization_id, plan_id, id);

-- The aerobic cycle a plan's visits make (service workflows plan §4.4).
create or replace function plan_aerobic_cycles(service_type text, visits integer) returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('cycleKey', 'aerobic', 'serviceType', service_type, 'schedule', jsonb_build_object('kind', 'visits_per_term', 'visitsPerTerm', visits)))
$$;

-- Every plan gets version 1 when made, whatever makes it (the office, the seed, an older
-- release), and a new version whenever its name, term, visits, price, billing or customer
-- type changes. The new version keeps the previous one's terms, options and coverage.
-- Builder changes to terms, options or coverage insert their version from the API.
create or replace function plans_record_version() returns trigger language plpgsql as $$
declare
  prev plan_versions;
begin
  if tg_op = 'UPDATE' then
    select * into prev from plan_versions where id = old.current_version_id;
  end if;
  insert into plan_versions (organization_id, plan_id, version, name, customer_type, term_months, visits_per_term, price_cents, billing_frequency, service_type, terms_text, options, coverage, service_cycles)
  values (
    new.organization_id, new.id,
    coalesce((select max(version) from plan_versions where plan_id = new.id), 0) + 1,
    new.name, new.customer_type, new.term_months, new.visits_per_term, new.price_cents, new.billing_frequency, new.service_type,
    prev.terms_text, coalesce(prev.options, '[]'), coalesce(prev.coverage, '[]'),
    plan_aerobic_cycles(new.service_type, new.visits_per_term)
  )
  returning id into new.current_version_id;
  return new;
end $$;
create trigger plans_version_on_insert before insert on plans
  for each row execute function plans_record_version();
create trigger plans_version_on_update before update on plans
  for each row when (
    (old.name, old.customer_type, old.term_months, old.visits_per_term, old.price_cents, old.billing_frequency, old.service_type)
    is distinct from (new.name, new.customer_type, new.term_months, new.visits_per_term, new.price_cents, new.billing_frequency, new.service_type)
  ) execute function plans_record_version();

-- Backfill: version 1 of every existing plan, as it is now.
insert into plan_versions (organization_id, plan_id, version, name, customer_type, term_months, visits_per_term, price_cents, billing_frequency, service_type, terms_text, options, coverage, service_cycles, created_at)
select organization_id, id, 1, name, customer_type, term_months, visits_per_term, price_cents, billing_frequency, service_type, null, '[]', '[]', plan_aerobic_cycles(service_type, visits_per_term), created_at
from plans;
update plans p set current_version_id = v.id from plan_versions v where v.plan_id = p.id and v.version = 1;
alter table plans alter column current_version_id set not null;

-- Contracts and renewals name the version their offer came from. Null for one made without a
-- plan, or by a release from before this one.
alter table contracts add column plan_version_id uuid;
alter table contracts add foreign key (organization_id, plan_id, plan_version_id) references plan_versions (organization_id, plan_id, id);
alter table contracts add constraint contracts_plan_version_needs_plan check (plan_version_id is null or plan_id is not null);
-- What was agreed for a contract the office made without a signature (terms, coverage).
alter table contracts add column agreement_snapshot jsonb;

alter table renewals add column plan_version_id uuid;
alter table renewals add foreign key (organization_id, plan_id, plan_version_id) references plan_versions (organization_id, plan_id, id);
alter table renewals add constraint renewals_plan_version_needs_plan check (plan_version_id is null or plan_id is not null);
-- The plan options the customer chose when signing, copied like the add-ons.
alter table renewals add column selected_options jsonb not null default '[]';

update contracts c set plan_version_id = p.current_version_id from plans p where p.id = c.plan_id and p.organization_id = c.organization_id;
update renewals r set plan_version_id = p.current_version_id from plans p where p.id = r.plan_id and p.organization_id = r.organization_id;

-- A contract's coverage rules, frozen from its plan version when the contract is made. The
-- contract is judged only by these, never by a later version.
create table contract_coverage_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  contract_id uuid not null,
  rule_key text not null check (rule_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  -- The rule's place in its plan: the first rule that fits a line decides it.
  position integer not null check (position >= 1),
  rule jsonb not null check (jsonb_typeof(rule) = 'object'),
  plan_version_id uuid not null,
  -- Uses allowed in the period; null is unlimited.
  limit_count integer check (limit_count is null or limit_count between 1 and 1000),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (contract_id, rule_key),
  unique (contract_id, position),
  foreign key (organization_id, contract_id) references contracts (organization_id, id),
  foreign key (organization_id, plan_version_id) references plan_versions (organization_id, id)
);
create or replace function contract_coverage_rules_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'contract coverage rules are frozen when the contract is made';
end $$;
create trigger contract_coverage_rules_immutable before update or delete on contract_coverage_rules
  for each row execute function contract_coverage_rules_immutable();

-- One work order's use of one rule: reserved when the office applies coverage, consumed
-- when the work is billed (or completed at no charge), released when it is not used after
-- all. Reserved and consumed uses count against the rule's limit.
create table coverage_uses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  contract_coverage_rule_id uuid not null,
  work_order_id uuid not null,
  state text not null default 'reserved' check (state in ('reserved', 'consumed', 'released')),
  invoice_id uuid,
  reserved_at timestamptz not null,
  consumed_at timestamptz,
  released_at timestamptz,
  -- Why it was released or restored, when the office did it.
  reason text check (reason is null or length(reason) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (contract_coverage_rule_id, work_order_id),
  check ((state = 'consumed') = (consumed_at is not null)),
  check ((state = 'released') = (released_at is not null)),
  foreign key (organization_id, contract_coverage_rule_id) references contract_coverage_rules (organization_id, id),
  foreign key (organization_id, work_order_id) references work_orders (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id)
);
create index coverage_uses_work_order_idx on coverage_uses (organization_id, work_order_id);
