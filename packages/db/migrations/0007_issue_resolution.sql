-- Closing out issues found on inspections, from the office's exception inbox.
alter table issues add column resolved_at timestamptz;
alter table issues add column resolved_by uuid references users (id);
alter table issues add column resolution text;
alter table issues add constraint issues_resolution_check check (status <> 'resolved' or (resolved_at is not null and resolution is not null));
create index inspections_invalid_idx on inspections (organization_id) where status = 'draft' and validation_status = 'invalid';
