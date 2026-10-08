-- SW-11: a filing may go by CSV export, where its package carries the authority's CSV for
-- the office to upload. Making the file never makes the filing sent: mark-sent (with its
-- evidence) does, and only the authority's acknowledgment confirms it.
alter table filings drop constraint filings_submission_method_check;
alter table filings add constraint filings_submission_method_check check (submission_method in ('email', 'manual_export', 'csv_export'));
