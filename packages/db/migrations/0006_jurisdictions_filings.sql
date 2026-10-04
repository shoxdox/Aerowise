-- Jurisdictions, their versioned rulesets, and filings with every submission attempt.

-- Reporting authorities. Shared by every organization: a county's rules are the same for
-- all providers. Rows are loaded from packages/compliance/rulesets.
create table jurisdictions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  state text not null,
  authority_name text not null,
  type text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One row per published version of a jurisdiction's rules. A published version never
-- changes, so every filing can be reproduced from the version it recorded.
create table jurisdiction_rulesets (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null references jurisdictions (id),
  version integer not null check (version > 0),
  effective_from date not null,
  effective_to date,
  rules jsonb not null,
  sha256 text not null,
  source_reference text not null,
  status text not null default 'published' check (status in ('published', 'retired')),
  created_at timestamptz not null default now(),
  unique (jurisdiction_id, version),
  check (effective_to is null or effective_to > effective_from)
);
create trigger jurisdiction_rulesets_immutable before update or delete on jurisdiction_rulesets
  for each row execute function reject_change();

-- Set by hand when a site's county alone does not decide its authority.
alter table sites add column jurisdiction_id uuid references jurisdictions (id);

-- One filing per completed inspection. It records the exact jurisdiction, ruleset,
-- template and submission method versions it was made under.
create table filings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  inspection_id uuid not null,
  site_id uuid not null,
  jurisdiction_id uuid references jurisdictions (id),
  ruleset_id uuid references jurisdiction_rulesets (id),
  ruleset_version integer,
  template_id uuid not null references inspection_templates (id),
  status text not null check (status in ('pending', 'ready', 'queued', 'submitting', 'sent', 'confirmed', 'failed', 'rejected', 'needs_review')),
  state_machine_version integer not null,
  submission_method text check (submission_method in ('email', 'manual_export')),
  method_version text,
  -- Bumped only by a deliberate resubmission (after a rejection). Retries of the same
  -- submission reuse it, which is what keeps a retry from sending a second email.
  submission_no integer not null default 1,
  report_id uuid,
  deadline_on date,
  warning_days integer not null default 0,
  next_due_on date,
  sent_at timestamptz,
  confirmed_at timestamptz,
  confirmation_reference text,
  confirmation_note text,
  confirmed_by uuid references users (id),
  proof jsonb,
  rejection_reason text,
  review_reason text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, inspection_id),
  foreign key (organization_id, inspection_id) references inspections (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, report_id) references reports (organization_id, id),
  -- SENT and CONFIRMED stay distinct: each needs its own evidence.
  check (status not in ('sent', 'confirmed') or (sent_at is not null and proof is not null)),
  check (status <> 'confirmed' or (confirmed_at is not null and confirmation_reference is not null))
);
create index filings_status_idx on filings (organization_id, status, deadline_on);
create index filings_site_idx on filings (organization_id, site_id, created_at desc);

-- Every try at sending a filing, automatic or by hand. Append-and-finish only.
create table filing_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  filing_id uuid not null,
  attempt_no integer not null,
  submission_no integer not null,
  method text not null,
  idempotency_key text not null,
  status text not null check (status in ('started', 'succeeded', 'failed')),
  started_at timestamptz not null,
  finished_at timestamptz,
  response jsonb not null default '{}',
  error text,
  unique (organization_id, id),
  unique (filing_id, attempt_no),
  foreign key (organization_id, filing_id) references filings (organization_id, id)
);

alter table compliance_events add column filing_id uuid;
alter table compliance_events add foreign key (organization_id, filing_id) references filings (organization_id, id);
