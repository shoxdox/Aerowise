-- The public demo (W10.2): each visitor gets their own demo company, with nobody's password,
-- that ends after a day. The shared demo company and prospect demos have no end here.
alter table organizations add column demo_expires_at timestamptz;
alter table organizations add constraint organizations_demo_expiry check (demo_expires_at is null or demo);

-- Who started a visitor demo, for the limits on how many one person (an IP address, kept
-- only as a keyed hash) can start. Not tied to the company: the record outlives it, and
-- the nightly reset empties it.
create table demo_visits (
  id uuid primary key default gen_random_uuid(),
  requester_hash text not null,
  created_at timestamptz not null default now()
);
create index demo_visits_requester on demo_visits (requester_hash, created_at);
