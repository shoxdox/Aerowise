-- Deleting an organization's data on request (a platform admin, from /admin). Every
-- tenant row goes; the organization row stays as a tombstone so the platform audit log,
-- which records the deletion, keeps pointing at it.
alter table organizations add column data_deleted_at timestamptz;
alter table organizations add column data_deleted_by uuid references platform_admins (id);
alter table organizations add check ((data_deleted_at is null) = (data_deleted_by is null));
