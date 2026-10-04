-- 30 TAC 285.7 follow-ups: the licensed maintenance provider signs each authority report,
-- each contract filing knows which 285.7 deadline applies to it, and ending a contract
-- records the written notice the provider owes the authority.

-- A licensed maintenance provider's signature on one report version (285.7(b)(3)): the
-- authority copy and the customer copy are each signed. The signed PDF is the report with the signature block added; the report
-- row itself is never changed. Append-only, one signature per report version.
create table report_signatures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  report_id uuid not null,
  signed_by uuid not null references users (id),
  -- The signer's own MP license, valid on the day they signed.
  credential_id uuid not null,
  typed_name text not null,
  statement text not null,
  signed_at timestamptz not null,
  -- The unsigned report the signature covers.
  report_sha256 text not null,
  storage_key text not null,
  sha256 text not null,
  byte_size integer not null,
  -- Set when the signer is not the maintenance provider named for the site's contract: the
  -- MP they sign for and the documented delegation and supervision that allows it.
  on_behalf_of_credential_id uuid,
  delegation_note text,
  check ((on_behalf_of_credential_id is null) = (delegation_note is null)),
  foreign key (organization_id, on_behalf_of_credential_id) references provider_credentials (organization_id, id),
  unique (organization_id, id),
  unique (organization_id, report_id),
  foreign key (organization_id, report_id) references reports (organization_id, id),
  foreign key (organization_id, credential_id) references provider_credentials (organization_id, id)
);
create trigger report_signatures_immutable before update or delete on report_signatures
  for each row execute function reject_change();

-- Which 285.7 deadline a contract filing has:
--   initial_policy        the initial two-year service policy, due before the system is approved for use (285.7(c))
--   after_initial_policy  the first contract after it, 30 days before the policy expires (285.7(d)(2))
--   renewal               a later contract, at least 30 days before the current one expires (285.7(d)(2))
--   replacement           a new contract after one was discontinued, within 30 days after it ended (285.7(d)(3)(C))
-- filing_basis_on is the policy's expiry, the expiring contract's end or the termination
-- date. A contract renewed in Aerowise is a renewal of the one it follows, so these are
-- only recorded for the others.
alter table contracts
  add column filing_basis text check (filing_basis in ('initial_policy', 'after_initial_policy', 'renewal', 'replacement')),
  add column filing_basis_on date,
  add column filing_basis_note text,
  add column filing_basis_set_by uuid references users (id),
  add column filing_basis_set_at timestamptz,
  add check (filing_basis is null or filing_basis = 'initial_policy' or filing_basis_on is not null),
  add check ((filing_basis is null) = (filing_basis_set_at is null));

-- Ending a contract: who ended it, when service stops, and the written notice the provider
-- gives the authority and the manufacturer (and the owner, when the provider ends it) at
-- least 30 days before service stops (285.7(d)(3)(A) and (B)).
alter table contracts
  add column service_ends_on date,
  add column discontinued_by text check (discontinued_by in ('provider', 'owner')),
  add column notice_sent_on date,
  add column notice_note text,
  add column notice_recorded_by uuid references users (id),
  add check ((notice_sent_on is null) = (notice_recorded_by is null));

-- An ending contract covers its site only through its last day of service, so the next
-- contract can start the day after even before the daily sweep closes the old one.
alter table contracts drop constraint contracts_organization_id_site_id_daterange_excl;
alter table contracts add constraint contracts_live_term_excl exclude using gist (
  organization_id with =,
  site_id with =,
  daterange(start_on, greatest(start_on, least(end_on, coalesce(service_ends_on, end_on))), '[]') with &&
) where (status = 'active');

-- The maintenance provider named on the contract, who signs the site's reports by default.
-- Unset, it is the organization's responsible maintenance provider.
alter table contracts
  add column provider_credential_id uuid,
  add foreign key (organization_id, provider_credential_id) references provider_credentials (organization_id, id);
