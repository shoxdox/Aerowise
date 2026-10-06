# Integrations

How each outside service Aerowise talks to is set up, tried on staging and switched to production. One section per service; W7 adds QuickBooks (W7.2) and Twilio (W7.3).

| Service | What for | Code | Staging | Production |
| --- | --- | --- | --- | --- |
| Stripe Connect | Homeowners paying a company's invoices online | `packages/payments` | Test mode, with `DEMO_LIVE_SERVICES=stripe` | Live keys |
| QuickBooks Online | Invoices and payments into the company's books | `packages/quickbooks` | Intuit sandbox, with `DEMO_LIVE_SERVICES=quickbooks` | Production keys, after Intuit's app review |
| Twilio | Reminder texts and replies | `packages/sms` | Stand-in; `DEMO_LIVE_SERVICES=sms` sends to one test phone once a number is approved | Live, after toll-free verification or A2P 10DLC |

Stripe Billing (what companies pay Aerowise, W4) is a separate Stripe relationship with its own keys (`STRIPE_BILLING_*`); nothing here touches it.

## Real services on the staging demo

Staging runs the demo (`DEMO_MODE=true`): every outside service is a test stand-in whatever keys are set, and the data is reset every night at 09:00 UTC. To try a service end to end, `DEMO_LIVE_SERVICES` in `/etc/aerowise/staging.env` names the services the demo uses for real anyway, comma-separated. Each one is allowed only in a mode where nothing real happens, and the API and worker refuse to start otherwise:

- `stripe`: `STRIPE_SECRET_KEY` must be a test-mode key (`sk_test_` or `rk_test_`). No money moves.
- `quickbooks`: `QUICKBOOKS_ENVIRONMENT` must be `sandbox`, with `QUICKBOOKS_CLIENT_ID` and `QUICKBOOKS_CLIENT_SECRET` set. Only Intuit sandbox companies can be connected.
- `sms`: Twilio's keys and `SMS_REDIRECT_TO`, one test phone. Every text goes there instead of to the customer, starting "[Test, for +1…]".

Everything not listed stays a stand-in. The settings check also refuses a live Stripe key, `QUICKBOOKS_ENVIRONMENT=production`, or Twilio without `SMS_REDIRECT_TO` (outside demo mode) on staging, and any `DEMO_LIVE_SERVICES` or `SMS_REDIRECT_TO` in production. Several services are listed together, e.g. `DEMO_LIVE_SERVICES=stripe,quickbooks`.

After editing the settings file, redeploy staging so the containers pick it up:

```sh
sudo -u deploy aerowise-deploy staging $(sudo -u deploy git -C /opt/aerowise/staging ls-remote origin refs/heads/main | cut -f1)
```

The API's first log line says which services are live: `docker logs aerowise-staging-api-1 2>&1 | grep "demo mode"`.

## Stripe Connect

**How it works.** Each company has its own Stripe account (Express), created from **Settings > Billing > Set up online payments**. Homeowners pay on Stripe Checkout as a direct charge on that account, so the money settles to the company and Aerowise takes no fee. Card payments clear at checkout; bank (ACH) payments show as processing and clear or fail days later. Refunds are made from the invoice in Aerowise, or in the company's Stripe dashboard (Aerowise picks those up too). Every webhook is signature-checked, stored once by event id in `stripe_events` with what it did, and applied so that replays and out-of-order events end in the same state.

### Setting up Stripe for staging (test mode)

In the Stripe dashboard, with **Test mode** on:

1. **Connect:** open Connect and finish the platform setup it asks for (platform profile, and loss responsibility for Express accounts). Under **Settings > Connect > Branding**, set a business name and icon; Express onboarding needs them.
2. **Bank payments:** under **Settings > Connect > Payment methods**, turn on **ACH Direct Debit** for connected accounts (cards are on by default).
3. **Webhook:** **Developers > Webhooks > Add endpoint**:
   - URL `https://staging.deshain.com/api/webhooks/stripe`
   - **Listen to events on Connected accounts**
   - API version `2026-09-30.endive` (the version Aerowise's Stripe library uses), if offered
   - Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.requires_action`, `payment_intent.processing`, `payment_intent.payment_failed`, `refund.created`, `refund.updated`, `account.updated`
4. **Settings file** on the server (`/etc/aerowise/staging.env`), never in chat:
   - `STRIPE_SECRET_KEY=` the test secret key (`sk_test_...`, **Developers > API keys**)
   - `STRIPE_WEBHOOK_SECRET=` the endpoint's signing secret (`whsec_...`)
   - `DEMO_LIVE_SERVICES=stripe`
5. Redeploy staging (above).

### The staging run

Signed in to staging as the demo owner:

1. **Onboarding.** **Settings > Billing > Set up online payments** opens Stripe's onboarding. Use Stripe's test values: phone `000 000 0000` and code `000000`, SSN `000-00-0000`, bank routing `110000000` and account `000123456789`. Back in Aerowise the page says online payments are on.
2. **Card.** Issue an invoice to a customer, open its pay link and pay with card `4242 4242 4242 4242` (any future date, any CVC). The invoice shows paid.
3. **Bank (ACH).** On a second invoice, pay by US bank account with routing `110000000` and account `000123456789`, entered by hand. Stripe then waits for the customer to verify the account with microdeposits: the pay page says **Verify your bank account** with a button to Stripe's verification page, and the office's invoice shows the payment waiting on the customer. On that page, use Stripe's test code `SM11AA`. The pay page then shows the payment clearing, and paid once Stripe clears it. Account `000111111116` fails instead, and the inbox flags it.
4. **Refund.** Refund part of the card payment from its invoice. It shows the refund pending, then done.
5. **Webhooks.** On the server, the events Aerowise received and what each did:

   ```sh
   docker exec aerowise-staging-db-1 psql -U aerowise -d aerowise -c "select received_at, type, livemode, outcome from stripe_events order by received_at"
   ```

   Every line should have `livemode` false and an outcome other than `ignored: not a connected account we know`. Stripe's own view is the endpoint's page under **Developers > Webhooks**.

The nightly reset removes the demo company's link to its Stripe test account, so the next day's run starts again at onboarding. Old test accounts stay in Stripe; they cost nothing.

Run log (newest last):

| Date | Who | Onboarding | Card | ACH | Refund | Webhooks | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-06 | Codex, Justin | passed | passed (INV-1001, $10) | passed (INV-1002, $10: pending, then succeeded), but the pay page wrongly said "nothing more to do" while Stripe waited on microdeposit verification; Codex verified by hand. The pay page fix is this PR | passed ($2 partial, net $8 paid) | passed (`livemode` false; checkout, async success and refund events applied) | Stripe sandbox; results verified by Codex |

### Switching production to live keys

1. In Stripe with **Test mode off**, repeat setup steps 1–3 for live mode, with the URL `https://app.deshain.com/api/webhooks/stripe`. Stripe asks for the platform's business details before live Connect accounts can be created.
2. In `/etc/aerowise/production.env`: `STRIPE_SECRET_KEY=sk_live_...` and `STRIPE_WEBHOOK_SECRET=` the live endpoint's secret. Leave `DEMO_LIVE_SERVICES` empty (production refuses it).
3. Deploy production. Each company then sets up its own account from **Settings > Billing**; until it has, its invoices offer no online payment.
4. Rotating the webhook secret: Stripe keeps the old secret valid for a while after **Roll secret**; list both, comma-separated, in `STRIPE_WEBHOOK_SECRET` until the old one expires.

### Fixed during W7.1

- Checkout pages asked Stripe for exactly 24 hours of life, Stripe's maximum counted on its own clock, so a server clock a little ahead got the page refused. They now last 23 hours.
- A bank payment whose "cleared" event arrived before its "checkout completed" event was recorded as a card payment. Delayed-payment events now always mean a bank payment.
- Found on the staging run: a bank account entered by hand must be verified with microdeposits before Stripe takes the payment, but the pay page said "there is nothing more to do". Aerowise now listens for `payment_intent.requires_action` and shows the customer Stripe's verification page until `payment_intent.processing` says it's done; `payment_intent.payment_failed` fails a bank payment that never verified.

## QuickBooks Online

**How it works.** The owner connects a QuickBooks Online company from the **QuickBooks** page (`/quickbooks`) through Intuit's OAuth consent page. Aerowise stores the tokens encrypted (`QUICKBOOKS_TOKEN_KEY`), refreshes them as they expire, and the worker syncs every `QUICKBOOKS_SYNC_INTERVAL_MS` and after each change. The first sync is a review: Aerowise matches its customers to QuickBooks customers and the office approves each uncertain match before anything is written. After that it pushes customers, invoices and payments one way, Aerowise to QuickBooks, and reads QuickBooks' changes (change data capture) to raise conflicts instead of overwriting. Every write carries a request id, so a retried write is not duplicated. Every failure stored on a record names Intuit's request id ("Intuit ref …", the `intuit_tid` header), which Intuit support asks for.

### Setting up QuickBooks for staging (Intuit sandbox)

1. At developer.intuit.com, create an app for **QuickBooks Online and Payments** with the **Accounting** scope (`com.intuit.quickbooks.accounting`). Intuit gives every developer account a sandbox company (**Dashboard > Sandboxes**); no QuickBooks subscription is needed.
2. In the app's **Development** settings, add the redirect URI `https://staging.deshain.com/api/quickbooks/callback`.
3. **Settings file** (`/etc/aerowise/staging.env`), never in chat:
   - `QUICKBOOKS_CLIENT_ID=` and `QUICKBOOKS_CLIENT_SECRET=` the **Development** keys
   - `QUICKBOOKS_ENVIRONMENT=sandbox`
   - `QUICKBOOKS_TOKEN_KEY` is already set by `setup.sh`; leave it
   - add `quickbooks` to `DEMO_LIVE_SERVICES` (e.g. `stripe,quickbooks`)
4. Redeploy staging.

### The staging run

Signed in to staging as the demo owner:

1. **Connect.** On the QuickBooks page, **Connect** opens Intuit's consent page. Sign in with the Intuit developer account, pick the sandbox company and allow. Back in Aerowise the page names the sandbox company.
2. **Review.** The first-sync review lists the demo customers with any likely matches among the sandbox company's own customers. Approve or create each, and pick the product or service used for invoice lines.
3. **Invoice.** Issue an invoice in Aerowise. Within a sync it shows in the sandbox company (QuickBooks: **Sales > Invoices**) with the same number, lines and total.
4. **Payment.** Record a payment on it in Aerowise (or pay it online with Stripe test mode). It shows in QuickBooks against that invoice, and the invoice's balance there drops to match.
5. **Conflict.** In QuickBooks, rename a synced customer, then change the same customer in Aerowise. Aerowise shows a conflict on the QuickBooks page instead of overwriting either side.
6. **Disconnect and reconnect.** **Disconnect** gives up the tokens; connecting again picks up where the links left off.
7. **Record.** The sync's own record, without tokens:

   ```sh
   docker exec aerowise-staging-db-1 psql -U aerowise -d aerowise -c "select entity_type, status, count(*) from quickbooks_links group by 1, 2 order by 1, 2" -c "select environment, company_name, status, last_sync_finished_at, last_sync_error from quickbooks_connections"
   ```

   Every link should be `synced` (or a `conflict` from step 5), and the connection's `environment` `sandbox`.

**Refunds (proposed; Justin's choice pending).** A refund lowers the payment in QuickBooks to what the customer kept paying, so the QuickBooks invoice shows the same balance due as Aerowise; a payment refunded in full is deleted there. The payment's private note says how much was refunded. A payment refunded before it reached QuickBooks goes over at its net amount, or not at all. Refunds made in Stripe's dashboard count too. A payment someone changed or deleted in QuickBooks is never overwritten: it goes to the conflict center for a person to choose. Until this is chosen, deployed and re-tested on staging, the INV-1001 mismatch below stays open.

The nightly reset removes the connection; the sandbox company keeps what was written to it. Intuit lets a sandbox company be reset from the developer dashboard.

Run log (newest last):

| Date | Who | Connect | Review | Invoice | Payment | Conflict | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-06 | Codex | passed (Sandbox Company US) | passed (demo customers approved, default item mapped) | passed (INV-1001, INV-1002 match totals) | passed for INV-1002 (balance 0, matches); **not matching for INV-1001**: the $2 Stripe refund never reaches QuickBooks (refunds aren't synced), so QuickBooks shows it paid while Aerowise shows $2 due | passed (`changed_in_both`, resolved by sending the Aerowise version) | A deploy interrupted the first sync at 20 of 50; the normal sync recovered after the 10-minute lease. 50 customers, 2 invoices, 2 payments synced, no sync errors. Disconnect and reconnect passed, keeping the 50 customer, 2 invoice and 2 payment links. Refund gap: **open**. A proposed fix (refunds lower the QuickBooks payment) waits on Justin's choice, then a staging re-run |

### Going to production (Intuit's app review)

Production keys for an app that connects other people's QuickBooks companies are issued after Intuit reviews the app. Steps, in the Intuit developer portal:

1. **App details:** app name, logo, and the URLs Intuit asks for: host domain `app.deshain.com`, launch URL `https://app.deshain.com/quickbooks`, disconnect URL `https://app.deshain.com/quickbooks` (the page explains what disconnecting means), a privacy policy and an end-user licence (terms) URL. The terms and privacy pages come from W8.3 with Justin's lawyer-reviewed text.
2. **Production redirect URI:** `https://app.deshain.com/api/quickbooks/callback`.
3. **Compliance questionnaire:** what Aerowise answers, from the code:
   - OAuth 2.0 with the accounting scope only; tokens encrypted at rest (AES-256-GCM with `QUICKBOOKS_TOKEN_KEY`) and refreshed before expiry; refresh tokens replaced as Intuit rotates them; a refused refresh marks the connection as needing to connect again.
   - Disconnecting revokes the token with Intuit.
   - Errors are logged and shown to the office per record, with Intuit's `intuit_tid`.
   - Writes are idempotent (`requestid`); reads page at 1000 rows; change data capture stays within Intuit's 30-day window; the minor version is pinned (`75`).
   - Data is only synced one way (Aerowise to QuickBooks) plus conflict detection; nothing in QuickBooks is deleted.
4. **Production keys** go in `/etc/aerowise/production.env` with `QUICKBOOKS_ENVIRONMENT=production`, then deploy production.

Intuit's review can ask follow-up questions and take a few weeks. A design partner can't connect their real books until it is done; the sandbox works meanwhile.

## Twilio

**How it works.** Each company turns texting on from the **Texts** page (`/sms`) and sets the number its texts come from (one of the Twilio account's numbers). Aerowise sends on-the-way notices, inspection and report notices, and renewal and payment reminders to contacts who agreed to texts, outside quiet hours, and records each message. Twilio calls back with delivery receipts (`/api/webhooks/sms/status`, set on every send) and incoming replies (`/api/webhooks/sms/inbound`, set on the number). Both are checked against Twilio's signature. STOP, START and HELP replies are handled, and a STOP'd number is never texted again until it replies START.

**Status (Justin, 2026-10-06): no paid Twilio route yet.** A Twilio trial account can't text US numbers usefully: a local number needs an upgraded account and A2P 10DLC registration, and a toll-free number needs toll-free verification. Justin chose to wait. Staging keeps the stand-in until a route is approved, and the live test happens before the first design partner turns texting on. Twilio's trial keys are in staging's settings file but unused, because the demo ignores them unless `sms` is listed.

### Choosing a route (when it's time)

- **Toll-free number + toll-free verification** (recommended for the pilot): upgrade the Twilio account, buy one toll-free number, submit the verification form (business details, use case "appointment reminders and account notifications", sample texts, how contacts opt in). No campaign fees. Approval usually takes days to a few weeks.
- **Local number + A2P 10DLC**: upgrade, register a brand and a campaign in Twilio's Trust Hub, then buy a local number and add it to the campaign's messaging service. It adds registration and monthly campaign fees, and approval often takes longer.

Either way, each design partner eventually sends from a number of its own (or of Aerowise's, registered for them). That is a choice for when the first one turns texting on.

### Setting up Twilio for staging

1. On the approved number, under **Messaging > A message comes in**: Webhook, HTTP POST, `https://staging.deshain.com/api/webhooks/sms/inbound`. Delivery receipts need no setting.
2. **Settings file** (`/etc/aerowise/staging.env`), never in chat:
   - `TWILIO_ACCOUNT_SID=` and `TWILIO_AUTH_TOKEN=` (the upgraded account's)
   - `SMS_REDIRECT_TO=` the one test phone, like `+15125550123`
   - add `sms` to `DEMO_LIVE_SERVICES` (e.g. `stripe,quickbooks,sms`)
3. Redeploy staging.

### The staging run

1. On the **Texts** page, turn texting on and set the approved number as the sending number.
2. Give a demo customer's contact a mobile number and text consent, then send that customer a reminder text. The test phone receives "[Test, for +1…] …", and the message shows delivered in Aerowise once Twilio's receipt arrives.
3. **STOP.** Add a contact whose number is the test phone itself (with consent), text it, and reply STOP from the phone. The contact shows opted out, and Twilio's own STOP confirmation arrives. Reply START to undo.
4. **Record.** Without numbers in full:

   ```sh
   docker exec aerowise-staging-db-1 psql -U aerowise -d aerowise -c "select created_at, kind, direction, status, error_code from sms_messages order by created_at"
   ```

Run log (newest last):

| Date | Who | Send | Delivered | STOP | Notes |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | Not run yet: no approved Twilio number (Justin chose to wait, 2026-10-06). |

### Going live in production

With an approved number: put the keys in `/etc/aerowise/production.env` (no `SMS_REDIRECT_TO`, which production refuses), point the number's incoming messages at `https://app.deshain.com/api/webhooks/sms/inbound`, deploy, and the company sets its sending number on the Texts page.

