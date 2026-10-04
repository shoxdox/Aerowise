-- QuickBooks Online sync.
--
-- One-way for now: Aerowise sends customers, invoices and payments to the provider's
-- QuickBooks company and never overwrites anything there without a person choosing to.
-- What was sent, and what QuickBooks said, is kept per record in quickbooks_links.

-- The provider's QuickBooks company. Tokens are encrypted (AES-256-GCM) before they are
-- stored; nothing here is ever sent to a browser.
create table quickbooks_connections (
  organization_id uuid primary key references organizations (id),
  -- 'test' is the built-in stand-in company used in development without Intuit keys.
  environment text not null check (environment in ('test', 'sandbox', 'production')),
  realm_id text not null,
  company_name text,
  access_token_enc text,
  refresh_token_enc text,
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  status text not null default 'connected' check (status in ('connected', 'needs_reauth', 'disconnected')),
  -- 'review' until the office has gone through the first-sync matches and committed them.
  setup_state text not null default 'review' check (setup_state in ('review', 'active')),
  -- Invoices issued before this date are not sent (they are likely in QuickBooks already).
  sync_from date not null,
  -- The QuickBooks item for invoice lines that are not a mapped plan's installment.
  default_item_id text,
  default_item_name text,
  -- When the first-sync review last read QuickBooks' customers, and how many it found.
  review_fetched_at timestamptz,
  review_remote_count integer,
  -- Changes in QuickBooks are read from here on (QuickBooks change data capture).
  changes_since timestamptz,
  -- One sync run at a time per company.
  sync_lock_until timestamptz,
  last_sync_started_at timestamptz,
  last_sync_finished_at timestamptz,
  last_sync_error text,
  connected_by uuid references users (id),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  updated_at timestamptz not null default now()
);

-- One row per Aerowise record that is (or will be) in QuickBooks: customers, invoices and
-- payments. A plan's row records which QuickBooks item its invoice lines use.
create table quickbooks_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  entity_type text not null check (entity_type in ('customer', 'plan', 'invoice', 'payment')),
  entity_id uuid not null,
  -- QuickBooks' Id for the record and its SyncToken (its version, needed for updates).
  external_id text,
  sync_token text,
  status text not null check (status in ('new', 'queued', 'syncing', 'synced', 'conflict', 'failed', 'ignored')),
  -- What a person has to decide (see QuickBooksConflict in packages/domain).
  conflict_kind text check (conflict_kind in ('ambiguous_match', 'changed_in_both', 'deleted_in_quickbooks', 'item_missing', 'tax_mapping_missing', 'payment_mismatch', 'duplicate_number')),
  conflict jsonb,
  -- First-sync review only: what the office chose for this customer.
  decision text check (decision in ('match', 'create', 'skip')),
  -- A person chose to send this record despite its last conflict; cleared once sent.
  force boolean not null default false,
  sync_error text,
  retry_count integer not null default 0,
  next_attempt_at timestamptz,
  last_synced_at timestamptz,
  -- When the Aerowise record last changed in a way QuickBooks would see.
  last_source_modified_at timestamptz,
  -- Hash of exactly what was last sent, so a local change is noticed without timestamps.
  pushed_hash text,
  -- QuickBooks' MetaData.LastUpdateTime as of the last sync: a newer one means it changed there.
  remote_updated_at text,
  -- Invoices: 'open' or 'void' in QuickBooks.
  remote_state text,
  -- Bumped when a record is sent again as new (after it was deleted in QuickBooks), so the
  -- request id QuickBooks uses to drop duplicate creates changes with it.
  generation integer not null default 1,
  mapping_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, entity_type, entity_id),
  check ((status = 'conflict') = (conflict_kind is not null)),
  check (status not in ('synced') or external_id is not null)
);
-- One Aerowise record per QuickBooks record. Plans are the exception: several plans may
-- use the same QuickBooks item.
create unique index quickbooks_links_external_idx on quickbooks_links (organization_id, entity_type, external_id) where entity_type <> 'plan';
create index quickbooks_links_status_idx on quickbooks_links (organization_id, status, entity_type);
create index quickbooks_links_retry_idx on quickbooks_links (next_attempt_at) where status = 'failed' and next_attempt_at is not null;

-- Development only: the built-in stand-in for a QuickBooks company, so the whole flow
-- works without Intuit keys. Never used in production.
create table quickbooks_test_companies (
  realm_id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
