-- SW-1: general work orders (pumping, repair, installation, service calls) beside the
-- aerobic inspection path, which is unchanged. See
-- docs/engineering/SERVICE-WORKFLOWS-IMPLEMENTATION-PLAN.md §1.
--
-- Work and compliance stay apart, and the database says so: a work job never references an
-- obligation, an inspection job references only an aerobic one, and an inspection can only
-- belong to an inspection job, so a work job can never reach a filing. None of these guards
-- rests on a nullable discriminator (a CHECK passes on NULL and a composite foreign key with a
-- NULL column is not checked under MATCH SIMPLE).

-- ---- The service menu ----

alter table organizations add column next_work_order_number integer not null default 1001 check (next_work_order_number > 0);

create table work_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text not null check (length(trim(name)) between 1 and 80),
  -- Fixed categories; the names are the company's own.
  category text not null check (category in ('pumping', 'repair', 'installation', 'maintenance', 'inspection_other', 'other')),
  default_form_template_key text,
  default_duration_minutes integer check (default_duration_minutes between 5 and 1440),
  requires_disposal_record boolean not null default false,
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, key)
);

-- Every company starts with the same four kinds of work, whichever way it was created
-- (sign-up, the admin, the demo seed, a visitor demo).
create or replace function work_types_defaults(org uuid) returns void language sql as $$
  insert into work_types (organization_id, key, name, category, default_duration_minutes, requires_disposal_record, position)
  values
    (org, 'pumping', 'Pumping', 'pumping', 60, true, 1),
    (org, 'repair', 'Repair', 'repair', 90, false, 2),
    (org, 'installation', 'Installation', 'installation', 480, false, 3),
    (org, 'service_call', 'Service call', 'other', 60, false, 4)
  on conflict (organization_id, key) do nothing;
$$;
create or replace function organizations_default_work_types() returns trigger language plpgsql as $$
begin
  perform work_types_defaults(new.id);
  return new;
end $$;
create trigger organizations_default_work_types after insert on organizations
  for each row execute function organizations_default_work_types();
select work_types_defaults(id) from organizations;

-- ---- Work orders ----

create table work_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  -- Per company, gapless, shown as WO-1001.
  number integer not null,
  customer_id uuid not null,
  site_id uuid not null,
  work_type_id uuid not null,
  category text not null check (category in ('pumping', 'repair', 'installation', 'maintenance', 'inspection_other', 'other')),
  title text not null check (length(trim(title)) between 1 and 200),
  description text not null default '',
  priority text not null default 'normal' check (priority in ('normal', 'urgent')),
  status text not null default 'open' check (status in ('draft', 'open', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  state_machine_version integer not null default 1,
  -- Not a lifecycle state: voiding an invoice never reopens field work.
  billing_status text not null default 'unbilled' check (billing_status in ('unbilled', 'invoiced', 'no_charge')),
  requested_on date,
  completed_at timestamptz,
  -- Set when the office completed it without a field record (the reason it gave).
  completed_without_record_reason text,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by uuid references users (id),
  source_kind text not null default 'office' check (source_kind in ('office', 'portal_request', 'inspection_issue', 'estimate', 'contract_cycle')),
  source_id uuid,
  coverage_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, number),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'completed') = (completed_at is not null)),
  check ((source_kind = 'office') = (source_id is null)),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, work_type_id) references work_types (organization_id, id)
);
-- One live work order per issue, request or estimate: converting twice finds the first.
create unique index work_orders_one_live_per_source on work_orders (organization_id, source_kind, source_id)
  where status <> 'cancelled' and source_id is not null;
create index work_orders_status_idx on work_orders (organization_id, status, created_at desc);
create index work_orders_site_idx on work_orders (organization_id, site_id, created_at desc);

-- Planned and actual labor, parts and fees. Quantities in thousandths (hours, gallons).
create table work_order_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  work_order_id uuid not null,
  position integer not null default 0,
  description text not null check (length(trim(description)) between 1 and 500),
  quantity_milli integer not null check (quantity_milli > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  taxable boolean not null default false,
  covered_by_contract_id uuid,
  coverage_note text,
  source text not null default 'planned' check (source in ('planned', 'added_in_field')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, work_order_id) references work_orders (organization_id, id) on delete cascade,
  foreign key (organization_id, covered_by_contract_id) references contracts (organization_id, id)
);
create index work_order_lines_order_idx on work_order_lines (organization_id, work_order_id, position);

-- The activity timeline: office, portal and conversion history. Append-only.
create table work_order_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null,
  work_order_id uuid not null,
  event_type text not null,
  summary text not null,
  actor_user_id uuid references users (id),
  details jsonb not null default '{}',
  homeowner_visible boolean not null default false,
  occurred_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, work_order_id) references work_orders (organization_id, id)
);
create index work_order_events_order_idx on work_order_events (organization_id, work_order_id, seq);
create or replace function work_order_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'work_order_events rows are immutable';
end $$;
create trigger work_order_events_append_only before update or delete on work_order_events
  for each row execute function work_order_events_append_only();

create table work_order_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  work_order_id uuid not null,
  body text not null check (length(trim(body)) between 1 and 4000),
  -- Only 'customer' notes ever reach the homeowner.
  visibility text not null default 'internal' check (visibility in ('internal', 'customer')),
  author_user_id uuid references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, work_order_id) references work_orders (organization_id, id)
);
create index work_order_notes_order_idx on work_order_notes (organization_id, work_order_id, created_at);

-- ---- Jobs: inspection or work ----

alter table jobs drop constraint jobs_type_check;
alter table jobs add constraint jobs_type_check check (type in ('inspection', 'work'));
alter table jobs
  add column work_order_id uuid,
  add column visit_number integer check (visit_number > 0),
  -- Was checked when scheduled but never stored; jobs from before this keep null.
  add column retest_of_inspection_id uuid,
  add column obligation_service_type text;
alter table jobs add foreign key (organization_id, work_order_id) references work_orders (organization_id, id);
alter table jobs add foreign key (organization_id, retest_of_inspection_id) references inspections (organization_id, id);
alter table jobs add constraint jobs_kind_shape check (
  (type = 'inspection' and work_order_id is null and visit_number is null)
  or (type = 'work' and work_order_id is not null and visit_number is not null and obligation_id is null and retest_of_inspection_id is null)
);

-- The kind of the visit a job fulfils, always set when there is one, so the composite key
-- below is fully non-null and always checked.
update jobs j set obligation_service_type = o.service_type
  from service_obligations o where o.organization_id = j.organization_id and o.id = j.obligation_id;
alter table service_obligations add constraint service_obligations_org_id_type_key unique (organization_id, id, service_type);
alter table jobs add constraint jobs_obligation_kind_paired check ((obligation_id is null) = (obligation_service_type is null));
alter table jobs add constraint jobs_obligation_kind_fkey
  foreign key (organization_id, obligation_id, obligation_service_type) references service_obligations (organization_id, id, service_type);
alter table jobs add constraint jobs_inspection_aerobic_only check (
  obligation_service_type is null or (type = 'inspection' and obligation_service_type = 'aerobic_inspection')
);

-- Writers from before this release insert jobs with obligation_id and no kind. The kind is
-- always derived from the obligation in the same company, overwriting whatever was given.
create or replace function jobs_derive_obligation_kind() returns trigger language plpgsql as $$
begin
  if new.obligation_id is null then
    new.obligation_service_type := null;
  else
    select o.service_type into new.obligation_service_type
      from service_obligations o where o.organization_id = new.organization_id and o.id = new.obligation_id;
    if not found then
      raise exception 'obligation % does not exist in this organization', new.obligation_id using errcode = 'foreign_key_violation';
    end if;
  end if;
  return new;
end $$;
create trigger jobs_derive_obligation_kind before insert or update of obligation_id, obligation_service_type on jobs
  for each row execute function jobs_derive_obligation_kind();

alter table jobs add constraint jobs_org_id_type_key unique (organization_id, id, type);
-- Several visits per work order, numbered, at most one open at a time. The aerobic
-- jobs_one_live_per_obligation index is unchanged.
create unique index jobs_work_visit_number on jobs (organization_id, work_order_id, visit_number) where work_order_id is not null;
create unique index jobs_one_open_per_work_order on jobs (work_order_id) where status in ('scheduled', 'in_progress');

-- An inspection only ever belongs to an inspection job. The default fills every existing row
-- and every insert from an older writer; an explicit NULL fails NOT NULL.
alter table inspections add column job_type text not null default 'inspection' check (job_type = 'inspection');
alter table inspections add constraint inspections_job_kind_fkey foreign key (organization_id, job_id, job_type) references jobs (organization_id, id, type);

-- ---- Links from what asked for the work ----

alter table issues add column work_order_id uuid;
alter table issues add foreign key (organization_id, work_order_id) references work_orders (organization_id, id);
alter table service_requests add column work_order_id uuid;
alter table service_requests add foreign key (organization_id, work_order_id) references work_orders (organization_id, id);
