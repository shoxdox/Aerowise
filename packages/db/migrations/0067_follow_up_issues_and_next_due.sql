-- Issues follow the work, and each site has one next due date.

-- An issue the server opens from an inspection's answers (an item marked Fail, pumping
-- needed) names the form item it is about, so the next inspection does not open it twice.
-- Null for issues a person raised.
alter table issues add column field_key text;

-- Finished work closes what it was for. Before this release, completing a work order left
-- its inspection issue and the customer's request open.
update issues x
set status = 'resolved',
    resolved_at = coalesce(wo.completed_at, wo.updated_at),
    resolution = 'Done: WO-' || wo.number || ' completed',
    updated_at = now()
from work_orders wo
where wo.organization_id = x.organization_id and wo.id = x.work_order_id
  and wo.status = 'completed' and x.status = 'open';

update service_requests r
set status = 'closed',
    closed_at = coalesce(wo.completed_at, wo.updated_at),
    resolution = 'Done: WO-' || wo.number || ' completed',
    updated_at = now()
from work_orders wo
where wo.organization_id = r.organization_id and wo.id = r.work_order_id
  and wo.status = 'completed' and r.status = 'open';

-- The site's next open inspection visit is due by the authority's date from its latest
-- inspection filing when the contract had it later; its window ends there too. Authorities
-- that count visits from the contract's start (Hays) keep the contract's calendar, and a latest
-- filing with no date yet (no authority known) moves nothing: an older one's date no longer counts.
with latest as (
  select distinct on (f.organization_id, f.site_id) f.organization_id, f.site_id, f.next_due_on,
         coalesce(r.rules -> 'service' ? 'contractVisits', false) as contract_visits
  from filings f
  left join jurisdiction_rulesets r on r.id = f.ruleset_id
  where f.kind = 'inspection_report'
  order by f.organization_id, f.site_id, f.created_at desc
), next_visit as (
  select distinct on (o.organization_id, o.site_id) o.id, l.next_due_on
  from service_obligations o
  join latest l on l.organization_id = o.organization_id and l.site_id = o.site_id
  where o.status = 'open' and o.service_type = 'aerobic_inspection' and l.next_due_on is not null and not l.contract_visits
  order by o.organization_id, o.site_id, o.due_on, o.id
)
update service_obligations o
set due_on = n.next_due_on,
    window_end = least(o.window_end, n.next_due_on),
    window_start = least(o.window_start, n.next_due_on),
    updated_at = now()
from next_visit n
where o.id = n.id and o.due_on > n.next_due_on;
