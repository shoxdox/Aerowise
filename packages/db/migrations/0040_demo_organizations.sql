-- A demo company is fictional: the public demo, and later each prospect's own demo. Whatever
-- keys or DEMO_LIVE_SERVICES a deployment has, its email, texts, filings, payments, billing
-- and QuickBooks only ever reach the built-in stand-ins (packages/tasks/src/demo-gate.ts).
-- A company is demo or real from the moment it is made: the flag never changes, so a real
-- company's records can never become demo data or the other way around.
alter table organizations add column demo boolean not null default false;

create function organizations_demo_fixed() returns trigger language plpgsql as $$
begin
  if new.demo is distinct from old.demo then
    raise exception 'a company is demo or real from the moment it is made' using errcode = '23514', constraint = 'organizations_demo_fixed';
  end if;
  return new;
end $$;
create trigger organizations_demo_fixed before update of demo on organizations
  for each row execute function organizations_demo_fixed();

-- Contact details a demo company may hold: addresses at domains reserved for examples
-- (RFC 2606/6761) and phone numbers in the 555-0100 to 555-0199 range set aside for fiction.
-- Nothing in a demo company can then name a real person, even if a stand-in is bypassed.
create function fictional_email(email text) returns boolean language sql immutable as $$
  select email is null or btrim(email) = ''
    or lower(btrim(email)) ~ '@([a-z0-9-]+\.)*(example\.(com|net|org)|(example|test|invalid|localhost))$'
$$;
create function fictional_phone(phone text) returns boolean language sql immutable as $$
  select phone is null or btrim(phone) = ''
    or regexp_replace(phone, '[^0-9]', '', 'g') ~ '^1?[2-9][0-9]{2}55501[0-9]{2}$'
$$;

create function demo_contact_fictional() returns trigger language plpgsql as $$
declare
  org uuid;
  phone text;
begin
  -- NEW's fields differ by table, so each is read only where it exists.
  if tg_table_name = 'organizations' then
    if not new.demo then return new; end if;
  else
    org := new.organization_id;
    if not exists (select 1 from organizations where id = org and demo) then return new; end if;
  end if;
  if not fictional_email(new.email) then
    raise exception 'a demo company only holds made-up email addresses (like name@example.com)' using errcode = '23514', constraint = 'demo_fictional_email';
  end if;
  if tg_table_name <> 'invitations' then
    phone := to_jsonb(new) ->> 'phone';
    if not fictional_phone(phone) then
      raise exception 'a demo company only holds made-up phone numbers (555-0100 to 555-0199)' using errcode = '23514', constraint = 'demo_fictional_phone';
    end if;
  end if;
  return new;
end $$;
create trigger organizations_demo_fictional before insert or update of email, phone on organizations
  for each row execute function demo_contact_fictional();
create trigger contacts_demo_fictional before insert or update of email, phone on contacts
  for each row execute function demo_contact_fictional();
create trigger invitations_demo_fictional before insert or update of email on invitations
  for each row execute function demo_contact_fictional();

-- People: a member of a demo company has a made-up address and phone too, checked when they
-- join and whenever their details change.
create function demo_member_fictional() returns trigger language plpgsql as $$
declare
  u record;
begin
  if tg_table_name = 'memberships' then
    if not exists (select 1 from organizations where id = new.organization_id and demo) then return new; end if;
    select email, phone into u from users where id = new.user_id;
  else
    if not exists (select 1 from memberships m join organizations o on o.id = m.organization_id where m.user_id = new.id and o.demo) then return new; end if;
    u := new;
  end if;
  if not fictional_email(u.email) then
    raise exception 'a demo company only holds made-up email addresses (like name@example.com)' using errcode = '23514', constraint = 'demo_fictional_email';
  end if;
  if not fictional_phone(u.phone) then
    raise exception 'a demo company only holds made-up phone numbers (555-0100 to 555-0199)' using errcode = '23514', constraint = 'demo_fictional_phone';
  end if;
  return new;
end $$;
create trigger memberships_demo_fictional before insert or update of user_id, organization_id on memberships
  for each row execute function demo_member_fictional();
create trigger users_demo_fictional before update of email, phone on users
  for each row execute function demo_member_fictional();
