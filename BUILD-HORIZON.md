# BUILD-HORIZON.md

## H0 — Validation and workflow capture

Goal: validate the replacement thesis.

Interview:
- 5 SAFE/spreadsheet users
- 5 other-software users

Obtain:
- anonymized customer export
- inspection form
- county report
- renewal flow
- invoice flow
- QuickBooks workflow
- route/schedule example
- real exception/failure story

Kill or pivot if:
- incumbent satisfaction is extremely high
- switching pain is greater than the product pain
- nobody will allow a real pilot
- providers care only about price

## H1 — Replacement core

Ship a product a small provider can operate on.

Modules:
- auth/tenancy
- CRM
- sites/systems
- plans/contracts
- recurring service
- scheduling
- route map
- technician PWA
- offline inspections
- photos/GPS
- reports
- 2 jurisdiction adapters
- compliance dashboard
- renewals
- e-sign
- invoicing
- Stripe card/ACH
- customer portal
- imports
- repair follow-up

Exit criteria:
A pilot customer can run one week of maintenance operations without returning to spreadsheets for core work.

## H2 — Parity-plus

Ship:
- QuickBooks Online
- SMS
- automatic renewal campaigns
- saved payment methods/autopay
- route optimization
- provider-configurable templates
- richer reporting
- bulk actions
- API/webhooks
- better migration tooling

Exit criteria:
A 500–1,500 contract provider can replace its existing software.

## H3 — Automation moat

Ship:
- automated county filing where officially supported
- filing verification/confirmation
- jurisdiction-version engine
- adapter health checks
- auto retries
- exception prioritization
- renewal intelligence
- route suggestions
- recurring issue detection

Exit criteria:
Most standard maintenance visits require zero office interaction after technician completion.

## H4 — Expansion

Possible:
- pumping/hauling module
- IoT monitoring
- Florida MARS adapter
- Washington OnlineRME adapter
- other O&M compliance states

Do not expand until Texas maintenance retention is strong.
