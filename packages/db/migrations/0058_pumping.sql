-- SW-6: pumping and disposal records (service workflows plan §2). A pump-out at a site and the
-- delivery of a truck load to a facility are separate events: one load may carry several sites'
-- pump-outs and be delivered later. Both are kept as immutable revisions grouped by a stable
-- identity, so a correction never leaves an old and a corrected volume counted together.
--
-- Wording rule (§2.4): these are the provider's own records. Nothing here says a load is legally
-- compliant, that a manifest satisfies a regulator, or that a facility accepted it.

-- ---- Trucks and facilities the company enters ----

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name text not null check (length(trim(name)) between 1 and 100),
  plate text check (plate is null or length(plate) <= 30),
  capacity_gallons integer check (capacity_gallons is null or capacity_gallons between 1 and 100000),
  -- Free text; Aerowise does not verify it.
  registration_reference text check (registration_reference is null or length(registration_reference) <= 200),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

-- Entered by the company. No facility dataset is shipped or imported; a row from a named public
-- source must say where and when it was read.
create table disposal_facilities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name text not null check (length(trim(name)) between 1 and 200),
  kind text not null check (kind in ('wastewater_treatment_plant', 'land_application_site', 'transfer_station', 'other')),
  address_line1 text check (address_line1 is null or length(address_line1) <= 200),
  city text check (city is null or length(city) <= 100),
  state text check (state is null or length(state) <= 50),
  postal_code text check (postal_code is null or length(postal_code) <= 20),
  lat double precision check (lat is null or lat between -90 and 90),
  lng double precision check (lng is null or lng between -180 and 180),
  permit_or_registration_number text check (permit_or_registration_number is null or length(permit_or_registration_number) <= 200),
  source text not null default 'entered_by_provider' check (source in ('entered_by_provider', 'public_source')),
  source_url text check (source_url is null or length(source_url) <= 1000),
  source_retrieved_on date,
  notes text check (notes is null or length(notes) <= 2000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (source <> 'public_source' or (source_url is not null and source_retrieved_on is not null))
);

-- ---- Revision groups ----

-- A group is its first revision: group_id is that row's id and revision counts from 1. A
-- correction locks the current row, clears is_current and inserts revision n + 1 as current, in
-- one transaction. Rows are never changed otherwise and never deleted (organization erase and
-- demo reseed switch these triggers off for their own transaction).
create or replace function revision_rows_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception '% rows are never deleted; correct them with a new revision', tg_table_name;
  end if;
  if old.is_current and not new.is_current
     and (to_jsonb(new) - 'is_current') = (to_jsonb(old) - 'is_current') then
    return new;
  end if;
  raise exception '% rows are immutable; correct them with a new revision', tg_table_name;
end $$;

-- One pump-out at a site, recorded on the work visit.
create table pumping_records (
  id uuid primary key,
  organization_id uuid not null,
  group_id uuid not null,
  revision integer not null check (revision >= 1),
  is_current boolean not null default true,
  correction_reason text check (correction_reason is null or length(trim(correction_reason)) between 3 and 2000),
  -- The phone's id for the pump-out; set on the first revision only.
  offline_client_id uuid,
  work_order_id uuid not null,
  job_id uuid not null,
  work_record_id uuid not null,
  site_id uuid not null,
  technician_user_id uuid not null,
  vehicle_id uuid,
  service_date date not null,
  waste_type text not null check (waste_type in ('septage', 'grease_trap', 'holding_tank', 'portable_toilet', 'other')),
  waste_type_note text check (waste_type_note is null or length(waste_type_note) <= 500),
  -- [{ "label": "Tank 1", "volume": 500.0 }]: what each tank or compartment held, as entered.
  tanks jsonb not null default '[]' check (jsonb_typeof(tanks) = 'array'),
  -- As entered, shown as recorded.
  entered_volume numeric(10, 1) not null check (entered_volume > 0),
  entered_unit text not null check (entered_unit in ('gallons', 'liters')),
  -- Thousandths of a US gallon, computed once at write time (1 US gallon = 3.785411784 L).
  volume_milligallons bigint not null check (volume_milligallons > 0),
  recorded_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((revision = 1) = (group_id = id)),
  check ((revision = 1) = (correction_reason is null)),
  check (revision = 1 or offline_client_id is null),
  check (volume_milligallons = case entered_unit
    when 'gallons' then round(entered_volume * 1000)
    else round(entered_volume * 1000 / 3.785411784) end),
  foreign key (organization_id, group_id) references pumping_records (organization_id, id),
  foreign key (organization_id, work_order_id) references work_orders (organization_id, id),
  foreign key (organization_id, job_id) references jobs (organization_id, id),
  foreign key (organization_id, work_record_id) references work_records (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, technician_user_id) references memberships (organization_id, user_id),
  foreign key (organization_id, vehicle_id) references vehicles (organization_id, id)
);
create unique index pumping_records_one_current on pumping_records (group_id) where is_current;
create unique index pumping_records_offline_client on pumping_records (organization_id, offline_client_id) where offline_client_id is not null;
-- One pump-out per field record.
create unique index pumping_records_one_per_record on pumping_records (organization_id, work_record_id) where revision = 1;
create index pumping_records_site_idx on pumping_records (organization_id, site_id, service_date desc) where is_current;
create index pumping_records_work_order_idx on pumping_records (organization_id, work_order_id) where is_current;
create trigger pumping_records_immutable before update or delete on pumping_records
  for each row execute function revision_rows_immutable();

-- One delivery of a truck load to a facility.
create table disposal_loads (
  id uuid primary key,
  organization_id uuid not null,
  group_id uuid not null,
  revision integer not null check (revision >= 1),
  is_current boolean not null default true,
  correction_reason text check (correction_reason is null or length(trim(correction_reason)) between 3 and 2000),
  offline_client_id uuid,
  vehicle_id uuid,
  disposal_facility_id uuid not null,
  delivered_on date not null,
  -- "Manifest/reference number": whatever the provider writes on its paperwork.
  manifest_reference text check (manifest_reference is null or length(manifest_reference) <= 200),
  entered_total numeric(10, 1) not null check (entered_total > 0),
  entered_unit text not null check (entered_unit in ('gallons', 'liters')),
  total_milligallons bigint not null check (total_milligallons > 0),
  notes text check (notes is null or length(notes) <= 2000),
  recorded_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((revision = 1) = (group_id = id)),
  check ((revision = 1) = (correction_reason is null)),
  check (revision = 1 or offline_client_id is null),
  check (total_milligallons = case entered_unit
    when 'gallons' then round(entered_total * 1000)
    else round(entered_total * 1000 / 3.785411784) end),
  foreign key (organization_id, group_id) references disposal_loads (organization_id, id),
  foreign key (organization_id, vehicle_id) references vehicles (organization_id, id),
  foreign key (organization_id, disposal_facility_id) references disposal_facilities (organization_id, id)
);
create unique index disposal_loads_one_current on disposal_loads (group_id) where is_current;
create unique index disposal_loads_offline_client on disposal_loads (organization_id, offline_client_id) where offline_client_id is not null;
create index disposal_loads_delivered_idx on disposal_loads (organization_id, delivered_on desc) where is_current;
create trigger disposal_loads_immutable before update or delete on disposal_loads
  for each row execute function revision_rows_immutable();

-- Everything that counts or links reads the current revision of each group.
create view current_pumping_records as select * from pumping_records where is_current;
create view current_disposal_loads as select * from disposal_loads where is_current;

-- Which pump-outs went in which load, by group: a correction of either side keeps the link.
-- A pump-out is in at most one load, whatever its revisions. Adding or removing one is an
-- explicit, audited action.
create table disposal_load_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  load_group_id uuid not null,
  pumping_group_id uuid not null unique,
  added_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, load_group_id) references disposal_loads (organization_id, id),
  foreign key (organization_id, pumping_group_id) references pumping_records (organization_id, id)
);
create index disposal_load_items_load_idx on disposal_load_items (organization_id, load_group_id);

-- Both ends must name a group (its first revision), never a later revision's own id.
create or replace function disposal_load_items_groups() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from disposal_loads where organization_id = new.organization_id and id = new.load_group_id and revision = 1) then
    raise exception 'load_group_id must name a load group' using errcode = '23514';
  end if;
  if not exists (select 1 from pumping_records where organization_id = new.organization_id and id = new.pumping_group_id and revision = 1) then
    raise exception 'pumping_group_id must name a pump-out group' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger disposal_load_items_groups before insert or update on disposal_load_items
  for each row execute function disposal_load_items_groups();

-- ---- Manifest photos: a second photo owner ----

-- A photo belongs to exactly one owner: a field record (or its held conflict) by the record's
-- client id, as before, or a load group, so the manifest survives load corrections. The load
-- owner has a tenant foreign key; every photo stays under its organization's storage prefix.
alter table work_attachments alter column record_client_id drop not null;
alter table work_attachments add column disposal_load_group_id uuid;
alter table work_attachments add foreign key (organization_id, disposal_load_group_id) references disposal_loads (organization_id, id);
alter table work_attachments add constraint work_attachments_one_owner check (num_nonnulls(record_client_id, disposal_load_group_id) = 1);
alter table work_attachments add constraint work_attachments_org_prefix check (storage_key like organization_id::text || '/%');
create index work_attachments_load_idx on work_attachments (organization_id, disposal_load_group_id) where disposal_load_group_id is not null;

-- ---- Settings ----

-- Pump-outs older than this many days and in no load raise "Disposal not recorded".
alter table organizations add column disposal_overdue_days integer not null default 2 check (disposal_overdue_days between 1 and 60);

-- ---- Billing by the pumped volume ----

-- A work order line priced per gallon may bill the volume the visit recorded: at invoicing its
-- quantity is the work order's current pump-out total and the invoice line cites it.
alter table work_order_lines add column bill_pumped_volume boolean not null default false;

-- ---- The pumping form ----

-- New companies get the pumping form on their pumping kind of work; existing companies only
-- where the pumping row still has no form, as 0051 did for repair.
create or replace function work_types_defaults(org uuid) returns void language sql as $$
  insert into work_types (organization_id, key, name, category, default_form_template_key, default_duration_minutes, requires_disposal_record, position)
  values
    (org, 'pumping', 'Pumping', 'pumping', 'work-pumping', 60, true, 1),
    (org, 'repair', 'Repair', 'repair', 'work-repair', 90, false, 2),
    (org, 'installation', 'Installation', 'installation', null, 480, false, 3),
    (org, 'service_call', 'Service call', 'other', 'work-service-call', 60, false, 4)
  on conflict (organization_id, key) do nothing;
$$;
update work_types set default_form_template_key = 'work-pumping', updated_at = now()
  where key = 'pumping' and default_form_template_key is null;
