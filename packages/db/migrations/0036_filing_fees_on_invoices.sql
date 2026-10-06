-- Filing fees on the homeowner's invoice (Justin, 2026-10-05): off unless the company turns
-- it on. When on, a contract installment invoice also bills the authority filing fees for
-- that site's sent filings, each once (a line on an invoice that is not void).
alter table organizations add column bill_filing_fees boolean not null default false;
alter table invoice_lines add column filing_id uuid;
alter table invoice_lines add foreign key (organization_id, filing_id) references filings (organization_id, id);
create index invoice_lines_filing_idx on invoice_lines (organization_id, filing_id) where filing_id is not null;
