-- Full data exports: a zip of CSVs and documents an owner can download at any time,
-- including while the organization is read-only. Built by a worker task.
create table data_exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  status text not null default 'queued' check (status in ('queued', 'ready', 'failed')),
  requested_by uuid not null references users (id),
  requested_at timestamptz not null,
  finished_at timestamptz,
  storage_key text,
  byte_size integer,
  -- Rows per CSV file, e.g. [{"file": "customers.csv", "rows": 12}], and documents included.
  contents jsonb,
  error text,
  unique (organization_id, id),
  check (status <> 'ready' or (storage_key is not null and byte_size is not null and finished_at is not null))
);
create index data_exports_org_idx on data_exports (organization_id, requested_at desc);
