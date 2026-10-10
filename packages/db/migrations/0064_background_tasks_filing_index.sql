-- The filing workflow looks up a filing's tasks by the filingId in their payload
-- (packages/compliance/src/filings.ts); with the queue no longer growing without bound but
-- still holding a month of finished tasks, that lookup gets an index of its own. The worker
-- prunes finished tasks every few minutes (packages/tasks/src/monitor.ts, pruneTasks).

create index background_tasks_filing_idx on background_tasks ((payload ->> 'filingId')) where payload ? 'filingId';
