-- Password reset links. A login (users row) is shared by every organization the person
-- belongs to, so these belong to the user, not to an organization. Only a SHA-256 hash
-- of the token is stored. A link works once, for an hour; a successful reset also
-- spends every other open link of that user and signs them out everywhere.

create table password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  token_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index password_reset_tokens_user_idx on password_reset_tokens (user_id) where used_at is null;

-- Deactivating someone is per organization (their membership); record when and by whom.
alter table memberships add column deactivated_at timestamptz;
alter table memberships add column deactivated_by uuid references users (id);
