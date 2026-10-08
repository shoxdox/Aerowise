-- SW-7: system categories, conventional service and installation work (service workflows plan §5).
-- Nothing here touches aerobic reporting: a conventional site or an installation never gets an
-- obligation, filing or authority report from this migration or from the work recorded on it.

-- ---- What kind of system it is ----

-- Nullable, with no default: an earlier release that adds a system leaves it unset, and the
-- free-text system_type, treatment_type and disposal_type columns are kept as they are.
alter table wastewater_systems add column system_category text
  check (system_category in ('aerobic', 'conventional', 'low_pressure_dosing', 'drip', 'holding_tank', 'lift_station', 'other', 'unknown'));

-- The backfill trusts contracts only: a system at a site that has ever had an aerobic inspection
-- contract is aerobic, every other system is unknown. Nothing is guessed from the text columns.
update wastewater_systems w
  set system_category = case
    when exists (
      select 1 from contracts c
      where c.organization_id = w.organization_id and c.site_id = w.site_id and c.service_type = 'aerobic_inspection'
    ) then 'aerobic'
    else 'unknown'
  end;

-- ---- The conventional and installation forms ----

-- New companies get a conventional service kind of work and the installation form; existing
-- companies get the new kind, and the installation form only where their installation row still
-- has no form, as 0051 did for repair and 0058 for pumping.
create or replace function work_types_defaults(org uuid) returns void language sql as $$
  insert into work_types (organization_id, key, name, category, default_form_template_key, default_duration_minutes, requires_disposal_record, position)
  values
    (org, 'pumping', 'Pumping', 'pumping', 'work-pumping', 60, true, 1),
    (org, 'repair', 'Repair', 'repair', 'work-repair', 90, false, 2),
    (org, 'installation', 'Installation', 'installation', 'work-installation', 480, false, 3),
    (org, 'service_call', 'Service call', 'other', 'work-service-call', 60, false, 4),
    (org, 'conventional_service', 'Conventional service', 'maintenance', 'work-conventional', 60, false, 5)
  on conflict (organization_id, key) do nothing;
$$;
insert into work_types (organization_id, key, name, category, default_form_template_key, default_duration_minutes, requires_disposal_record, position)
  select id, 'conventional_service', 'Conventional service', 'maintenance', 'work-conventional', 60, false, 5 from organizations
  on conflict (organization_id, key) do nothing;
update work_types set default_form_template_key = 'work-installation', updated_at = now()
  where key = 'installation' and default_form_template_key is null;
