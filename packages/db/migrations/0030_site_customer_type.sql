-- "Commercial" belongs to the property, not the contract (Justin, 2026-10-05). A site says
-- whether it is residential or commercial; its authority's service interval and lab tests
-- follow the site. Contracts keep the type they were made under, copied from the site.
alter table sites add column customer_type text not null default 'residential' check (customer_type in ('residential', 'commercial'));

-- Until now the type came from the plan: a site whose latest contract was commercial is commercial.
update sites s set customer_type = 'commercial'
where exists (
  select 1 from contracts c
  where c.organization_id = s.organization_id and c.site_id = s.id and c.customer_type = 'commercial'
    and c.start_on = (select max(c2.start_on) from contracts c2 where c2.organization_id = s.organization_id and c2.site_id = s.id)
);
