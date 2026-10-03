-- Tenancy, auth and CRM core.
--
-- Tenant isolation rule: every tenant-owned table carries organization_id and a
-- UNIQUE (organization_id, id) key. Child tables reference their parent through
-- (organization_id, parent_id), so the database itself refuses a row whose parent
-- belongs to a different organization.

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  timezone text not null default 'America/Chicago',
  logo_url text,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  password_hash text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create type membership_role as enum ('owner', 'office', 'technician', 'read_only');

create table memberships (
  organization_id uuid not null references organizations (id),
  user_id uuid not null references users (id),
  role membership_role not null,
  technician_license text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

-- Only a SHA-256 hash of the session token is stored; the token itself lives in an
-- httpOnly cookie. A session is bound to one membership.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  organization_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  foreign key (organization_id, user_id) references memberships (organization_id, user_id)
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  display_name text not null,
  billing_line1 text,
  billing_line2 text,
  billing_city text,
  billing_state text,
  billing_postal_code text,
  status text not null default 'active' check (status in ('active', 'inactive', 'prospect')),
  source text,
  tags text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index customers_org_name_idx on customers (organization_id, lower(display_name));

create table sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null,
  address_line1 text not null,
  address_line2 text,
  city text not null,
  state text not null default 'TX',
  postal_code text,
  county text,
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  permit_number text,
  access_notes text,
  gate_code text,
  safety_flags text[] not null default '{}',
  scheduling_notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id)
);
create index sites_customer_idx on sites (organization_id, customer_id);
create index sites_permit_idx on sites (organization_id, permit_number);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null,
  site_id uuid,
  name text not null,
  email text,
  phone text,
  type text not null default 'primary' check (type in ('primary', 'billing', 'site', 'other')),
  consent_email boolean not null default false,
  consent_sms boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id)
);
create index contacts_customer_idx on contacts (organization_id, customer_id);

create table wastewater_systems (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  manufacturer text,
  model text,
  serial text,
  installed_at date,
  system_type text,
  treatment_type text,
  disposal_type text,
  chlorination_method text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id)
);
create index wastewater_systems_site_idx on wastewater_systems (organization_id, site_id);

-- Structured audit log. Append-only: updates and deletes are rejected.
create table audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references organizations (id),
  actor_user_id uuid references users (id),
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  changes jsonb not null default '{}',
  request_id text,
  occurred_at timestamptz not null default now()
);
create index audit_events_entity_idx on audit_events (organization_id, entity_type, entity_id);

create function reject_audit_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_append_only
  before update or delete on audit_events
  for each statement execute function reject_audit_mutation();
