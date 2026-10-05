-- Annual lab tests (W6.2). Some authorities require effluent samples (BOD and TSS) tested
-- by a lab on a schedule. Each result is recorded once and never changed; a mistake is
-- fixed by recording a correction that replaces it.
create table lab_tests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  site_id uuid not null,
  sampled_on date not null,
  lab_name text not null,
  -- The lab's report or sample number.
  lab_reference text,
  -- A list of { analyte, value } in mg/L, not a map: jsonb keys are camel-cased on read.
  results jsonb not null,
  notes text,
  replaces_id uuid,
  recorded_by uuid not null references users (id),
  recorded_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, replaces_id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, replaces_id) references lab_tests (organization_id, id)
);
create index lab_tests_site_idx on lab_tests (organization_id, site_id, sampled_on desc);
create trigger lab_tests_append_only before update or delete on lab_tests
  for each row execute function reject_change();
