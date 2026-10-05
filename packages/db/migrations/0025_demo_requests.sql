-- W8.2: demo requests from the public marketing page. Platform-wide by design, like the
-- platform admin tables: a prospect is not an organization yet, so there is no
-- organization_id. Only platform admins read these, in /admin.

create table demo_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text not null,
  phone text,
  counties text,
  message text,
  status text not null default 'new' check (status in ('new', 'handled')),
  -- The email to Aerowise about this request: when it went out, or why it did not.
  notified_at timestamptz,
  notify_error text,
  created_at timestamptz not null default now()
);
create index demo_requests_created_idx on demo_requests (created_at desc);

-- Email to Aerowise itself (the demo request alert) belongs to no organization. Such a send
-- has a null organization_id; its idempotency key is unique among platform sends.
alter table email_sends alter column organization_id drop not null;
create unique index email_sends_platform_key_idx on email_sends (idempotency_key) where organization_id is null;
-- Its delivery events too. The composite key is not checked when organization_id is null,
-- so events also point at their send by id alone.
alter table email_events alter column organization_id drop not null;
alter table email_events add foreign key (email_send_id) references email_sends (id);
