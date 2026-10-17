-- A renewal offer closed because the office made the next term another way ('Renew now').
-- Until now the emailed offer stayed open after that: the homeowner could sign and pay for a
-- term that already existed, the office could bill that term again, and reminders kept going
-- out. A superseded renewal names the contract that replaced it and can no longer be signed.

alter table renewals drop constraint renewals_status_check;
alter table renewals add constraint renewals_status_check check (status in (
  'upcoming', 'sent', 'viewed', 'signed', 'payment_pending', 'paid', 'activated', 'declined', 'expired', 'needs_review', 'superseded'
));
alter table renewals add column superseded_at timestamptz;
alter table renewals add constraint renewals_superseded_check check ((status = 'superseded') = (superseded_at is not null and new_contract_id is not null));

-- A superseded renewal is finished, like a declined or expired one.
drop index renewals_open_contract_idx;
create unique index renewals_open_contract_idx on renewals (contract_id) where status not in ('declined', 'expired', 'superseded');

-- Offers left open by a 'Renew now' made before this: nothing was signed or paid on them, so
-- they close now, pointing at the term that replaced them.
update renewals r
set status = 'superseded', superseded_at = now(), new_contract_id = n.id, updated_at = now()
from contracts n
where n.organization_id = r.organization_id
  and n.previous_contract_id = r.contract_id
  and r.status in ('upcoming', 'sent', 'viewed');
