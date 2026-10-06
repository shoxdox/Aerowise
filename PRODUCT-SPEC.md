# PRODUCT-SPEC.md

> Design reference. For implemented status and next actions, read README.md and docs/DEMO-PILOT-BRIEF.md. This specification is not an active coding queue.

Status: Draft v0.2  
Audience: Founder, design, Codex/engineering agents  
Product name: **Aerowise**

---

# 1. Product definition

Aerowise is an all-in-one operating system for aerobic septic maintenance companies.

It is designed to replace the provider's existing operating stack, not sit beside it.

A provider should be able to use Aerowise for:

- customers
- service sites
- septic system records
- recurring maintenance contracts
- service plans
- technician scheduling
- routes
- field inspections
- photos / GPS / timestamps
- county reports
- report delivery
- repair follow-up
- renewals
- e-signatures
- invoices
- card / ACH payments
- QuickBooks sync
- customer portal
- basic business reporting

The initial target is a Texas maintenance provider with roughly 200–2,500 active contracts and 1–15 technicians.

---

# 2. Positioning

Internal positioning:

> **The operating system for aerobic septic maintenance companies.**

External value proposition:

> Manage contracts, schedule inspections, run technicians, file reports, renew customers, invoice, and get paid — without juggling spreadsheets, county forms, and separate tools.

Differentiator:

> **Less office work. Better mobile. Compliance runs itself.**

---

# 3. Product principles

## 3.1 Replace, do not supplement

The product must be broad enough that a provider can plausibly switch its maintenance operation to us.

## 3.2 Compliance is the vertical advantage

Scheduling, invoicing, and CRM are table stakes.

The reason to choose us instead of Jobber/Housecall Pro is that we understand:

- aerobic systems
- inspections
- maintenance contracts
- counties / authorized agents
- jurisdiction-specific forms
- recurring reporting
- compliance deadlines
- proof of filing
- renewals tied to compliance

## 3.3 Exceptions, not busywork

Normal operations should disappear into automation.

The office should see:

- inspection missing a required reading
- report approaching deadline
- county filing failed
- customer renewal unsigned
- card failed
- QuickBooks sync conflict
- technician skipped a required photo

## 3.4 Technician-first field UX

The technician is the highest-frequency user.

Their workflow should be:

`Today -> Stop -> Inspect -> Photos -> Complete`

Minimal typing. Large tap targets. Offline support.

## 3.5 Fastest migration wins

Switching software is painful.

Make migration a first-class product:

- CSV/XLSX
- SAFE export
- QuickBooks customer export
- generic provider spreadsheet
- contract PDFs
- customer/site lists

## 3.6 Build a clean core

Do not mirror a competitor's legacy schema.

Use a small normalized domain model, versioned workflows, and explicit state machines.

---

# 4. User roles

## Owner / Admin

Can manage everything:

- company settings
- users
- sites
- plans
- contracts
- billing
- integrations
- compliance rules
- reporting

## Office

Can:

- manage customers/sites
- schedule work
- review inspections
- resolve exceptions
- send renewals
- invoice
- manage customer communication

## Technician

Can:

- view assigned route
- navigate
- see safety/access notes
- complete inspections
- record repairs
- add parts/upsells
- take photos
- collect signature
- work offline

## Read-only / Auditor

Can:

- view records
- export reports
- inspect compliance history

---

# 5. Core modules

## 5.1 CRM

Customer:
- name
- contacts
- billing contact
- phone/email
- mailing address
- communication preferences
- tags
- notes

Site:
- service address
- GPS
- county/jurisdiction
- permit number
- access notes
- gate code
- dogs/safety
- active/inactive
- customer link

Wastewater System:
- site
- system category
- manufacturer
- model
- serial
- installation date
- treatment type
- disposal type
- chlorination method
- system notes
- equipment list

## 5.2 Contracts and plans

Provider can define reusable plans.

Contract:
- customer/site
- plan
- start/end
- price
- billing frequency
- status
- service obligations
- add-ons
- auto-renew
- signed agreement
- renewal status

Plan:
- name
- residential/commercial
- term
- price
- included visits
- included services
- optional add-ons
- contract template
- default jurisdiction applicability

## 5.3 Recurring service engine

Service obligation:
- site
- contract
- service type
- interval
- visits required
- last completion
- next due
- scheduling window
- compliance deadline
- jurisdiction rule reference

This engine creates jobs automatically.

## 5.4 Scheduling

Office calendar with:
- unscheduled jobs
- technician schedules
- drag/drop assignment
- all-day route view
- overdue work
- recurring generation
- customer scheduling restrictions

## 5.5 Routing

Initial:
- map of assigned stops
- manual ordering
- route grouping by geography
- travel estimate

Later:
- automatic route optimization
- capacity constraints
- technician territories
- preferred windows

## 5.6 Technician mobile app

Must support:
- installable PWA first
- offline route cache
- offline inspection drafts
- local photo queue
- geolocation
- arrival/departure timestamps
- sync retry
- conflict detection

Site card:
- address
- navigation
- access instructions
- dog warning
- gate code
- previous inspection
- system details
- open issues
- contract/service info

## 5.7 Inspection engine

Use configurable templates.

Canonical inspection data should support:

- aerator
- air pressure
- air filter
- alarms/controller
- chlorine device
- chlorine level
- chlorine amount added
- diffuser
- clarifier/treatment tank
- pump tank
- lids/openings
- floats/wiring
- electrical condition
- effluent pump/filter
- dispersal/spray field
- field pressure
- tank condition
- odor
- pH
- TSS
- BOD
- pumping needed
- repairs made
- notes
- photos
- signature
- GPS/time

Template decides what is shown/required.

Jurisdiction rules may add validation requirements.

## 5.8 Repairs / follow-up work

Inspection can create:
- repair needed
- pump-out needed
- part replacement
- callback
- estimate required
- noncompliance issue

Office can convert issue -> task/job/invoice.

## 5.9 County / authority reporting

For each completed inspection:

1. validate required fields
2. generate canonical report
3. resolve jurisdiction
4. generate required jurisdiction artifact
5. queue submission
6. submit by supported method
7. retain proof
8. notify customer
9. calculate next obligation

Filing statuses:
- NOT_REQUIRED
- PENDING
- READY
- QUEUED
- SUBMITTING
- SENT
- CONFIRMED
- FAILED
- REJECTED
- NEEDS_REVIEW

## 5.10 Compliance ledger

Every site has a chronological audit timeline:

- contract created
- contract renewed
- inspection due
- inspection scheduled
- tech arrived
- inspection completed
- report generated
- customer copy sent
- authority submission sent
- authority confirmation received
- exception created/resolved
- payment received
- next inspection scheduled

This is a key differentiator.

## 5.11 Contract renewals

Renewal engine:

- detect contracts expiring within configurable window
- build renewal packet
- send link
- collect customer updates
- offer add-ons
- e-sign agreement
- collect payment
- activate renewed contract
- generate next obligations
- file/notify authority where required

Statuses:
- UPCOMING
- SENT
- VIEWED
- SIGNED
- PAYMENT_PENDING
- PAID
- ACTIVATED
- DECLINED
- EXPIRED
- NEEDS_REVIEW

## 5.12 E-signature

Requirements:
- typed/drawn signature
- timestamp
- IP/device metadata
- signed PDF
- immutable final copy
- audit trail

## 5.13 Invoicing

Need:
- invoice
- line items
- taxes
- discounts
- due date
- service/job links
- status
- PDF
- customer delivery
- balance due
- payments/refunds

Do not build a general ledger.

## 5.14 Payments

Stripe Connect or equivalent.

Support:
- card
- ACH
- saved payment method
- one-time invoice
- renewal checkout
- autopay
- refunds
- failed-payment recovery
- processing fees where legally/configurably supported

## 5.15 QuickBooks Online

Must exist before we claim full parity.

Initial sync:
- customers/sites -> QBO customers/subcustomers as appropriate
- products/services -> QBO items
- invoices -> QBO invoices
- payments -> QBO payments

Requirements:
- OAuth
- sync state
- conflict detection
- last sync
- retry
- error queue
- manual re-sync
- mapping configuration

Later:
- two-way customer updates
- tax mapping
- product hierarchy
- refunds
- estimates

Do not overbuild the first-sync engine until customer behavior requires it.

## 5.16 Communication

Email:
- inspection reports
- invoices
- renewal links
- reminders
- failures/bounces

SMS:
- on-the-way
- inspection completed
- report ready
- renewal reminder
- payment reminder

Respect consent/opt-out.

## 5.17 Customer portal

Homeowner can view:
- contract status
- next visit
- last inspection
- reports
- invoices
- payment method
- renewal
- system details
- service request

Use magic links initially.

## 5.18 Products / add-ons

Provider can create:
- chlorine refill
- bleach refill
- call-ahead
- scheduled appointment premium
- aerator service
- repair parts
- pumping add-on
- other recurring add-ons

Can attach add-ons to:
- contracts
- renewals
- jobs
- invoices

## 5.19 Reporting

Owner dashboard:
- active contracts
- contracts expiring
- renewal rate
- overdue inspections
- inspections completed
- filing success rate
- filing exceptions
- revenue
- outstanding invoices
- technician productivity
- average inspection duration
- repairs generated
- add-on attach rate

---

# 6. Better-than strategy

## 6.1 Onboarding

Goal:
Provider sends current data and is operational quickly.

Migration assistant:
- upload
- auto-detect fields
- normalize
- dedupe
- geocode
- infer jurisdiction
- preview
- flag ambiguous rows
- import
- preserve original source file

## 6.2 Mobile

Better-than goals:
- true offline operation
- no tiny controls
- very little keyboard use
- previous values visible
- photo prompts
- auto timestamps
- reliable sync indicator

## 6.3 Compliance

Better-than goals:
- automatic jurisdiction detection
- automatic document generation
- automatic submission where officially supported
- explicit submission evidence
- filing state visible
- retries
- deadline alarms
- exception-only office UX

## 6.4 Renewals

Better-than goals:
- renewal campaigns run automatically
- single homeowner link
- e-sign + payment + add-ons in one flow
- no office re-keying
- auto-create next contract/service obligations

## 6.5 QuickBooks

Better-than goals:
- visible sync health
- understandable error messages
- easy mapping
- per-record retry
- no silent sync failures

## 6.6 Customer experience

Better-than goals:
- modern portal
- report access
- transparent visit history
- easy renewal/payment
- no account/password required initially

---

# 7. Explicit non-goals

Even as a direct competitor, avoid becoming generic FSM software.

Do not prioritize:
- payroll
- full bookkeeping
- HR
- sales pipeline CRM
- generic project management
- fuel tracking
- dispatch for unrelated industries
- large-enterprise call-center tooling
- broad inventory ERP

Only build a feature if it materially helps septic maintenance operations.

---

# 8. Target MVP for first paying customer

The first sellable release should include:

1. organizations/users/roles
2. customers/contacts
3. sites/systems
4. plans/contracts
5. recurring service obligations
6. scheduling/calendar
7. technician PWA
8. offline inspections
9. photos/GPS/timestamps
10. inspection templates
11. reports/PDFs
12. jurisdiction adapter framework
13. at least 2 real Texas reporting workflows
14. compliance dashboard
15. customer report delivery
16. renewal links
17. e-sign
18. invoices
19. Stripe card/ACH
20. basic customer portal
21. CSV/XLSX import
22. basic route map
23. tasks/repair follow-up
24. audit logs

QuickBooks can be private beta at first customer, but must be the next major deliverable.

---

# 9. North-star metrics

Product:
- median inspection completion time
- % inspections completed without office correction
- % reports submitted without office intervention
- filing failure rate
- unresolved compliance exceptions
- renewal completion rate
- onboarding time per 500 sites
- offline sync success rate
- QBO sync failure rate

North star:

> **Percentage of scheduled maintenance visits that move from assigned -> inspected -> reported -> customer delivered -> compliant with no office intervention.**

---

# 10. Pricing hypothesis

Test against real providers.

Possible structure:

- Solo: $59/mo, up to 100 active contracts
- Core: $129/mo, up to 500
- Growth: $249/mo, up to 1,500
- Scale: $399/mo, up to 3,000
- Enterprise: custom

Include unlimited technicians initially.

Alternative:
$49 base + $0.35–$0.50 per active contract.

We should not race to the bottom. Migration + automation should justify a modest premium if the product saves office labor.

---

# 11. Definition of success

We are successful when a maintenance provider can cancel its existing maintenance-management software and run day-to-day operations on Aerowise without creating new manual work elsewhere.
