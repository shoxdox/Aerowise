-- The maintenance provider's emergency phone, which some authorities require on every
-- maintenance report (Travis County Code 448.034(e), SJRA rules 7(a)(10)(D)).
alter table organizations add column emergency_phone text;

-- A demo company's emergency phone is made up too, like its other contact details (0040).
create function organizations_demo_emergency_phone() returns trigger language plpgsql as $$
begin
  if new.demo and not fictional_phone(new.emergency_phone) then
    raise exception 'a demo company only holds made-up phone numbers (555-0100 to 555-0199)' using errcode = '23514', constraint = 'demo_fictional_phone';
  end if;
  return new;
end $$;
create trigger organizations_demo_emergency_phone before insert or update of emergency_phone on organizations
  for each row execute function organizations_demo_emergency_phone();
