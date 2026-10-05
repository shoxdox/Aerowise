-- Per-ruleset service intervals (W6.1). An authority can require commercial systems to be
-- serviced more often than residential ones, so a contract and a renewal offer carry the
-- customer type of the plan they were copied from, as they already carry its term and visits.
alter table contracts add column customer_type text not null default 'residential' check (customer_type in ('residential', 'commercial'));
alter table renewals add column customer_type text not null default 'residential' check (customer_type in ('residential', 'commercial'));

update contracts c set customer_type = p.customer_type
from plans p
where p.organization_id = c.organization_id and p.id = c.plan_id;

update renewals r set customer_type = p.customer_type
from plans p
where p.organization_id = r.organization_id and p.id = r.plan_id;
