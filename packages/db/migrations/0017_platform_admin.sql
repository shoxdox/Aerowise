-- Platform admins: the people who run Aerowise itself (create organizations, support
-- them). They are a separate identity from tenant users, with their own sessions and
-- their own audit log, so no tenant role can ever grow into a platform role and no
-- tenant session can reach an /admin route. These tables are platform-wide by design,
-- not tenant tables: they carry no organization_id of their own.

create table platform_admins (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index platform_admins_email_key on platform_admins (lower(email));

-- Only a SHA-256 hash of the token is stored, as for tenant sessions.
create table platform_admin_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  admin_id uuid not null references platform_admins (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index platform_admin_sessions_admin_idx on platform_admin_sessions (admin_id);

-- Every admin action. organization_id names the organization acted on, when there is one.
create table platform_audit_events (
  id bigint generated always as identity primary key,
  admin_id uuid references platform_admins (id),
  organization_id uuid references organizations (id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  changes jsonb not null default '{}',
  request_id text,
  occurred_at timestamptz not null default now()
);
create index platform_audit_events_org_idx on platform_audit_events (organization_id, occurred_at);

create function reject_platform_audit_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'platform_audit_events is append-only';
end;
$$;

create trigger platform_audit_events_append_only
  before update or delete on platform_audit_events
  for each statement execute function reject_platform_audit_mutation();

-- "Last activity" on the admin organization list reads the newest audit event per
-- organization; the existing entity index does not lead with the time.
create index audit_events_org_time_idx on audit_events (organization_id, occurred_at desc);
