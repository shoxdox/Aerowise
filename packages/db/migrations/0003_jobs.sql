-- Jobs: a visit scheduled to a technician on a day.
--
-- An open service obligation with no live job is "unscheduled work". Scheduling creates
-- a job; cancelling the job puts the obligation back in the unscheduled list. Job status
-- follows the versioned state machine in packages/domain/src/jobs.ts.

create table jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  obligation_id uuid,
  type text not null default 'inspection' check (type in ('inspection')),
  status text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'completed', 'cancelled')),
  state_machine_version integer not null default 1,
  scheduled_date date not null,
  technician_user_id uuid not null,
  route_position integer not null default 0,
  notes text,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((status = 'cancelled') = (cancelled_at is not null)),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, obligation_id) references service_obligations (organization_id, id),
  -- The technician must be a member of the same organization.
  foreign key (organization_id, technician_user_id) references memberships (organization_id, user_id)
);

-- A visit has at most one live job.
create unique index jobs_one_live_per_obligation on jobs (obligation_id) where status <> 'cancelled';
-- A technician's route for a day.
create index jobs_route_idx on jobs (organization_id, technician_user_id, scheduled_date, route_position) where status <> 'cancelled';
create index jobs_date_idx on jobs (organization_id, scheduled_date) where status <> 'cancelled';
