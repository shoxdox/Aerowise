-- Renewals and e-signatures.
--
-- A renewal offers the next term of a contract to the homeowner through one link: they
-- confirm their contact details, pick add-ons, sign and pay. Signing freezes exactly what
-- they agreed to into a signed_documents row that can never change. Once paid (or at
-- signing, when the provider bills later), the renewal activates: the next contract and
-- its visits are created, and the old contract stays as history.

alter table organizations
  -- Contracts ending within this many days get a renewal.
  add column renewal_window_days integer not null default 60 check (renewal_window_days between 14 and 180),
  -- Off until the office turns it on, so connecting an existing book of contracts never
  -- emails every customer at once.
  add column renewal_auto_send boolean not null default false,
  -- 'pay_to_activate': the next term starts once the renewal invoice is paid.
  -- 'invoice': the next term starts at signing and the invoice is paid on its terms.
  add column renewal_payment text not null default 'pay_to_activate' check (renewal_payment in ('pay_to_activate', 'invoice')),
  -- The agreement text customers sign. Null uses the built-in default.
  add column renewal_terms text;

-- Extras a customer can add when they renew (a riser lid, an alarm check, chlorine).
create table renewal_addons (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name text not null,
  description text,
  price_cents integer not null check (price_cents >= 0),
  taxable boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table renewals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  -- The contract being renewed.
  contract_id uuid not null,
  site_id uuid not null,
  customer_id uuid not null,
  status text not null default 'upcoming' check (status in (
    'upcoming', 'sent', 'viewed', 'signed', 'payment_pending', 'paid', 'activated', 'declined', 'expired', 'needs_review'
  )),
  -- The homeowner's link. A bearer secret like a pay link.
  public_token text not null unique,
  -- Bumped whenever the office changes the offer, so nobody signs terms they did not see.
  version integer not null default 1 check (version >= 1),
  -- The term on offer, copied like a contract copies its plan.
  plan_id uuid,
  plan_name text not null,
  term_months integer not null check (term_months between 1 and 60),
  visits_per_term integer not null check (visits_per_term between 1 and 24),
  price_cents integer not null check (price_cents >= 0),
  billing_frequency text not null check (billing_frequency in ('annual', 'semiannual', 'quarterly', 'monthly')),
  service_type text not null,
  auto_renew boolean not null default false,
  start_on date not null,
  end_on date not null,
  -- What the customer chose and changed when signing.
  selected_addons jsonb not null default '[]',
  customer_updates jsonb not null default '{}',
  sent_at timestamptz,
  send_count integer not null default 0,
  -- The last automatic reminder, as days before the contract ends (30, then 7).
  last_reminder_days integer,
  viewed_at timestamptz,
  signed_at timestamptz,
  paid_at timestamptz,
  activated_at timestamptz,
  declined_at timestamptz,
  decline_reason text,
  expired_at timestamptz,
  review_reason text,
  signed_document_id uuid,
  invoice_id uuid,
  new_contract_id uuid,
  created_by uuid references users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  check (end_on >= start_on),
  check ((status = 'activated') = (activated_at is not null and new_contract_id is not null)),
  check ((status = 'declined') = (declined_at is not null)),
  check (status not in ('signed', 'payment_pending', 'paid') or signed_document_id is not null),
  check ((status = 'needs_review') = (review_reason is not null)),
  foreign key (organization_id, contract_id) references contracts (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, plan_id) references plans (organization_id, id),
  foreign key (organization_id, invoice_id) references invoices (organization_id, id),
  foreign key (organization_id, new_contract_id) references contracts (organization_id, id)
);
-- At most one renewal in progress per contract; a declined or expired one can be started again.
create unique index renewals_open_contract_idx on renewals (contract_id) where status not in ('declined', 'expired');
create index renewals_org_status_idx on renewals (organization_id, status, start_on);
create index renewals_invoice_idx on renewals (organization_id, invoice_id) where invoice_id is not null;

-- What a customer signed: the full agreement as shown, its hash, the signature and where
-- it came from. Never changes once written, except that its PDF is attached once.
create table signed_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  kind text not null check (kind in ('renewal_agreement')),
  renewal_id uuid,
  site_id uuid not null,
  customer_id uuid not null,
  title text not null,
  content jsonb not null,
  -- SHA-256 of the canonical JSON of content: what was agreed, byte for byte.
  content_sha256 text not null,
  signer_name text not null,
  signature_kind text not null check (signature_kind in ('typed', 'drawn')),
  -- PNG of a drawn signature, as a data URL.
  signature_image text,
  consent_text text not null,
  signed_at timestamptz not null,
  ip_address text,
  user_agent text,
  pdf_storage_key text,
  pdf_sha256 text,
  pdf_byte_size integer,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  check ((signature_kind = 'drawn') = (signature_image is not null)),
  check ((pdf_storage_key is null) = (pdf_sha256 is null)),
  foreign key (organization_id, renewal_id) references renewals (organization_id, id),
  foreign key (organization_id, site_id) references sites (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id)
);
create index signed_documents_site_idx on signed_documents (organization_id, site_id, signed_at desc);

create or replace function signed_documents_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'signed documents are never deleted';
  end if;
  if old.pdf_storage_key is null and new.pdf_storage_key is not null
     and (to_jsonb(new) - array['pdf_storage_key', 'pdf_sha256', 'pdf_byte_size']) = (to_jsonb(old) - array['pdf_storage_key', 'pdf_sha256', 'pdf_byte_size']) then
    return new;
  end if;
  raise exception 'signed documents cannot be changed';
end $$;
create trigger signed_documents_immutable before update or delete on signed_documents
  for each row execute function signed_documents_immutable();

alter table renewals add foreign key (organization_id, signed_document_id) references signed_documents (organization_id, id);

alter table contracts add column signed_document_id uuid;
alter table contracts add foreign key (organization_id, signed_document_id) references signed_documents (organization_id, id);

-- Lines of an issued invoice stay frozen, with one exception: a renewal invoice is issued
-- before the contract it pays for exists, so its line may be linked to that contract once,
-- when the renewal activates. Nothing the customer sees changes.
create or replace function invoice_lines_draft_only() returns trigger language plpgsql as $$
declare
  s text;
begin
  select status into s from invoices where id = coalesce(new.invoice_id, old.invoice_id);
  -- The invoice itself is gone (cascade from deleting a draft).
  if s is null then
    return coalesce(new, old);
  end if;
  if s <> 'draft' then
    if tg_op = 'UPDATE' and old.contract_id is null and new.contract_id is not null
       and (to_jsonb(new) - array['contract_id', 'installment', 'period_start', 'period_end'])
         = (to_jsonb(old) - array['contract_id', 'installment', 'period_start', 'period_end']) then
      return new;
    end if;
    raise exception 'lines of an issued invoice cannot change';
  end if;
  return coalesce(new, old);
end $$;

-- Renewals show on the site's compliance timeline.
alter table compliance_events add column renewal_id uuid;
alter table compliance_events add foreign key (organization_id, renewal_id) references renewals (organization_id, id);
