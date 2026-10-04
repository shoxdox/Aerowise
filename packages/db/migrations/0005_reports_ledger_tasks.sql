-- Background tasks, inspection reports and the per-site compliance ledger.

-- A small Postgres-backed task queue for work that should not happen inside a request:
-- generating PDFs now, sending filings later. Workers claim tasks with
-- FOR UPDATE SKIP LOCKED, so several can run side by side.
create table background_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations (id),
  kind text not null,
  payload jsonb not null default '{}',
  -- Enqueueing the same key twice is a no-op, which makes enqueueing idempotent.
  dedupe_key text unique,
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 8,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now()
);
create index background_tasks_ready_idx on background_tasks (run_at) where completed_at is null and failed_at is null;

-- One immutable PDF per inspection and audience. The data the PDF was drawn from is kept
-- as a snapshot next to it, so neither a template change nor an edit to the customer or
-- site ever changes a historical report.
create table reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  inspection_id uuid not null,
  site_id uuid not null,
  audience text not null check (audience in ('customer', 'authority')),
  version integer not null default 1,
  template_id uuid not null references inspection_templates (id),
  snapshot jsonb not null,
  storage_key text not null,
  content_type text not null default 'application/pdf',
  byte_size integer not null check (byte_size > 0),
  sha256 text not null,
  generated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, inspection_id, audience, version),
  foreign key (organization_id, inspection_id) references inspections (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id)
);
create index reports_site_idx on reports (organization_id, site_id, generated_at desc);

create or replace function reject_change() returns trigger language plpgsql as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end $$;
create trigger reports_immutable before update or delete on reports
  for each row execute function reject_change();

-- What happened to a site's compliance, in order. Append-only like audit_events, but
-- written for people: the site page shows it as a timeline.
create table compliance_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid references users (id),
  inspection_id uuid,
  report_id uuid,
  summary text not null,
  details jsonb not null default '{}',
  unique (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, inspection_id) references inspections (organization_id, id),
  foreign key (organization_id, report_id) references reports (organization_id, id)
);
create index compliance_events_site_idx on compliance_events (organization_id, site_id, occurred_at desc);
create trigger compliance_events_append_only before update or delete on compliance_events
  for each row execute function reject_change();

