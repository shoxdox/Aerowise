-- Electronic monitoring on a system (W6.3). Some authorities allow six months between
-- inspections for a system with qualifying monitoring and automatic notification. Each
-- record says what it is, who it notifies, when it started and when someone checked it
-- works; ending it records when and why. One open record per system.
create table system_monitoring (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  system_id uuid not null,
  method text not null check (method in ('autodialer', 'remote_telemetry', 'other')),
  description text not null,
  notifies text not null,
  started_on date not null,
  checked_on date not null,
  ended_on date,
  end_reason text,
  ended_by uuid references users (id),
  recorded_by uuid not null references users (id),
  recorded_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, system_id) references wastewater_systems (organization_id, id),
  check (checked_on >= started_on),
  check (ended_on is null or ended_on >= started_on),
  check ((ended_on is null) = (end_reason is null) and (ended_on is null) = (ended_by is null))
);
create unique index system_monitoring_open_idx on system_monitoring (organization_id, system_id) where ended_on is null;
