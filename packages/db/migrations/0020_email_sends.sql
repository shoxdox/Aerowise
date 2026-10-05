-- Emails sent through a real mail provider (W3.1). One row per idempotency key: the same
-- key always means the same message, so retries update this row instead of adding one.
-- "accepted" means the provider took the message; delivery_status is what its webhooks
-- said afterwards (delivered, bounced, complained...). The development outbox writes no rows.
create table email_sends (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  idempotency_key text not null,
  provider text not null,
  recipient text not null,
  subject text not null,
  status text not null check (status in ('sending', 'accepted', 'failed', 'needs_review')),
  attempts integer not null default 0,
  first_attempt_at timestamptz not null,
  last_attempt_at timestamptz not null,
  -- Set while an attempt may have reached the provider without our learning the outcome
  -- (a timeout, a crash, a 5xx). Past the provider's idempotency window, such a send is
  -- looked up at the provider before it is tried again.
  uncertain_since timestamptz,
  provider_message_id text,
  accepted_at timestamptz,
  response jsonb not null default '{}',
  error text,
  delivery_status text check (delivery_status in ('delayed', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')),
  delivery_detail text,
  delivery_updated_at timestamptz,
  unique (organization_id, id),
  unique (organization_id, idempotency_key),
  check ((status = 'accepted') = (accepted_at is not null))
);
create unique index email_sends_provider_message_idx on email_sends (provider, provider_message_id) where provider_message_id is not null;

-- What the provider's webhooks reported, verified and kept as received. Append-only.
create table email_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  email_send_id uuid not null,
  provider text not null,
  provider_event_id text not null,
  type text not null check (type in ('sent', 'delayed', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')),
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  detail text,
  payload jsonb not null default '{}',
  unique (organization_id, id),
  unique (provider, provider_event_id),
  foreign key (organization_id, email_send_id) references email_sends (organization_id, id)
);
create index email_events_send_idx on email_events (organization_id, email_send_id, occurred_at);
