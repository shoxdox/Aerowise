-- The longest time between inspections that a site's own permit sets, where its authority
-- lets the permit decide (Hays County: "every four (4) months unless otherwise specified on
-- the permit"). Null: the authority's own interval. The note says where it was read.
alter table sites add column permit_interval_months integer check (permit_interval_months between 1 and 24);
alter table sites add column permit_interval_note text;
alter table sites add constraint sites_permit_interval_noted check (permit_interval_months is null or permit_interval_note is not null);
