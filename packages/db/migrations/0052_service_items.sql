-- SW-3: a small catalog of service items, fractional invoice quantities and one live
-- invoice per work order (service workflows plan §3.2, §3.6 and SW-3).

create table service_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name text not null check (length(trim(name)) between 1 and 200),
  description text check (description is null or length(description) <= 2000),
  unit text not null default 'each' check (unit in ('each', 'hour', 'gallon', 'foot', 'visit')),
  unit_price_cents integer not null check (unit_price_cents between 0 and 100000000),
  taxable boolean not null default false,
  category text check (category is null or category in ('pumping', 'repair', 'installation', 'maintenance', 'inspection_other', 'other')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
-- Names are unique among a company's active items, case-insensitively.
create unique index service_items_active_name on service_items (organization_id, lower(name)) where active;

-- Fractional quantities (hours, gallons) in thousandths. NULL on every existing line and on
-- every whole-number line, whose integer quantity stays authoritative, so their amounts,
-- PDFs and QuickBooks payloads never change.
alter table invoice_lines add column quantity_milli integer check (quantity_milli is null or quantity_milli between 1 and 10000000);
alter table invoice_lines add column service_item_id uuid;
alter table invoice_lines add foreign key (organization_id, service_item_id) references service_items (organization_id, id);
-- The old amount check, found by its definition rather than its generated name.
do $$
declare c text;
begin
  select conname into strict c from pg_constraint
  where conrelid = 'invoice_lines'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) = 'CHECK ((amount_cents = (quantity * unit_price_cents)))';
  execute format('alter table invoice_lines drop constraint %I', c);
end $$;
alter table invoice_lines add constraint invoice_lines_amount_check check (
  case when quantity_milli is null
    then amount_cents = quantity * unit_price_cents
    else amount_cents = round(quantity_milli::numeric * unit_price_cents / 1000)
  end
);

alter table work_order_lines add column service_item_id uuid;
alter table work_order_lines add foreign key (organization_id, service_item_id) references service_items (organization_id, id);

-- An invoice made from a work order. At most one that is not void per work order, so a
-- void allows a replacement and two concurrent requests still yield one.
alter table invoices add column work_order_id uuid;
alter table invoices add foreign key (organization_id, work_order_id) references work_orders (organization_id, id);
create unique index invoices_one_live_per_work_order on invoices (organization_id, work_order_id) where work_order_id is not null and status <> 'void';
