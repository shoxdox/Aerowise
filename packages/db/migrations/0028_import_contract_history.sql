-- Contracts imported mid-term. A visit window the provider already covered before Aerowise
-- (up to the last inspection in the spreadsheet) is completed by the import; this names the
-- import that did it, so those completions can be told apart from inspections done here
-- and undone with the import.
alter table service_obligations add column completed_by_import uuid;
alter table service_obligations add foreign key (organization_id, completed_by_import) references imports (organization_id, id);
alter table service_obligations add check (completed_by_import is null or status in ('completed', 'cancelled'));
