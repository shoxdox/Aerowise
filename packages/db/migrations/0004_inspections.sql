-- Inspections: what a technician records at a visit.
--
-- A template version is immutable. The built-in template has organization_id null; an
-- organization customizes it by saving its own versions under the same key. Every
-- inspection keeps the template version it was done with.
--
-- The phone app creates ids for inspections, photos and issues while offline
-- (offline_client_id / client_id). Those ids are unique per organization, which is what
-- makes every retry of a sync or upload idempotent.

create table inspection_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations (id),
  key text not null,
  version integer not null check (version > 0),
  name text not null,
  definition jsonb not null,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);
create unique index inspection_templates_builtin_version on inspection_templates (key, version) where organization_id is null;
create unique index inspection_templates_org_version on inspection_templates (organization_id, key, version) where organization_id is not null;

create or replace function inspection_templates_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'inspection template versions are immutable; save a new version instead';
end $$;
create trigger inspection_templates_no_update before update on inspection_templates
  for each row execute function inspection_templates_immutable();

create table inspections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  offline_client_id uuid not null,
  job_id uuid not null,
  site_id uuid not null,
  template_id uuid not null references inspection_templates (id),
  technician_user_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'completed')),
  validation_status text not null default 'pending' check (validation_status in ('pending', 'valid', 'invalid', 'overridden')),
  validation_problems jsonb not null default '[]',
  override_reason text,
  override_by uuid references users (id),
  arrived_at timestamptz not null,
  completed_at timestamptz,
  arrival_lat double precision,
  arrival_lng double precision,
  arrival_accuracy_m double precision,
  completion_lat double precision,
  completion_lng double precision,
  completion_accuracy_m double precision,
  access_issue text,
  -- Set when a report is filed; nothing about the inspection may change after that.
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offline_client_id),
  -- One inspection per job.
  unique (job_id),
  check ((status = 'completed') = (completed_at is not null)),
  check ((validation_status = 'overridden') = (override_reason is not null)),
  foreign key (organization_id, job_id) references jobs (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, technician_user_id) references memberships (organization_id, user_id)
);
create index inspections_site_idx on inspections (organization_id, site_id, created_at desc);

create table inspection_values (
  organization_id uuid not null,
  inspection_id uuid not null,
  field_key text not null,
  value_json jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (inspection_id, field_key),
  foreign key (organization_id, inspection_id) references inspections (organization_id, id) on delete cascade
);

create table attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  offline_client_id uuid not null,
  inspection_id uuid not null,
  photo_key text not null,
  storage_key text not null,
  content_type text not null,
  byte_size integer not null check (byte_size > 0),
  sha256 text not null,
  captured_at timestamptz,
  lat double precision,
  lng double precision,
  uploaded_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offline_client_id),
  foreign key (organization_id, inspection_id) references inspections (organization_id, id)
);
create index attachments_inspection_idx on attachments (organization_id, inspection_id);

create table issues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  client_id uuid not null,
  inspection_id uuid not null,
  site_id uuid not null,
  type text not null check (type in ('repair_needed', 'pump_out', 'part_replacement', 'callback', 'estimate_required', 'noncompliance')),
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  description text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, client_id),
  foreign key (organization_id, inspection_id) references inspections (organization_id, id) on delete cascade,
  foreign key (organization_id, site_id) references sites (organization_id, id)
);
create index issues_open_idx on issues (organization_id, status, created_at desc);
