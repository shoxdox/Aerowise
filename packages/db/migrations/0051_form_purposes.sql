-- SW-F part 2: one template table for inspection, work and intake forms, the new signed
-- document kinds, and each kind of work pointing at its form. See
-- docs/engineering/SERVICE-WORKFLOWS-IMPLEMENTATION-PLAN.md §5.2 and §9 (SW-F).
--
-- Every release up to now reads "the inspection form" as the newest template with the key
-- 'aerobic-standard' and never looks at any other key, so work forms live under their own keys
-- and an older binary keeps serving the inspection form after they are added.

-- ---- Template purpose ----

-- Existing rows are all inspection forms; an older binary saving a new version leaves the
-- column out and gets 'inspection' too.
alter table inspection_templates
  add column purpose text not null default 'inspection' check (purpose in ('inspection', 'work', 'intake'));

-- The key every release reads as the inspection form never belongs to another purpose.
alter table inspection_templates
  add constraint inspection_templates_inspection_key check (purpose = 'inspection' or key <> 'aerobic-standard');

-- An inspection is filled in on an inspection form, never on a work or intake form, whichever
-- release wrote it (an older one checks only that the template id is visible to the company).
create or replace function inspections_template_purpose() returns trigger language plpgsql as $$
begin
  if (select purpose from inspection_templates where id = new.template_id) <> 'inspection' then
    raise exception 'an inspection must use an inspection template' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger inspections_template_purpose before insert or update of template_id on inspections
  for each row execute function inspections_template_purpose();

-- ---- Signed document kinds ----

-- 'work_completion': a homeowner's sign-off on a summary of work done (written from SW-2).
-- 'estimate_acceptance': an accepted estimate version (written from SW-5).
alter table signed_documents drop constraint signed_documents_kind_check;
alter table signed_documents
  add constraint signed_documents_kind_check check (kind in ('renewal_agreement', 'work_completion', 'estimate_acceptance'));

-- ---- Kinds of work point at their form ----

-- A kind of work never points at the inspection form.
alter table work_types
  add constraint work_types_form_not_inspection check (default_form_template_key is null or default_form_template_key <> 'aerobic-standard');

-- New companies get the starter forms on repair and service calls. Pumping and installation
-- get theirs when their forms are added (SW-6, SW-7).
create or replace function work_types_defaults(org uuid) returns void language sql as $$
  insert into work_types (organization_id, key, name, category, default_form_template_key, default_duration_minutes, requires_disposal_record, position)
  values
    (org, 'pumping', 'Pumping', 'pumping', null, 60, true, 1),
    (org, 'repair', 'Repair', 'repair', 'work-repair', 90, false, 2),
    (org, 'installation', 'Installation', 'installation', null, 480, false, 3),
    (org, 'service_call', 'Service call', 'other', 'work-service-call', 60, false, 4)
  on conflict (organization_id, key) do nothing;
$$;

-- Existing companies: only the starter rows the company has not pointed elsewhere.
update work_types set default_form_template_key = 'work-repair', updated_at = now()
  where key = 'repair' and default_form_template_key is null;
update work_types set default_form_template_key = 'work-service-call', updated_at = now()
  where key = 'service_call' and default_form_template_key is null;
