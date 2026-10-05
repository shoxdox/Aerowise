-- W8.3: each owner's acceptance of the terms of service and privacy policy, with the
-- document version and the time. A new version of a document is a new row; nothing is
-- ever changed or removed, so the table is the record of who agreed to what and when.

create table legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  user_id uuid not null references users (id),
  document text not null check (document in ('terms', 'privacy')),
  version text not null,
  accepted_at timestamptz not null,
  request_id text,
  unique (organization_id, id),
  unique (organization_id, user_id, document, version),
  foreign key (organization_id, user_id) references memberships (organization_id, user_id)
);
create index legal_acceptances_user_idx on legal_acceptances (organization_id, user_id, document, accepted_at);

create function reject_legal_acceptance_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'legal_acceptances is append-only';
end;
$$;
create trigger legal_acceptances_append_only before update or delete on legal_acceptances
  for each row execute function reject_legal_acceptance_mutation();
