-- The customer portal: a homeowner opens a magic link (no account, no password) and sees
-- their contracts, upcoming visits, inspection reports, invoices and renewal, and can ask
-- for service.
--
-- A portal link reaches everything about one customer for weeks, so unlike a pay link
-- only a SHA-256 hash of its token is stored. The token itself exists only in the link
-- that was emailed or copied.

create table portal_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  customer_id uuid not null,
  token_hash bytea not null unique,
  -- 'office' when made from the customer's page; 'email' when the customer asked for it.
  source text not null check (source in ('office', 'email')),
  sent_to text,
  created_by uuid references users (id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id)
);
create index portal_links_customer_idx on portal_links (organization_id, customer_id, created_at desc);

create table service_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  customer_id uuid not null,
  site_id uuid not null,
  kind text not null check (kind in ('alarm', 'odor', 'repair', 'pumping', 'question', 'other')),
  description text not null,
  contact_phone text,
  status text not null default 'open' check (status in ('open', 'closed')),
  resolution text,
  closed_at timestamptz,
  closed_by uuid references users (id),
  portal_link_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((status = 'closed') = (closed_at is not null and resolution is not null)),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, portal_link_id) references portal_links (organization_id, id)
);
create index service_requests_open_idx on service_requests (organization_id, created_at) where status = 'open';
create index service_requests_customer_idx on service_requests (organization_id, customer_id, created_at desc);
