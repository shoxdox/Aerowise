-- Why a visit has no arrival location. The phone asked for its position when the technician
-- arrived; this says what it got back (recorded, or denied / unavailable / timeout /
-- unsupported), so a visit without GPS is reported to the office instead of being silently
-- null. Rows from before this column keep null: not asked.

alter table inspections add column location_status text
  check (location_status in ('recorded', 'denied', 'unavailable', 'timeout', 'unsupported'));
alter table work_records add column location_status text
  check (location_status in ('recorded', 'denied', 'unavailable', 'timeout', 'unsupported'));
