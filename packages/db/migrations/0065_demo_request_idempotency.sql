-- A public form retry must reuse the saved request, even if its notification failed.
-- Nullable for existing requests and older clients; no prospect rows are rewritten.
alter table demo_requests add column submission_key uuid;
create unique index demo_requests_submission_key_idx on demo_requests (submission_key);
