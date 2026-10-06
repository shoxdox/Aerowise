-- Personalized prospect demos (W10.6): a demo company made from /admin for one prospect, with
-- their name and counties on fictional data, that ends on a set day. The prospect gets in by a
-- link the admin copies and sends themselves; Aerowise sends nothing.
alter table organizations add column demo_prospect text;
alter table organizations add constraint organizations_demo_prospect check (demo_prospect is null or (demo and demo_expires_at is not null));

-- Sign-in links into a prospect demo. Only the token's hash is kept; a link works until it is
-- revoked or the demo ends, whichever is first.
create table demo_access_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_by uuid not null references platform_admins (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index demo_access_links_organization on demo_access_links (organization_id);
