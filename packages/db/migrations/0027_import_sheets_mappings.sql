-- Workbooks with several sheets. Every sheet that has a header and data is kept, so the
-- office can switch sheets in the preview without uploading again; an import saves the
-- rows of one sheet.
alter table imports add column sheets jsonb not null default '[]';
alter table imports add column sheet_index integer not null default 0 check (sheet_index >= 0);
-- detected, saved (the organization's saved column choices) or edited (changed on this import).
alter table imports add column mapping_source text not null default 'detected'
  check (mapping_source in ('detected', 'saved', 'edited'));
-- Imports made before sheets were kept had one sheet.
update imports set sheets = jsonb_build_array(jsonb_build_object(
  'name', 'Sheet 1',
  'headers', headers,
  'rows', (select count(*) from import_rows r where r.import_id = imports.id)
));

alter table import_rows add column sheet_index integer not null default 0;
alter table import_rows drop constraint import_rows_pkey;
alter table import_rows add primary key (import_id, sheet_index, row_no);

-- The column choices an organization made on its last saved import of each file layout,
-- offered on the next import. columns is a list of {"field", "header"} pairs (a list, not a
-- record keyed by header, so header text is never rewritten as a JSON key).
create table import_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  -- The file's normalized headers in order, joined with "|".
  header_key text not null,
  columns jsonb not null,
  import_id uuid not null,
  updated_by uuid not null references users (id),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, header_key),
  foreign key (organization_id, import_id) references imports (organization_id, id)
);
create index import_mappings_recent_idx on import_mappings (organization_id, updated_at desc);
