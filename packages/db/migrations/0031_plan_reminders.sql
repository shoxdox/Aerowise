-- W4.4: reminders sent before a trial or design-partner period ends (14, 7 and 1 days
-- before). One row per organization, period end and threshold, so each goes out once even
-- when the worker runs every hour; a new end date (an extended trial) gets its own.

create table plan_reminders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  ends_on date not null,
  days_before integer not null check (days_before > 0),
  sent_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, ends_on, days_before)
);
