-- Read-only support access: a platform admin opens one organization as it looks to its
-- owner, without its password and without being able to change anything. Like
-- platform_admin_sessions this is a platform table, but each row is about exactly one
-- organization. Only a SHA-256 hash of the token is stored. Starts and ends are written
-- to platform_audit_events and to the organization's own audit_events.

create table support_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  admin_id uuid not null references platform_admins (id),
  organization_id uuid not null references organizations (id),
  reason text not null check (length(trim(reason)) > 0),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  check (expires_at > started_at)
);
create index support_sessions_org_idx on support_sessions (organization_id, started_at);
create index support_sessions_admin_idx on support_sessions (admin_id);
