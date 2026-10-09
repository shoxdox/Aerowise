-- A phone's inspection for a visit the office changed meanwhile (reassigned, unscheduled or
-- completed) is held for the office instead of refused, as field records of work visits are
-- (0055). The office accepts it as the visit's inspection or sets it aside; nothing the
-- technician recorded is lost either way.

create table inspection_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  offline_client_id uuid not null,
  job_id uuid not null,
  job_type text not null default 'inspection' check (job_type = 'inspection'),
  site_id uuid not null,
  -- Who did the inspection: the technician the visit was taken from.
  technician_user_id uuid not null,
  reason text not null check (reason in ('reassigned', 'cancelled', 'office_completed')),
  status text not null default 'held' check (status in ('held', 'attached', 'dismissed')),
  -- The newest full inspection the phone sent (the same body as PUT /inspections/sync).
  payload jsonb not null,
  resolution_note text,
  resolved_at timestamptz,
  resolved_by uuid references users (id),
  attached_inspection_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offline_client_id),
  foreign key (organization_id, job_id, job_type) references jobs (organization_id, id, type),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, technician_user_id) references memberships (organization_id, user_id),
  foreign key (organization_id, attached_inspection_id) references inspections (organization_id, id),
  check ((status = 'held') = (resolved_at is null))
);
create index inspection_sync_conflicts_held_idx on inspection_sync_conflicts (organization_id, created_at) where status = 'held';

-- Photos of a held inspection have no inspection row to belong to yet: they keep the phone's
-- inspection id, and are linked to the row the office makes when it accepts the inspection.
-- Existing rows are untouched (no backfill at start-up).
alter table attachments alter column inspection_id drop not null;
alter table attachments add column inspection_client_id uuid;
alter table attachments add constraint attachments_owner_check check (inspection_id is not null or inspection_client_id is not null);
create index attachments_held_idx on attachments (organization_id, inspection_client_id) where inspection_id is null;
