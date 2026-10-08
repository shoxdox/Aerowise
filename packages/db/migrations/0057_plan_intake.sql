-- SW-8 follow-up: a plan version can ask intake questions when a customer signs online.
-- The questions are one immutable version of an intake form (SW-F, purpose 'intake'); the
-- answers are kept only in the signed agreement, never on a table that can change.

alter table plan_versions add column intake_template_id uuid references inspection_templates (id);

-- The form must be an intake form, built in or the plan's own company's. Versions are written
-- once (plan_versions_immutable refuses updates), so checking on insert is enough.
create or replace function plan_versions_intake_form() returns trigger language plpgsql as $$
begin
  if new.intake_template_id is not null and not exists (
    select 1 from inspection_templates t
    where t.id = new.intake_template_id and t.purpose = 'intake'
      and (t.organization_id is null or t.organization_id = new.organization_id)
  ) then
    raise exception 'a plan version can only ask an intake form of its own company' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger plan_versions_intake_form before insert on plan_versions
  for each row execute function plan_versions_intake_form();

-- A plan change keeps the previous version's intake form, as it keeps its terms and coverage.
create or replace function plans_record_version() returns trigger language plpgsql as $$
declare
  prev plan_versions;
begin
  if tg_op = 'UPDATE' then
    select * into prev from plan_versions where id = old.current_version_id;
  end if;
  insert into plan_versions (organization_id, plan_id, version, name, customer_type, term_months, visits_per_term, price_cents, billing_frequency, service_type, terms_text, options, coverage, service_cycles, intake_template_id)
  values (
    new.organization_id, new.id,
    coalesce((select max(version) from plan_versions where plan_id = new.id), 0) + 1,
    new.name, new.customer_type, new.term_months, new.visits_per_term, new.price_cents, new.billing_frequency, new.service_type,
    prev.terms_text, coalesce(prev.options, '[]'), coalesce(prev.coverage, '[]'),
    plan_aerobic_cycles(new.service_type, new.visits_per_term),
    prev.intake_template_id
  )
  returning id into new.current_version_id;
  return new;
end $$;
