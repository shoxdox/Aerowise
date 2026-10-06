-- Undoing a committed import: what it created is deleted and the import is kept, marked
-- undone, with who did it and when (the audit log has the counts).
alter table imports drop constraint imports_status_check;
alter table imports add constraint imports_status_check check (status in ('preview', 'committed', 'failed', 'discarded', 'undone'));
alter table imports add column undone_at timestamptz;
alter table imports add column undone_by uuid references users (id);
alter table imports add check (status <> 'undone' or (committed_at is not null and undone_at is not null and undone_by is not null));
