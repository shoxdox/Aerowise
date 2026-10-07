-- STG-08: where a demo request alert went once accepted. "outbox" is the local file outbox
-- of a development, staging or demo deployment (nobody received it); "provider" is a mail
-- provider. /admin says "Emailed" only for the second. Alerts sent before this are unknown.
alter table demo_requests add column notify_delivery text check (notify_delivery in ('outbox', 'provider'));
