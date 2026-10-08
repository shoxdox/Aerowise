-- SW-9: recurring cycles that are not aerobic inspections (service workflows plan §4.4).
--
-- A contract's cycles are frozen from its plan version when it is made: one 'aerobic' cycle
-- for its inspections (today's schedule, authority rules and all) and any pumping or
-- maintenance cycles, each numbering its own visits from 1. Aerobic visits keep exactly
-- today's meaning and numbering. A non-aerobic visit is done as one work order, never as an
-- inspection job, so it can never reach a filing.

create table contract_service_cycles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  contract_id uuid not null,
  cycle_key text not null check (cycle_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  service_type text not null check (service_type in ('aerobic_inspection', 'pumping', 'maintenance')),
  -- The kind of work a non-aerobic visit is booked as; inspections have none.
  work_type_id uuid,
  -- How visits fall in the term, and the whole cycle as the plan version had it.
  schedule jsonb not null check (jsonb_typeof(schedule) = 'object'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  -- Null for a contract made without a plan version, by an import or an older release.
  plan_version_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (contract_id, cycle_key),
  unique (organization_id, id, service_type),
  unique (organization_id, contract_id, id, service_type),
  -- The aerobic cycle is always 'aerobic', so a contract has at most one.
  check ((service_type = 'aerobic_inspection') = (cycle_key = 'aerobic')),
  check ((service_type = 'aerobic_inspection') = (work_type_id is null)),
  foreign key (organization_id, contract_id) references contracts (organization_id, id),
  foreign key (organization_id, work_type_id) references work_types (organization_id, id),
  foreign key (organization_id, plan_version_id) references plan_versions (organization_id, id)
);

-- Written once, with the contract. Deleting is left to whatever deletes the contract (an
-- undone import, an erased company); the obligations' key keeps a used cycle in place.
create or replace function contract_service_cycles_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'a contract''s service cycles never change' using errcode = '55000';
end $$;
create trigger contract_service_cycles_immutable before update on contract_service_cycles
  for each row execute function contract_service_cycles_immutable();

-- The aerobic cycle a contract's own term and visits describe.
create or replace function contract_aerobic_cycle(visits integer) returns jsonb language sql immutable as $$
  select jsonb_build_object('cycleKey', 'aerobic', 'serviceType', 'aerobic_inspection', 'schedule', jsonb_build_object('kind', 'visits_per_term', 'visitsPerTerm', visits))
$$;

-- ---- Backfill: every existing contract gets its aerobic cycle ----

do $$
begin
  if exists (select 1 from service_obligations where service_type <> 'aerobic_inspection') then
    raise exception 'service_obligations has visits that are not aerobic inspections; they need a cycle of their own before this migration';
  end if;
end $$;

insert into contract_service_cycles (organization_id, contract_id, cycle_key, service_type, work_type_id, schedule, snapshot, plan_version_id, created_at)
select c.organization_id, c.id, 'aerobic', 'aerobic_inspection', null,
  contract_aerobic_cycle(c.visits_per_term) -> 'schedule', contract_aerobic_cycle(c.visits_per_term), c.plan_version_id, c.created_at
from contracts c;

alter table service_obligations add column cycle_id uuid;
update service_obligations o set cycle_id = y.id
  from contract_service_cycles y where y.contract_id = o.contract_id and y.cycle_key = 'aerobic';
alter table service_obligations alter column cycle_id set not null;
alter table service_obligations add constraint service_obligations_cycle_fkey
  foreign key (organization_id, contract_id, cycle_id, service_type) references contract_service_cycles (organization_id, contract_id, id, service_type);
create index service_obligations_cycle_idx on service_obligations (cycle_id);

-- Each cycle numbers its visits from 1; aerobic numbering per contract is exactly as before.
alter table service_obligations drop constraint service_obligations_contract_id_sequence_key;
alter table service_obligations add constraint service_obligations_cycle_sequence_key unique (cycle_id, sequence);
create unique index service_obligations_aerobic_sequence on service_obligations (contract_id, sequence) where service_type = 'aerobic_inspection';

-- Writers from before this release insert aerobic visits without a cycle: the contract's
-- aerobic cycle is found, or made from the contract's own visits. Runs before NOT NULL is
-- checked. A visit of any other kind must name its cycle, and a visit never moves.
create or replace function obligations_assign_cycle() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if (new.cycle_id, new.contract_id, new.service_type) is distinct from (old.cycle_id, old.contract_id, old.service_type) then
      raise exception 'a visit''s contract, cycle and kind never change' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.cycle_id is not null then return new; end if;
  if new.service_type <> 'aerobic_inspection' then
    raise exception 'a % visit must name its service cycle', new.service_type using errcode = '23502';
  end if;
  insert into contract_service_cycles (organization_id, contract_id, cycle_key, service_type, schedule, snapshot, plan_version_id)
  select c.organization_id, c.id, 'aerobic', 'aerobic_inspection', contract_aerobic_cycle(c.visits_per_term) -> 'schedule', contract_aerobic_cycle(c.visits_per_term), c.plan_version_id
    from contracts c where c.organization_id = new.organization_id and c.id = new.contract_id
  on conflict (contract_id, cycle_key) do nothing;
  select y.id into new.cycle_id from contract_service_cycles y
    where y.organization_id = new.organization_id and y.contract_id = new.contract_id and y.cycle_key = 'aerobic';
  return new;
end $$;
create trigger obligations_assign_cycle before insert or update on service_obligations
  for each row execute function obligations_assign_cycle();

-- ---- A non-aerobic visit is done as one work order ----

alter table work_orders
  add column obligation_id uuid,
  add column obligation_service_type text;
alter table work_orders add constraint work_orders_obligation_kind_paired check ((obligation_id is null) = (obligation_service_type is null));
alter table work_orders add constraint work_orders_obligation_kind_fkey
  foreign key (organization_id, obligation_id, obligation_service_type) references service_obligations (organization_id, id, service_type);
-- Inspections are done as inspection jobs, never as work.
alter table work_orders add constraint work_orders_obligation_not_aerobic check (obligation_service_type <> 'aerobic_inspection');
-- A work order from a contract cycle is for exactly one of its visits, and names it twice.
alter table work_orders add constraint work_orders_cycle_source check (
  (source_kind = 'contract_cycle') = (obligation_id is not null) and (obligation_id is null or source_id = obligation_id)
);
-- One work order per visit, completed ones included, as one inspection job per aerobic visit.
create unique index work_orders_one_per_obligation on work_orders (obligation_id) where status <> 'cancelled';

-- The kind always comes from the visit in the same company, at the same site. A work order
-- is only made for a visit still open, and never moves to another visit.
create or replace function work_orders_derive_obligation_kind() returns trigger language plpgsql as $$
declare
  o service_obligations;
begin
  if tg_op = 'UPDATE' and new.obligation_id is distinct from old.obligation_id then
    raise exception 'a work order never moves to another visit' using errcode = '23514';
  end if;
  if new.obligation_id is null then
    new.obligation_service_type := null;
    return new;
  end if;
  select * into o from service_obligations where organization_id = new.organization_id and id = new.obligation_id;
  if not found then
    raise exception 'obligation % does not exist in this organization', new.obligation_id using errcode = 'foreign_key_violation';
  end if;
  if o.site_id <> new.site_id then
    raise exception 'a work order for a visit is at that visit''s site' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and o.status <> 'open' then
    raise exception 'this visit is %', o.status using errcode = '23514';
  end if;
  new.obligation_service_type := o.service_type;
  return new;
end $$;
create trigger work_orders_derive_obligation_kind before insert or update of obligation_id, obligation_service_type, site_id on work_orders
  for each row execute function work_orders_derive_obligation_kind();

-- ---- Plan edits keep the plan's cycles ----

-- A plan change rebuilds the aerobic cycle from the new visits (only when the plan has one)
-- and keeps every other cycle, its terms, options, coverage and intake form.
create or replace function plans_record_version() returns trigger language plpgsql as $$
declare
  prev plan_versions;
  aerobic boolean;
begin
  if tg_op = 'UPDATE' then
    select * into prev from plan_versions where id = old.current_version_id;
  end if;
  aerobic := case
    when prev.id is null then new.service_type = 'aerobic_inspection'
    else exists (select 1 from jsonb_array_elements(prev.service_cycles) c where c ->> 'cycleKey' = 'aerobic')
  end;
  insert into plan_versions (organization_id, plan_id, version, name, customer_type, term_months, visits_per_term, price_cents, billing_frequency, service_type, terms_text, options, coverage, service_cycles, intake_template_id)
  values (
    new.organization_id, new.id,
    coalesce((select max(version) from plan_versions where plan_id = new.id), 0) + 1,
    new.name, new.customer_type, new.term_months, new.visits_per_term, new.price_cents, new.billing_frequency, new.service_type,
    prev.terms_text, coalesce(prev.options, '[]'), coalesce(prev.coverage, '[]'),
    (case when aerobic then plan_aerobic_cycles(new.service_type, new.visits_per_term) else '[]'::jsonb end)
      || coalesce((select jsonb_agg(c order by n) from jsonb_array_elements(prev.service_cycles) with ordinality as e(c, n) where c ->> 'cycleKey' <> 'aerobic'), '[]'::jsonb),
    prev.intake_template_id
  )
  returning id into new.current_version_id;
  return new;
end $$;
