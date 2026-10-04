-- Filing readiness for a controlled pilot: provider credentials, reviewed authority
-- assignment with evidence, authority-specific identifiers, contract filings, immutable
-- submission packages, complaint and monitoring responses, customer delivery records
-- and corrected report versions.

-- Licenses and registrations held by people who work for the provider. One person can
-- hold several (a licensed maintenance provider who also inspects), each its own row.
create table provider_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  -- The person's sign-in, when they have one. The holder's name is kept either way.
  user_id uuid references users (id),
  holder_name text not null,
  kind text not null check (kind in ('tceq_maintenance_provider', 'tceq_maintenance_technician', 'tceq_installer', 'other')),
  number text not null,
  expires_on date,
  -- When and where someone checked the number (for example the TCEQ license search).
  verified_on date,
  verification_source text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, kind, number),
  check ((verified_on is null) = (verification_source is null))
);
create index provider_credentials_user_idx on provider_credentials (organization_id, user_id);

-- The licensed maintenance provider responsible for the organization's filings.
alter table organizations add column responsible_credential_id uuid;
alter table organizations add foreign key (id, responsible_credential_id) references provider_credentials (organization_id, id);

-- Every authority choice made by hand for a site, with what it was based on. Append-only:
-- a change is a new row, and the site points at the current one.
create table site_authority_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  -- null puts the site back on automatic matching by county.
  jurisdiction_id uuid references jurisdictions (id),
  evidence_kind text check (evidence_kind in ('authority_map', 'authority_determination', 'permit_record', 'other')),
  evidence_reference text,
  evidence_note text,
  assigned_by uuid references users (id),
  assigned_at timestamptz not null,
  unique (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  check (jurisdiction_id is null or (evidence_kind is not null and evidence_reference is not null))
);
create trigger site_authority_assignments_immutable before update or delete on site_authority_assignments
  for each row execute function reject_change();
alter table sites add column authority_assignment_id uuid;
alter table sites add foreign key (organization_id, authority_assignment_id) references site_authority_assignments (organization_id, id);

-- Numbers an authority gives a property (LCRA's OSSF application number, for example),
-- separate from the generic permit number on the site.
create table site_authority_identifiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  site_id uuid not null,
  jurisdiction_id uuid not null references jurisdictions (id),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  value text not null check (length(value) between 1 and 100),
  source_note text,
  updated_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, site_id, jurisdiction_id, kind),
  foreign key (organization_id, site_id) references sites (organization_id, id)
);

-- A signed contract uploaded by the office (paper contracts signed outside Aerowise).
-- Contracts renewed in Aerowise already have their signed_documents PDF.
create table contract_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  contract_id uuid not null,
  filename text not null,
  storage_key text not null,
  content_type text not null default 'application/pdf',
  byte_size integer not null check (byte_size > 0),
  sha256 text not null,
  signed_on date,
  uploaded_by uuid references users (id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, contract_id) references contracts (organization_id, id)
);
create trigger contract_documents_immutable before update or delete on contract_documents
  for each row execute function reject_change();

-- Filings are now of two kinds: an inspection report (as before) or a signed contract.
alter table filings add column kind text not null default 'inspection_report' check (kind in ('inspection_report', 'contract'));
alter table filings alter column inspection_id drop not null;
alter table filings alter column template_id drop not null;
alter table filings add column contract_id uuid;
alter table filings add foreign key (organization_id, contract_id) references contracts (organization_id, id);
-- The exact signed document a contract filing is for.
alter table filings add column signed_document_id uuid;
alter table filings add foreign key (organization_id, signed_document_id) references signed_documents (organization_id, id);
alter table filings add column contract_document_id uuid;
alter table filings add foreign key (organization_id, contract_document_id) references contract_documents (organization_id, id);
-- Which event the deadline was counted from, in words, so nobody has to guess.
alter table filings add column deadline_basis text;
-- What the office saw that showed the authority received or accepted it.
alter table filings add column confirmation_evidence jsonb;
alter table filings add constraint filings_kind_inspection check ((kind = 'inspection_report') = (inspection_id is not null and template_id is not null));
alter table filings add constraint filings_kind_contract check ((kind = 'contract') = (contract_id is not null));
create unique index filings_contract_idx on filings (organization_id, contract_id) where contract_id is not null;

-- The exact package sent (or handed to the office to file) for one submission of a filing:
-- recipient, message, cover sheet values and every document with its hash. Retries of the
-- same submission send this package and nothing else; a resubmission gets a new one.
create table submission_packages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  filing_id uuid not null,
  submission_no integer not null check (submission_no > 0),
  jurisdiction_id uuid not null references jurisdictions (id),
  ruleset_id uuid not null references jurisdiction_rulesets (id),
  method text not null,
  recipient text,
  subject text not null,
  body text not null,
  fields jsonb not null,
  documents jsonb not null,
  manifest_sha256 text not null,
  created_at timestamptz not null,
  unique (organization_id, id),
  unique (filing_id, submission_no),
  foreign key (organization_id, filing_id) references filings (organization_id, id)
);
create trigger submission_packages_immutable before update or delete on submission_packages
  for each row execute function reject_change();
alter table filing_attempts add column package_id uuid;
alter table filing_attempts add foreign key (organization_id, package_id) references submission_packages (organization_id, id);
alter table filing_attempts add column recipient text;

-- Corrected reports are new versions linked to the one they replace; nothing is overwritten.
alter table reports add column supersedes_report_id uuid;
alter table reports add foreign key (organization_id, supersedes_report_id) references reports (organization_id, id);
alter table reports add column correction_reason text;
alter table reports add column corrected_by uuid references users (id);
alter table reports add constraint reports_correction_check check ((version = 1) = (supersedes_report_id is null) and (supersedes_report_id is null) = (correction_reason is null));

-- Service requests: where they came from, when, and the office's review of whether the
-- authority must hear about them (a homeowner complaint or an electronic monitoring
-- notice), with the response that answered them.
alter table service_requests add column source text not null default 'portal' check (source in ('portal', 'office'));
alter table service_requests add column received_at timestamptz;
update service_requests set received_at = created_at;
alter table service_requests alter column received_at set not null;
alter table service_requests add column report_classification text check (report_classification in ('owner_complaint', 'monitoring_notice', 'not_reportable'));
alter table service_requests add column classification_note text;
alter table service_requests add column classified_by uuid references users (id);
alter table service_requests add column classified_at timestamptz;
alter table service_requests add column response_action text;
alter table service_requests add column responded_at timestamptz;
alter table service_requests add column response_job_id uuid;
alter table service_requests add foreign key (organization_id, response_job_id) references jobs (organization_id, id);
alter table service_requests add column response_recorded_by uuid references users (id);
alter table service_requests add constraint service_requests_classified_check check ((report_classification is null) = (classified_at is null));
alter table service_requests add constraint service_requests_response_check check ((responded_at is null) = (response_action is null));
create index service_requests_site_idx on service_requests (organization_id, site_id, received_at);

-- Documents sent to customers (never to an authority; authority sends are filing attempts).
-- "accepted" means the mail provider took it, not that the customer read it.
create table customer_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null,
  site_id uuid,
  document_kind text not null check (document_kind in ('inspection_report', 'signed_agreement')),
  report_id uuid,
  signed_document_id uuid,
  channel text not null check (channel in ('email')),
  recipient text not null,
  document_sha256 text not null,
  idempotency_key text not null,
  status text not null check (status in ('accepted', 'failed')),
  attempted_at timestamptz not null,
  transport_response jsonb not null default '{}',
  error text,
  requested_by uuid references users (id),
  unique (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, report_id) references reports (organization_id, id),
  foreign key (organization_id, signed_document_id) references signed_documents (organization_id, id),
  check ((document_kind = 'inspection_report') = (report_id is not null)),
  check ((document_kind = 'signed_agreement') = (signed_document_id is not null))
);
-- One accepted send per idempotency key; failed tries are kept beside it.
create unique index customer_deliveries_once_idx on customer_deliveries (organization_id, idempotency_key) where status = 'accepted';
create index customer_deliveries_report_idx on customer_deliveries (organization_id, report_id);
