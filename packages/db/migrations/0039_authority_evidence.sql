-- W12.1: dated evidence about a reporting authority's requirements, and the answer it
-- gives to each open question. Platform-wide by design, like jurisdictions themselves:
-- a county's rules are the same for every provider, and only platform admins record or
-- read this. No organization_id, so no tenant can see or change it.
--
-- Recording evidence never changes a ruleset. Rules change only by a new, reviewed
-- ruleset version (W6.5); these rows are what that review reads. Both tables are
-- append-only: a correction is a new record that says what it corrects.

create table authority_evidence (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_id uuid not null references jurisdictions (id),
  -- The newest published ruleset version when the evidence was recorded.
  ruleset_version integer not null check (ruleset_version > 0),
  kind text not null check (kind in ('call', 'email', 'letter', 'meeting', 'published_rule', 'permit', 'signed_contract', 'accepted_report')),
  obtained_on date not null,
  -- Who gave the answer or the document: a person at the authority, or the provider.
  contact_name text,
  contact_role text,
  contact_organization text,
  contact_detail text,
  -- Where the evidence is kept: URLs with page numbers, file names, an email's subject and date.
  "references" text[] not null check (cardinality("references") between 1 and 20),
  note text,
  recorded_by uuid not null references platform_admins (id),
  created_at timestamptz not null default now(),
  -- An authority's own answer always names who gave it.
  check (kind not in ('call', 'email', 'letter', 'meeting') or (contact_name is not null and contact_organization is not null))
);
create index authority_evidence_jurisdiction_idx on authority_evidence (jurisdiction_id, obtained_on desc);

create table authority_evidence_answers (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references authority_evidence (id),
  position integer not null check (position >= 0),
  -- The exact question asked, as worded to the authority or as read in the document.
  question text not null,
  -- The open question in the ruleset this answers, word for word, when it answers one.
  unresolved_item text,
  topic text not null check (topic in ('report_channel', 'contract_destination', 'report_format', 'signature', 'receipt_acceptance', 'deadline', 'schedule', 'lab_tests', 'required_fields', 'assignment', 'fees', 'effective_date', 'registration', 'other')),
  -- The ruleset field the answer is about (e.g. filing.deadlineDays), when there is one.
  field text,
  answer text not null,
  outcome text not null check (outcome in ('confirms', 'partial', 'contradicts', 'no_answer')),
  unique (evidence_id, position)
);
create index authority_evidence_answers_evidence_idx on authority_evidence_answers (evidence_id);

create trigger authority_evidence_immutable before update or delete on authority_evidence
  for each row execute function reject_change();
create trigger authority_evidence_answers_immutable before update or delete on authority_evidence_answers
  for each row execute function reject_change();
