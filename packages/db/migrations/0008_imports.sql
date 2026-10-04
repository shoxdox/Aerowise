-- Importing customers and sites from a spreadsheet. The raw rows are kept so the preview
-- can be recomputed when the mapping changes; what each row becomes is derived on read.
create table imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  filename text not null,
  status text not null default 'preview' check (status in ('preview', 'committed', 'failed', 'discarded')),
  -- Column headers in file order (a list of strings).
  headers jsonb not null,
  -- Field name to column index, e.g. {"customerName": 0}. Field names are already camelCase.
  mapping jsonb not null,
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  error text,
  -- Counts of what a commit created: {"customers": n, "sites": n, "contracts": n}.
  result jsonb,
  unique (organization_id, id),
  check (status <> 'committed' or (committed_at is not null and result is not null))
);
create index imports_org_idx on imports (organization_id, created_at desc);

create table import_rows (
  organization_id uuid not null,
  import_id uuid not null,
  -- The row's number in the spreadsheet, header included, so it matches what the user sees.
  row_no integer not null,
  -- Cell values in column order (a list of strings).
  raw jsonb not null,
  -- The user's choice; null means the default for the row's status.
  include boolean,
  customer_id uuid,
  site_id uuid,
  contract_id uuid,
  primary key (import_id, row_no),
  foreign key (organization_id, import_id) references imports (organization_id, id) on delete cascade
);

alter table customers add column import_id uuid;
alter table customers add foreign key (organization_id, import_id) references imports (organization_id, id);
alter table sites add column import_id uuid;
alter table sites add foreign key (organization_id, import_id) references imports (organization_id, id);
create index sites_address_idx on sites (organization_id, lower(address_line1));
