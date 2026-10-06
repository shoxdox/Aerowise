-- Organization settings: the company's logo (shown on inspection reports) and the
-- counties it serves. The logo is stored under a key made from its SHA-256, so a report
-- that names it keeps showing the same image after the logo is replaced.

alter table organizations add column logo_storage_key text;
alter table organizations add column logo_content_type text
  check (logo_content_type in ('image/png', 'image/jpeg'));
alter table organizations add check ((logo_storage_key is null) = (logo_content_type is null));
alter table organizations add column service_counties text[] not null default '{}';
