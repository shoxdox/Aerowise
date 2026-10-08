-- SW-5 part 1: estimates (service workflows plan §3.3–§3.5, §3.8). An estimate is drafted by
-- the office, sent as a frozen version, and accepted by the homeowner with a signature (or
-- recorded as accepted by the office from a paper or phone approval). Acceptance creates its
-- work order exactly once. Deposits come in part 2.

alter table organizations add column next_estimate_number integer not null default 1001 check (next_estimate_number > 0);

create table estimates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  -- Per company, gapless, shown as EST-1001.
  number integer not null,
  customer_id uuid not null,
  site_id uuid not null,
  -- The kind of work its work order gets; the company's repair kind when not chosen.
  work_type_id uuid,
  title text not null check (length(trim(title)) between 1 and 200),
  status text not null default 'draft' check (status in ('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'void', 'cancelled')),
  -- The version being drafted, or the last one sent.
  current_version integer not null default 1 check (current_version >= 1),
  -- The draft's terms; each sent version keeps its own copy.
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 2000),
  discount_cents integer not null default 0 check (discount_cents between 0 and 100000000),
  terms_text text not null default '' check (length(terms_text) <= 10000),
  expires_on date,
  source_kind text not null default 'office' check (source_kind in ('office', 'inspection_issue', 'portal_request')),
  source_id uuid,
  sent_at timestamptz,
  viewed_at timestamptz,
  -- Acceptance: the version, the homeowner's signed document or the office's evidence.
  accepted_version integer,
  accepted_at timestamptz,
  acceptance_kind text check (acceptance_kind in ('signature', 'office_recorded')),
  accepted_document_id uuid,
  office_evidence text check (office_evidence is null or length(trim(office_evidence)) between 1 and 4000),
  accepted_by uuid references users (id),
  accepted_selection jsonb,
  work_order_id uuid,
  declined_at timestamptz,
  declined_reason text,
  expired_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, number),
  check ((source_kind = 'office') = (source_id is null)),
  -- Accepted (and cancelled after acceptance) estimates say how and when, and have their work order.
  check ((accepted_at is not null) = (accepted_version is not null and acceptance_kind is not null)),
  check (status not in ('accepted', 'cancelled') or (accepted_at is not null and work_order_id is not null)),
  check (acceptance_kind is distinct from 'signature' or accepted_document_id is not null),
  check (acceptance_kind is distinct from 'office_recorded' or (office_evidence is not null and accepted_document_id is null)),
  check ((status = 'declined') = (declined_at is not null)),
  check ((status = 'expired') = (expired_at is not null)),
  check ((status = 'void') = (voided_at is not null and void_reason is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null)),
  check (status = 'draft' or sent_at is not null or acceptance_kind = 'office_recorded'),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, work_type_id) references work_types (organization_id, id),
  foreign key (organization_id, work_order_id) references work_orders (organization_id, id)
);
-- Accepting twice finds the first acceptance; one estimate per work order.
create unique index estimates_accepted_document on estimates (accepted_document_id) where accepted_document_id is not null;
create unique index estimates_work_order on estimates (organization_id, work_order_id) where work_order_id is not null;
-- One live estimate per inspection issue or service request: creating twice finds the first.
create unique index estimates_one_live_per_source on estimates (organization_id, source_kind, source_id)
  where source_id is not null and status not in ('declined', 'expired', 'void', 'cancelled');
create index estimates_status_idx on estimates (organization_id, status, created_at desc);
create index estimates_customer_idx on estimates (organization_id, customer_id, created_at desc);

-- The draft's lines. A sent version keeps its own snapshot in estimate_versions.
create table estimate_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  estimate_id uuid not null,
  position integer not null check (position >= 1),
  description text not null check (length(trim(description)) between 1 and 500),
  -- Thousandths, like work order lines: 1.5 hours is 1500.
  quantity_milli integer not null check (quantity_milli between 1 and 10000000),
  unit_price_cents integer not null check (unit_price_cents between 0 and 100000000),
  taxable boolean not null default false,
  -- An optional line the homeowner may add or leave out; selected_by_default is its starting state.
  optional boolean not null default false,
  selected_by_default boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, estimate_id) references estimates (organization_id, id) on delete cascade
);
create index estimate_lines_estimate_idx on estimate_lines (organization_id, estimate_id, position);

-- What was sent: written once at sending and never changed.
create table estimate_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  estimate_id uuid not null,
  version integer not null check (version >= 1),
  -- [{id, description, quantityMilli, unitPriceCents, taxable, optional, selectedByDefault, amountCents}]
  lines jsonb not null,
  tax_rate_bps integer not null,
  discount_cents integer not null,
  -- With the default selection: {subtotalCents, discountCents, taxableCents, taxCents, totalCents}.
  totals jsonb not null,
  terms_text text not null,
  expires_on date,
  -- SHA-256 of the canonical JSON of the snapshot, as signed documents hash theirs.
  content_sha256 text not null,
  sent_at timestamptz not null,
  sent_by uuid references users (id),
  unique (organization_id, id),
  unique (estimate_id, version),
  foreign key (organization_id, estimate_id) references estimates (organization_id, id)
);

create or replace function estimate_versions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'sent estimate versions are never changed';
end $$;
create trigger estimate_versions_immutable before update or delete on estimate_versions
  for each row execute function estimate_versions_immutable();

-- The estimate's timeline: created, sent, viewed, revised, accepted, declined, expired,
-- converted, voided, cancelled. Append-only.
create table estimate_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null,
  estimate_id uuid not null,
  event_type text not null,
  summary text not null,
  actor_user_id uuid references users (id),
  details jsonb not null default '{}',
  occurred_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, estimate_id) references estimates (organization_id, id)
);
create index estimate_events_estimate_idx on estimate_events (organization_id, estimate_id, seq);
create or replace function estimate_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'estimate_events rows are immutable';
end $$;
create trigger estimate_events_append_only before update or delete on estimate_events
  for each row execute function estimate_events_append_only();

-- The homeowner's links. Only a hash is kept, like portal links; each email makes its own link
-- so a resend never breaks the link in an earlier email.
create table estimate_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  estimate_id uuid not null,
  token_hash bytea not null unique,
  source text not null check (source in ('email', 'office')),
  sent_to text,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, estimate_id) references estimates (organization_id, id)
);
create index estimate_links_estimate_idx on estimate_links (organization_id, estimate_id);

-- An estimate acceptance is a signed document about an estimate.
alter table signed_documents add column estimate_id uuid;
alter table signed_documents add foreign key (organization_id, estimate_id) references estimates (organization_id, id);
alter table signed_documents add constraint signed_documents_estimate_check check ((kind = 'estimate_acceptance') = (estimate_id is not null));
alter table estimates add foreign key (organization_id, accepted_document_id) references signed_documents (organization_id, id);
