-- A bank (ACH) payment Stripe can't take until the customer verifies their account with
-- microdeposits: the Stripe-hosted page where they do, until it is done or the payment ends.
alter table payments add column bank_verification_url text;
