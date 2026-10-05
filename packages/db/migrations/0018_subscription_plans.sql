-- W4.1: what each organization owes Aerowise. Every organization has exactly one plan
-- state at a time, so it lives on the organization row (no row can ever be missing).
-- The founder price override is per organization; when it is null, the configured
-- default applies (prices, minimums and trial lengths are configuration, not data).
--
-- Existing organizations (development and demo data only before the pilot) become
-- `active` from today with no end date: nothing about them changes.

alter table organizations
  add column subscription_state text not null default 'active'
    check (subscription_state in ('design_partner', 'trial', 'active', 'past_due', 'read_only')),
  add column subscription_starts_on date not null default current_date,
  add column subscription_ends_on date,
  add column price_per_contract_cents_override integer check (price_per_contract_cents_override >= 0),
  add column monthly_minimum_cents_override integer check (monthly_minimum_cents_override >= 0),
  -- A free period has to end some day; a paid or lapsed one does not.
  add constraint organizations_subscription_end_check check (
    (subscription_state not in ('design_partner', 'trial') or subscription_ends_on is not null)
    and (subscription_ends_on is null or subscription_ends_on >= subscription_starts_on)
  );
