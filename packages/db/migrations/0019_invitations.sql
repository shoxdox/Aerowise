-- User invitations. An owner or office user (or a platform admin, for an organization's
-- first owner) invites someone by email with a role. Only a SHA-256 hash of the link's
-- token is stored. A link is single-use and expires; sending the invitation again makes
-- a new link and the old one stops working.

create table invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  email text not null,
  name text,
  role membership_role not null,
  token_hash bytea not null unique,
  invited_by_user_id uuid references users (id),
  invited_by_admin_id uuid references platform_admins (id),
  created_at timestamptz not null default now(),
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id uuid references users (id),
  revoked_at timestamptz,
  unique (organization_id, id),
  -- Exactly one inviter: a member of the organization, or a platform admin.
  check ((invited_by_user_id is null) <> (invited_by_admin_id is null)),
  check ((accepted_at is null) = (accepted_user_id is null)),
  check (accepted_at is null or revoked_at is null),
  -- The person who accepted is a member of this organization, never of another.
  foreign key (organization_id, accepted_user_id) references memberships (organization_id, user_id)
);
-- At most one open invitation per person per organization; inviting again replaces it.
create unique index invitations_open_email_key on invitations (organization_id, lower(email))
  where accepted_at is null and revoked_at is null;
