-- Text messages: on-the-way, inspection done, report ready, renewal and payment reminders,
-- and the replies that come back. Texts go only to contacts who agreed to them (the
-- consent_sms flag on contacts) and never to a number that replied STOP.

-- Texting is off until the owner turns it on; then these kinds go automatically.
alter table organizations
  add column sms_enabled boolean not null default false,
  add column sms_kinds text[] not null default '{on_the_way,report_ready,renewal_reminder,payment_reminder}',
  -- The number texts come from. Replies to it find their organization by it.
  add column sms_from_number text unique;

-- When the technician said they were on the way.
alter table jobs add column on_the_way_at timestamptz;

-- Portal links can now be texted with a report-ready message.
alter table portal_links drop constraint portal_links_source_check;
alter table portal_links add constraint portal_links_source_check check (source in ('office', 'email', 'sms'));

create table sms_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  direction text not null check (direction in ('outbound', 'inbound')),
  kind text check (kind in ('on_the_way', 'inspection_completed', 'report_ready', 'renewal_reminder', 'payment_reminder')),
  customer_id uuid,
  contact_id uuid,
  -- The customer's number in E.164: who it went to, or who it came from.
  phone text,
  -- Links that open a customer's account are kept out of the stored copy.
  body text not null,
  status text not null check (status in ('sending', 'sent', 'delivered', 'failed', 'skipped', 'received')),
  skip_reason text check (skip_reason in ('no_phone', 'no_consent', 'opted_out')),
  attempts integer not null default 0,
  error_code text,
  error_message text,
  provider text,
  provider_message_id text unique,
  -- The record the text is about (job, inspection, report, renewal or invoice).
  related_type text,
  related_id uuid,
  -- The same key is the same text: a retried task never sends twice.
  dedupe_key text,
  sent_at timestamptz,
  delivered_at timestamptz,
  handled_at timestamptz,
  handled_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, dedupe_key),
  check ((direction = 'outbound') = (kind is not null)),
  check ((status = 'skipped') = (skip_reason is not null)),
  check ((direction = 'inbound') = (status = 'received')),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, contact_id) references contacts (organization_id, id) on delete set null (contact_id)
);
create index sms_messages_recent_idx on sms_messages (organization_id, created_at desc);
create index sms_messages_related_idx on sms_messages (organization_id, related_type, related_id);
create index sms_messages_unhandled_idx on sms_messages (organization_id, created_at) where direction = 'inbound' and handled_at is null;

-- Numbers that replied STOP (or that the carrier reports as unsubscribed). Only the
-- customer can undo it, by texting START.
create table sms_opt_outs (
  organization_id uuid not null references organizations (id),
  phone text not null,
  source text not null check (source in ('reply', 'carrier')),
  opted_out_at timestamptz not null default now(),
  primary key (organization_id, phone)
);
