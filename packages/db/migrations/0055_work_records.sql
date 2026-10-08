-- SW-2 (server): what a technician records on a work visit, sent from the phone, and what
-- happens when the office changed the visit while the phone was offline. See
-- docs/engineering/SERVICE-WORKFLOWS-IMPLEMENTATION-PLAN.md §8.1 and §8.5.
--
-- A phone client id (offline_client_id) lives in work_records or in work_sync_conflicts, never
-- both while live. Photos and signatures name their record by that client id, so they keep
-- their owner when a draft moves to a conflict or a conflict is attached back as a record,
-- and their storage keys never change.

-- ---- Who was sent: assignment provenance ----

-- Append-only: one row per technician sent on a work visit. A row is only ever updated once,
-- to end it. Written by the trigger on jobs below, whichever code changes the job.
create table job_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  job_type text not null default 'work' check (job_type = 'work'),
  technician_user_id uuid not null,
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason in ('reassigned', 'unassigned', 'cancelled', 'office_completed')),
  unique (organization_id, id),
  check ((ended_at is null) = (end_reason is null)),
  foreign key (organization_id, job_id, job_type) references jobs (organization_id, id, type),
  foreign key (organization_id, technician_user_id) references memberships (organization_id, user_id)
);
-- At most one current assignment per job.
create unique index job_assignments_one_current on job_assignments (job_id) where ended_at is null;
create index job_assignments_tech_idx on job_assignments (organization_id, technician_user_id, job_id);

create or replace function job_assignments_end_once() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'job assignments are never deleted';
  end if;
  if old.ended_at is null and new.ended_at is not null
     and (to_jsonb(new) - array['ended_at', 'end_reason']) = (to_jsonb(old) - array['ended_at', 'end_reason']) then
    return new;
  end if;
  raise exception 'job assignments are append-only; an assignment can only be ended once';
end $$;
create trigger job_assignments_end_once before update or delete on job_assignments
  for each row execute function job_assignments_end_once();

-- ---- Field records ----

create table work_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  offline_client_id uuid not null,
  job_id uuid not null,
  job_type text not null default 'work' check (job_type = 'work'),
  work_order_id uuid not null,
  site_id uuid not null,
  technician_user_id uuid not null,
  -- The form version the phone started with; the record is checked against it.
  template_id uuid not null references inspection_templates (id),
  status text not null default 'draft' check (status in ('draft', 'completed')),
  validation_status text not null default 'pending' check (validation_status in ('pending', 'valid', 'invalid')),
  validation_problems jsonb not null default '[]',
  answers jsonb not null default '{}',
  -- What the customer saw and signed, and its sha256 (canonical JSON).
  summary jsonb,
  summary_sha256 text,
  final_visit boolean not null default true,
  phone_revision integer not null default 0,
  arrived_at timestamptz not null,
  completed_at timestamptz,
  arrival_lat double precision,
  arrival_lng double precision,
  completion_lat double precision,
  completion_lng double precision,
  -- Set when the office attached it from a conflict; the technician is still the one who did it.
  attached_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offline_client_id),
  -- One field record per visit.
  unique (job_id),
  check ((status = 'completed') = (completed_at is not null)),
  foreign key (organization_id, job_id, job_type) references jobs (organization_id, id, type),
  foreign key (organization_id, work_order_id) references work_orders (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, technician_user_id) references memberships (organization_id, user_id)
);
create index work_records_order_idx on work_records (organization_id, work_order_id);

-- A record is filled in on a work form, never on an inspection or intake form.
create or replace function work_records_template_purpose() returns trigger language plpgsql as $$
begin
  if (select purpose from inspection_templates where id = new.template_id) <> 'work' then
    raise exception 'a work record must use a work form' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger work_records_template_purpose before insert or update of template_id on work_records
  for each row execute function work_records_template_purpose();

-- ---- Held for the office ----

create table work_sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  offline_client_id uuid not null,
  job_id uuid not null,
  job_type text not null default 'work' check (job_type = 'work'),
  work_order_id uuid not null,
  -- Who did the work: the technician the visit was taken from.
  technician_user_id uuid not null,
  reason text not null check (reason in ('reassigned', 'cancelled', 'office_completed')),
  status text not null default 'held' check (status in ('held', 'attached', 'dismissed')),
  -- The newest full record the phone sent (the same body as PUT /work/sync).
  payload jsonb,
  phone_revision integer not null default 0,
  resolution_note text,
  resolved_at timestamptz,
  resolved_by uuid references users (id),
  attached_job_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, offline_client_id),
  check ((status = 'held') = (resolved_at is null)),
  check (status <> 'attached' or attached_job_id is not null),
  foreign key (organization_id, job_id, job_type) references jobs (organization_id, id, type),
  foreign key (organization_id, work_order_id) references work_orders (organization_id, id),
  foreign key (organization_id, technician_user_id) references memberships (organization_id, user_id),
  foreign key (organization_id, attached_job_id) references jobs (organization_id, id)
);
create index work_sync_conflicts_status_idx on work_sync_conflicts (organization_id, status, created_at desc);

-- ---- Photos ----

create table work_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  offline_client_id uuid not null,
  -- The record (or conflict) client id this photo belongs to.
  record_client_id uuid not null,
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
  unique (organization_id, offline_client_id)
);
create index work_attachments_record_idx on work_attachments (organization_id, record_client_id);

-- ---- Customer signatures on a work summary ----

alter table signed_documents
  add column offline_client_id uuid,
  add column record_client_id uuid,
  add column requirement_key text;
create unique index signed_documents_offline_client on signed_documents (organization_id, offline_client_id) where offline_client_id is not null;
create index signed_documents_record_client on signed_documents (organization_id, record_client_id) where record_client_id is not null;
alter table signed_documents add constraint signed_documents_work_completion_owner
  check (kind <> 'work_completion' or (record_client_id is not null and offline_client_id is not null and requirement_key is not null));

-- ---- Keeping provenance with the job ----

-- Every change to a work visit's technician or status, from any code path, starts or ends the
-- assignment in the same transaction. Taking the visit away from a technician also moves their
-- unfinished (draft) record to a held conflict, freeing the visit for the next technician; a
-- completed record is final and never moves.
create or replace function jobs_track_work_assignment() returns trigger language plpgsql as $$
declare
  why text;
begin
  if new.type <> 'work' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status in ('scheduled', 'in_progress') then
      insert into job_assignments (organization_id, job_id, technician_user_id) values (new.organization_id, new.id, new.technician_user_id);
    end if;
    return new;
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled' then
    why := case when (select status from work_orders where organization_id = new.organization_id and id = new.work_order_id) = 'completed'
                then 'office_completed' else 'cancelled' end;
  elsif new.technician_user_id <> old.technician_user_id and new.status in ('scheduled', 'in_progress') then
    why := 'reassigned';
  else
    return new;
  end if;

  update job_assignments set ended_at = now(), end_reason = why
    where job_id = new.id and ended_at is null;
  insert into work_sync_conflicts (organization_id, offline_client_id, job_id, work_order_id, technician_user_id, reason, payload, phone_revision)
    select r.organization_id, r.offline_client_id, r.job_id, r.work_order_id, r.technician_user_id, why,
           jsonb_build_object('fromDraft', true, 'templateId', r.template_id, 'answers', r.answers, 'arrivedAt', r.arrived_at), r.phone_revision
      from work_records r where r.job_id = new.id and r.status = 'draft';
  delete from work_records where job_id = new.id and status = 'draft';
  if why = 'reassigned' then
    insert into job_assignments (organization_id, job_id, technician_user_id) values (new.organization_id, new.id, new.technician_user_id);
  end if;
  return new;
end $$;
create trigger jobs_track_work_assignment after insert or update of technician_user_id, status on jobs
  for each row execute function jobs_track_work_assignment();

-- Work visits that are already live get their current assignment.
insert into job_assignments (organization_id, job_id, technician_user_id, assigned_at)
  select organization_id, id, technician_user_id, created_at from jobs where type = 'work' and status in ('scheduled', 'in_progress');
