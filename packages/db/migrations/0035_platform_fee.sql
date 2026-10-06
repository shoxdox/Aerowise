-- W4.5: Aerowise's fee on homeowner payments, as a Stripe Connect application fee. Set per
-- organization by an Aerowise admin, in basis points (100 = 1%), 0 by default: no fee.
-- Each checkout keeps the fee it was opened with, so a later change never alters a page
-- the homeowner already has.

alter table organizations
  add column platform_fee_bps integer not null default 0
    check (platform_fee_bps >= 0 and platform_fee_bps <= 1000);

alter table checkout_sessions
  add column application_fee_cents integer not null default 0
    check (application_fee_cents >= 0);
