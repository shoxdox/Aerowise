# Service workflows: implementation plan

**Status: plan only.** Nothing in this document is built, validated, deployed or accepted by an authority. It proposes how to add general work orders, pumping/disposal records, estimates, plan-specific agreements, conventional/installation work, map participation and authority export interoperability to Aerowise. Justin authorized the planning on October 7, 2026 and wants these capabilities built. This plan does not start implementation. Implementation workers start only when Justin says so, in the order below.

- **Baseline:** `09068280c2fcc036706734807167ff32524f7f8f` (`0906828`, "docs: record merged staging fixes and live prospect walkthrough"), fetched from `origin/main` at 2026-10-07 21:30Z. That commit includes the staging fixes #93–#96 and `5e491a0` (newer technician edits survive an in-flight sync). Migrations run through `0047_demo_request_delivery.sql`. No open PRs existed at that time.
- **Map dependency:** "Street map for routes" is draft [PR #97](https://github.com/shoxdox/Aerowise/pull/97), branch `claude/route-street-map-ae4nrx`, head `a96f8b2b2469ac030b053c61c52293efddf8ead2` as read at 2026-10-07 21:40Z. It is not merged, and its local checks were still running when it was read. The interfaces this plan builds on are summarized in [§6](#6-shared-street-map-and-schedule). Nothing here edits or duplicates that work.
- **Sources:** current `main` code and docs ([README](../../README.md), [handoff](../DEMO-PILOT-BRIEF.md), [delivery record](ROADMAP.md), [decisions](../DECISIONS.md), [pilot worksheet](../PILOT-CALL-SHEET.md), [agent guidance](../../CODEX.md)). It also uses the sanitized Fieldbase findings in Justin's request and the public pages cited in [§0.2](#02-outside-evidence-and-how-much-it-proves). No private Fieldbase data, credentials, customer files or proprietary assets were used. None may be used during implementation.

Contents: [0 Ground rules](#0-ground-rules-that-apply-to-every-pr) · [1 Work orders](#1-general-work-orders) · [2 Pumping and disposal](#2-pumping-and-disposal-records) · [3 Estimates](#3-estimates-and-quotes) · [4 Plans and agreements](#4-plan-specific-agreements-coverage-and-service-cycles) · [5 Conventional and installation](#5-conventional-systems-and-installation-work) · [6 Map](#6-shared-street-map-and-schedule) · [7 Filing interoperability](#7-filing-interoperability) · [8 Cross-cutting](#8-cross-cutting-design) · [9 PR sequence](#9-pr-sequence) · [10 Workers](#10-implementation-workers-and-file-ownership) · [11 Risks](#11-risk-and-effort) · [12 Browser acceptance](#12-browser-acceptance-matrix) · [13 Gates and needs from Justin](#13-validation-gates-and-needs-from-justin) · [14 First step](#14-first-implementation-step)

---

## 0. Ground rules that apply to every PR

These restate standing rules from the handoff, the decisions log and Justin's request. Any implementation PR that breaks one is wrong, even if it passes its tests.

1. **Work and compliance stay separate.** A pumping, repair, installation or other work order is never an aerobic inspection obligation. It never opens a filing, never produces an authority report, never counts as a contract visit and never moves a due date. Only `aerobic_inspection` obligations completed through an inspection job do those things, exactly as today (`apps/api/src/routes/inspections.ts` `completeJob`).
2. **Aerobic behavior is preserved.** Obligations, retests (Hays 10.V.4), due dates, the more-visits warning, the report release rules, MP signing (`reports:sign` plus the person's own active license), sent and confirmed kept apart, and the Montgomery/Hays handling are unchanged. In particular, Montgomery food sites never default to monthly without a recorded contract, permit or confirmation, and the Hays end-of-window rule stays a labeled interpretation. Each PR runs the existing aerobic API and browser tests unchanged.
3. **Demo isolation is server-side and fails closed.** New tables carry `organization_id` with composite tenant foreign keys, so `removeCompanies` in `packages/db/src/reseed.ts` finds them automatically. New files are stored under the organization's key prefix, so `deleteOrganization` removes them. Any new outside service gets a stand-in and a gate in `packages/tasks/src/providers.ts` and `demo-gate.ts`. Demo contacts stay fictional (database triggers from migration 0040). Demo PDFs and CSVs are watermarked or carry the leading notice column.
4. **Public rules, implemented behavior and authority acceptance are three different things.** Real authorities stay drafts. Nothing here says a format is accepted unless dated evidence from that authority says so. There is never a blanket "call every authority": each external question becomes a named gate tied to the pilot ([§13](#13-validation-gates-and-needs-from-justin)).
5. **One accounting stack.** Estimates, deposits and work invoices reuse `invoices`/`invoice_lines`, `invoiceTotals`, `issueDraft`, `openCheckout`, Stripe Connect, refunds and the one-way QuickBooks sync. There is no second ledger, no separate payment path and no change to Aerowise subscription pricing.
6. **Offline exactly once.** Any record a phone creates is keyed by a client-generated id with a unique `(organization_id, offline_client_id)` constraint and retried whole, following the existing inspection sync pattern and the `5e491a0` revision/acknowledge rule.
7. **Environment boundaries.** Staging only. Twilio stays off. Keep `DEMO_MODE`, test providers, `EMAIL_REDIRECT_TO` and synthetic demo contacts. No production change, accounts, purchases, DNS or paid services. No migration of Fieldbase data.
8. **Anything only Justin or the provider can supply** sits behind a stand-in and is listed under [Needs from Justin](#132-needs-from-justin). It is not a reason to leave the software path unplanned.

### 0.1 How each capability is rated

Each capability in §1–§7 gets three ratings:

- **Today**: what `main` at `0906828` actually does, with code paths.
- **Evidence**: how sure we are that providers need it. The scale is *corroborated* (a public product page or authority document shows it), *schema-only* (it appears only in captured definitions, so intended rather than proven) or *unverified*.
- **Questions**: what is still open, and which gate answers it.

### 0.2 Outside evidence and how much it proves

| Source | What it shows | Confidence |
|---|---|---|
| fieldbaseos.com public site (checked by Codex, October 2026) | Pumping, repair and installation jobs on a shared map/schedule; digital inspections; configurable renewal forms; e-sign and payment; plan tiers; optional QuickBooks | Corroborated product claim. It does not tell us how any of these behave. |
| Captured task/service-record schema (Oct 3 local captures, sanitized summary only) | Configurable job type/status, comments, photos, links to invoice and pumping record; gallons, truck, waste type, disposal facility, manifest number, service date, technician | Schema-only. It shows intended support, not proof of complete manifest, legal or operational behavior. The 1,988 facility records are **not** copied. |
| Captured financial packet | 53 `estimate_approval` records; invoice type "Estimate" | Schema plus usage, which suggests estimates are used. Approval semantics are unknown. |
| Captured plan definitions | 122 plans, 79 with configurable fields; priced options; per-plan terms; service templates; system choices Aerobic, Conventional, Lift Station, LPD, Holding Tank; install intake (existing/new system, bedrooms, line lengths, location photo, completion signature); five plan names mention pumping | Schema-only, but strongly suggests that per-plan forms and pumping plans are common. |
| [Fort Bend County OSSF notice, May 2, 2025](https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/environmental-health-documents/forms-library/site-sewage-facility-packet/OSSF-Message---Fieldbase-Software-Update-05-02-25.pdf) | That county worked with a vendor on a compatible CSV export, and providers upload it to the county portal | Corroborates that one county accepted a CSV shape at that date. It says nothing about today's transport, column spec, other counties or Aerowise. Aerowise has no Fort Bend ruleset. |
| IoT/Septilink, automatic acceptance in all counties | Not evidenced | Unverified. Out of scope, not planned. |

---

## 1. General work orders

### 1.1 Today

- `jobs` (migration `0003_jobs.sql`) only allows `type = 'inspection'`. A job is either a contract visit (`obligation_id`) or a retest. The retest link is checked when the job is scheduled (`apps/api/src/routes/schedule.ts` `POST /jobs`) but **not stored**: a retest job has `obligation_id = null` and nothing else, so its origin is lost.
- `scheduleInput` (`packages/domain/src/jobs.ts`) requires `obligationId` XOR `retestOfInspectionId`. `Stop` has no job kind.
- Completion only happens through `PUT /inspections/sync`, which always runs `completeJob`: it completes the obligation, records a compliance event, calls `openFiling`, queues reports and queues an SMS.
- Inspection issues (`issues` table, types `repair_needed`, `pump_out`, `part_replacement`, `callback`, `estimate_required`, `noncompliance`) and service requests (`service_requests`, kinds `alarm`, `odor`, `repair`, `pumping`, `question`, `other`) end up in the inbox. DECISIONS says turning a request into a visit "is left to the office". Neither table links to work. `POST /service-requests/:id/response` takes a `jobId` but inner-joins `service_obligations` (`apps/api/src/routes/readiness.ts`), so it rejects retests and would reject any job without an obligation.
- Invoice lines already have `job_id`. Audit events exist per change (`apps/api/src/lib/audit.ts`).

**Evidence:** corroborated. **Missing:** the whole work-order entity and lifecycle, non-inspection jobs, conversion from issues and requests, tech completion of non-inspection work, and work invoicing.

### 1.2 Model

New tables, all with `organization_id`, `unique (organization_id, id)` and composite foreign keys:

- **`work_types`**: the configurable service menu. Columns: `key`, `name`, `category` (`pumping | repair | installation | maintenance | inspection_other | other`; fixed categories, configurable names), `default_form_template_key` (nullable, see [§5](#5-conventional-systems-and-installation-work)), `default_duration_minutes`, `requires_disposal_record` (true for pumping, see [§2](#2-pumping-and-disposal-records)), `active` and `position`. Each organization is seeded with Pumping, Repair, Installation and Service call. The aerobic inspection is **not** a work type: it stays the contract/obligation path.
- **`work_orders`**:
  - What and where: `number` (per organization, gapless, from a new `organizations.next_work_order_number`, shown as "WO-1001"), `customer_id`, `site_id`, `work_type_id`, `category` (copied), `title`, `description`, `priority` (`normal | urgent`).
  - Lifecycle: `status`, `state_machine_version`, `requested_on`, `completed_at`, `cancelled_at`, `cancel_reason`, `created_by`.
  - Origin: `source_kind` (`office | portal_request | inspection_issue | estimate | contract_cycle`) and `source_id`.
  - Coverage: `coverage_snapshot` (jsonb, see [§4](#4-plan-specific-agreements-coverage-and-service-cycles)).
  - **Duplicate guard:** a unique partial index on `(organization_id, source_kind, source_id) where status <> 'cancelled' and source_id is not null`. One live work order per issue, request or estimate. A second conversion returns the existing one (200, not 201).
- **`work_order_lines`**: planned and actual labor, parts and fees. Columns: `service_item_id` (from [§3](#3-estimates-and-quotes)), `description`, `quantity_milli` (thousandths, for fractional hours and gallons), `unit_price_cents`, `taxable`, `covered_by_contract_id`, `coverage_note` and `source` (`planned | added_in_field`).
- **`work_order_events`**: an append-only activity timeline, like `invoice_events`. Each row has `seq`, `event_type`, `summary`, `actor_user_id`, `details` and `homeowner_visible`. It is the source for the office timeline, the homeowner portal view and conversion history. `audit_events` is still written for every change.
- **`work_order_notes`**: office and technician comments, with `visibility` `internal | customer`.
- **`work_records`**: what the technician recorded at the site. It mirrors `inspections` but has no filing behavior. Columns:
  - Identity: `offline_client_id` (unique per organization), `job_id` (unique), `work_order_id`.
  - Form: `template_id` (a form version from `inspection_templates`, see §5), `values` (jsonb), `status` (`draft | completed`), `validation_status`.
  - Field data: arrival and completion GPS, `access_issue`, `completed_at`.
  - Sign-off: `customer_signoff_id` (nullable, links to `signed_documents`, see §5).
- **`work_attachments`**: photos and files for work. Columns: `offline_client_id` (unique per organization), `work_record_id` or `work_order_id`, `photo_key`, `storage_key` under `${org}/work/${workOrderId}/`, `content_type`, `byte_size`, `sha256`, `captured_at`, `lat`, `lng`, `uploaded_by`. This is a separate table: `attachments.inspection_id` stays `NOT NULL` and inspection code is untouched.

Changes to existing tables, all additive and nullable:

- `jobs`:
  - Widen the `type` check to `('inspection', 'work')`.
  - Add `work_order_id` (composite foreign key) and `retest_of_inspection_id` (composite foreign key, which fixes the lost retest link).
  - Add a check: `type='inspection'` requires `work_order_id is null`; `type='work'` requires `work_order_id is not null`.
  - `obligation_id` may also be set on a `work` job only for a non-aerobic cycle obligation (§4.4).
  - A unique partial index allows one live job per work order. A multi-visit work order is a later extension.
  - Backfill: existing rows stay `inspection`. Old retest jobs keep `retest_of_inspection_id = null`, because the link was never stored. The UI keeps showing them as "extra visit".
- `issues`: add `work_order_id`, set when converted.
- `service_requests`: add `work_order_id`. Fix the response join to `left join service_obligations`, so a response can cite a work job or a retest job. Classification and authority reporting of complaints are unchanged: a request turned into a work order still needs its reportable classification and response recorded exactly as today.

### 1.3 Work order state machine (versioned, like `JOB_STATE_MACHINE`)

`draft → open → scheduled → in_progress → completed`, with `cancelled` reachable from any state except `completed`. Rules:

- `open` means ready to schedule.
- `scheduled` follows its job. Cancelling the job returns the work order to `open`.
- `completed` comes only from the technician's completed `work_record` or an office "complete without a field record" (reason required, audited).
- Invoicing is tracked separately (`billing_status`: `unbilled | invoiced | no_charge`). It is not a lifecycle state, so voiding an invoice never reopens field work.
- Job status and work order status move in the same transaction.

### 1.4 API (new route file `apps/api/src/routes/work-orders.ts`)

| Route | Permission |
|---|---|
| `GET/POST /work-types`, `PATCH /work-types/:id` | `work:read` / `org:manage` |
| `GET /work-orders` (filters: status, category, site, technician, date, source) | `work:read` |
| `POST /work-orders`, `PATCH /work-orders/:id`, `POST /work-orders/:id/cancel` | `work:write` |
| `POST /work-orders/:id/schedule` (creates a `type='work'` job; reuses `assertAssignable`, `nextPosition`) | `schedule:write` |
| `POST /issues/:id/work-order`, `POST /service-requests/:id/work-order` (idempotent conversion; copies description, links back, writes events on both sides) | `work:write` |
| `POST /work-orders/:id/complete` (office completion with reason) | `work:write` |
| `GET /work-orders/:id` (detail with lines, events, notes, record, attachments via signed URLs) | `work:read` |
| `PUT /work/sync`, `PUT /work/:clientId/photos/:photoClientId` (phone, see §8.1) | `work:complete` |
| `POST /work-orders/:id/invoice` (draft invoice from lines, idempotent per work order) | `invoices:write` |

New permissions in `packages/domain/src/roles.ts`:

- `work:read`: owner, office, technician, read_only.
- `work:write`: owner, office.
- `work:complete`: owner, technician.

A technician only sees and completes jobs assigned to them. That is the same check as `/route` and inspection sync today.

`POST /jobs` keeps its current body for inspections. Work jobs are created only through the work-order schedule route, so `scheduleInput` stays compatible.

### 1.5 UI

- **Office:**
  - A new `/work` list and `/work/[id]` detail page with a timeline, lines, notes, photos, the field record, the invoice link and the source link.
  - "Create work order" from a site, customer, inbox issue or service request.
  - The schedule page shows work jobs beside inspections, with a kind badge and filter.
  - The inbox issue and service request cards gain "Turn into work order". If a work order already exists, they show its link instead.
- **`/tech`:** the stop list shows a kind badge, for example "Pumping · WO-1012" next to "Inspection". The stop card opens the work form (§8.1) instead of the inspection form. Safety flags, gate code and on-the-way behave exactly as before.
- **Homeowner portal:** shows scheduled and completed work at their site, customer-visible notes and events, and the completion summary PDF. It never shows internal notes.
- **Demo story:** add one completed pumping work order with a disposal record and invoice, one scheduled repair converted from an inspection issue, and one portal request converted to a work order. Add them in `playDemoStory` (`apps/api/src/demo-story.ts`) through the API, so the conversions are exercised. The public demo, personalized prospect demos and visitor demos all get them, because they share `seedDemoCompany` and `playDemoStory`. A new trial company gets the default work types and no work orders.

### 1.6 Acceptance

- A work order goes from draft through completion and invoice for each category, on office and phone, without creating any filing, report, compliance event or obligation change. Assert counts before and after.
- Converting the same issue or request twice returns one work order. Both sides show the link and history.
- A cross-tenant id returns 404 on every route. A technician cannot read another technician's work order or complete it.
- Every existing aerobic test passes unchanged.

---

## 2. Pumping and disposal records

### 2.1 Today

Nothing is recorded. Pumping exists only as a service request kind and an inspection issue type (`pump_out`). The built-in inspection form v2 records pump-tank sludge in inches (Williamson) as an inspection measurement. That is not a pumping service record.

**Evidence:** corroborated for pumping jobs. Schema-only for the record fields: gallons, truck, waste type, facility, manifest.

**Questions:** the pilot's state and local transporter registration and manifest form, retention period, and whether the receiving facility signs. These go to gate **G-HAUL**. Which facilities the pilot uses goes to **G-FAC**.

### 2.2 Model

- **`vehicles`**: `name`, `plate`, `capacity_gallons`, `registration_reference` (free text; Aerowise does not verify it), `active`.
- **`disposal_facilities`**: organization-scoped. Columns:
  - Identity: `name`, `kind` (`wastewater_treatment_plant | land_application_site | transfer_station | other`), address, lat/lng, `permit_or_registration_number`.
  - Origin: `source` (`entered_by_provider | public_source`), `source_url`, `source_retrieved_on`, `notes`, `active`.
  - No shared national dataset is shipped and nothing is copied from a competitor. An office can add facilities by hand. Later, if a pilot needs it, an admin import from a *named public source* can store `source_url` and the retrieval date per row, subject to that source's terms and gate **G-FAC**.
- **`disposal_records`**: one per pumping event. Columns:
  - Links: `work_order_id`, `job_id`, `work_record_id`, `site_id`, `technician_user_id`, `vehicle_id`, `disposal_facility_id`.
  - What and when: `service_date`, `waste_type` (`septage | grease_trap | holding_tank | portable_toilet | other`, plus `waste_type_note`), `tanks` (jsonb list: compartment or tank label, volume).
  - Volume: `total_volume` (numeric(10,1)) and `volume_unit` (`gallons | liters`; reports always show the recorded unit).
  - Delivery: `delivered_on`, `manifest_reference`, `notes`.
  - Identity and history: `offline_client_id` (unique), `status` (`recorded | corrected`), `supersedes_id`.
  - A correction creates a new row that supersedes the old one. Rows are never edited in place, matching the immutable-report pattern.
  - Supporting files, such as a manifest photo or the facility's receipt, go in `work_attachments` with `photo_key = manifest`.

### 2.3 Flow

- Dispatch: a pumping work order is scheduled like any work.
- Completion: the phone form for a work type with `requires_disposal_record` shows the disposal section. The vehicle defaults to the technician's last vehicle, and the facility is picked from the organization's active list. Volume, waste type and manifest reference are entered in the field. Completion can't finish without volume, unit and waste type. The facility and manifest can be marked "delivered later", which raises an inbox item "Disposal not recorded" until filled in.
- Billing: work order lines can price by gallon (`quantity_milli`). The invoice line description cites the volume.
- History: the site page gets a "Pumping history" panel.
- Export: `disposal_records.csv` joins the data export (`packages/tasks/src/export-task.ts` `EXPORT_TABLES`), with the demo notice column for demo organizations. A date-range "Disposal log" CSV and PDF is available from the office for the provider's own records.

### 2.4 What the UI says and does not say

The labels are "Disposal record" and "Manifest/reference number". Aerowise does **not** say a load is legally compliant, that a manifest satisfies a regulator, or that a facility accepted it. Requirements specific to a regulator are not invented. If the pilot's evidence shows a required manifest field, it is added as a configurable required field after gate **G-HAUL**, with its citation recorded in DECISIONS.

### 2.5 Acceptance

- Offline pumping completion with a manifest photo reaches the office exactly once.
- A correction keeps the original row.
- A pumping job never touches obligations or filings.
- The CSV export of a demo organization carries the notice column.
- Deleting or expiring a demo removes its disposal rows and files.

---

## 3. Estimates and quotes

### 3.1 Today

There is no estimate entity. Reusable parts:

- `invoices`, `invoice_lines`, `invoiceTotals` (one rate per invoice, taxable flag per line, a flat discount spread in proportion).
- `issueDraft` (gapless numbering inside the transaction).
- `signed_documents` (content sha256, typed or drawn signature, IP address and user agent, immutable by trigger; `kind` is limited to `renewal_agreement`).
- The renewal stale-offer guard (`version`, which gives 409 `offer_changed`).
- `openCheckout` (always the full amount due; idempotency key per amount).
- `renewal_addons` (a priced, taxable add-on list).

Blockers found:

- Quantities must be whole numbers.
- Online checkout cannot take a partial amount or deposit.
- QuickBooks refuses any invoice with tax (`packages/quickbooks/src/sync.ts`: `tax_mapping_missing`).

**Evidence:** corroborated by the captured estimate-approval records (schema plus usage). **Questions:** the pilot's estimate terms and deposit policy (Needs from Justin), and QuickBooks tax and deposit handling (gates **G-QBO-TAX** and **G-QBO-DEPOSIT**).

### 3.2 Service items (shared foundation for estimates, work invoices and coverage)

**`service_items`** is a small catalog: `name`, `description`, `unit` (`each | hour | gallon | foot | visit`), `unit_price_cents`, `taxable`, `category`, `active`. Its QuickBooks item mapping uses a new `quickbooks_links.entity_type = 'service_item'`, falling back to the existing default item, so an unmapped item behaves as lines do today.

`renewal_addons` stays as is. §4 links plan options to add-ons rather than migrating them.

`invoice_lines` gets a nullable `service_item_id` and `quantity_milli`. The new column is used when it is present. The existing integer `quantity` stays authoritative for old rows, and the DB check becomes `amount_cents = round(quantity_milli * unit_price_cents / 1000)` when `quantity_milli` is set. `invoiceTotals` is unchanged apart from reading the line amount.

### 3.3 Model

- **`estimates`**:
  - Identity and parties: `number` (gapless, `organizations.next_estimate_number`, shown as "EST-1001"), `customer_id`, `site_id`.
  - Lifecycle: `status`, `current_version`, `expires_on`.
  - Token: `public_token_hash` (only a hash is stored, like portal links).
  - Origin: `source_kind`/`source_id` (inspection issue `estimate_required`, service request, or office), with the same live-duplicate unique index pattern as work orders.
  - Deposit: `deposit_kind` (`none | fixed | percent`) and `deposit_value`.
  - Outcome: `accepted_version`, `accepted_document_id`, `declined_reason`.
  - Conversion: `work_order_id` (unique when set).
- **`estimate_versions`**: immutable after sending. Columns: `version`, `lines` (jsonb snapshot including `optional` and default-selected flags per line), `tax_rate_bps`, `discount_cents`, totals, `terms_text`, `expires_on`, `content_sha256`, `sent_at`. While the estimate is still a draft, the latest version is editable through `estimate_lines`. Sending freezes the version, using the trigger approach of `invoices_freeze`. A revision after sending creates version n+1, and the old public link then shows "This estimate was revised" with the new one.
- **`estimate_events`**: an append-only timeline of sent, viewed, accepted, declined, expired, converted and voided.

### 3.4 State machine

`draft → sent → (viewed) → accepted | declined | expired`, plus `void` from `draft` or `sent`. After acceptance, `converted` is recorded through `work_order_id`. Expiry runs as a queued task on `expires_on`, using the organization's local day as renewals do.

### 3.5 Acceptance and evidence

`POST /estimates/:token/accept` takes `{ version, selectedOptionalLineIds, signerName, signatureKind, signatureImage? }`.

- A stale version gets 409 `estimate_revised`.
- It inserts a `signed_documents` row with `kind = 'estimate_acceptance'` (the kind check is widened) containing the exact version snapshot, the selected options, totals, terms and consent text. It stores the sha256, IP address and user agent as renewals do.
- **Accepting twice is a no-op** that returns the existing acceptance, enforced by a unique index on `estimates.accepted_document_id` and a row lock.
- Decline records the reason. The office can mark an estimate accepted from a paper or phone approval, but must attach evidence (an uploaded file or a typed note). That acceptance is labeled "Recorded by office" and is never shown as a homeowner e-signature.

### 3.6 Conversion, deposits and invoices (exactly once)

1. **On acceptance:** in the same transaction, create the work order (`source_kind='estimate'`, protected by the unique index) with lines copied from the accepted version and the chosen options.
2. **Deposit:** if a deposit is required, create and issue **one** deposit invoice. The link table `estimate_invoices (estimate_id, invoice_id, role)` has `unique (estimate_id, role)` with `role ∈ {deposit, final}`, so a retried accept cannot make a second one.
   - The deposit invoice has one untaxed line, "Deposit for EST-1001", tied to the deposit service item.
   - It is paid through the existing `openCheckout`, which already charges the full amount due of *that* invoice, so no partial-checkout change is needed.
3. **Final invoice:** after completion, `POST /work-orders/:id/invoice` makes the final invoice from the actual work order lines.
   - A paid deposit is applied through a new `invoices.deposit_applied_cents` column, with the total check changed to `total = subtotal − discount + tax − deposit_applied`. The column defaults to 0, which keeps every existing row valid.
   - Tax is computed on the full work, before the deposit. The deposit invoice is untaxed, so tax is counted exactly once.
   - `deposit_applied_cents` can only be set from a paid deposit invoice of the same estimate, and only once (`unique (deposit_invoice_id)` on a small `deposit_applications` table).
4. **Decline or void after a paid deposit:** use the existing refund flow (`/payments/:id/refund`, credit or reverse). Nothing is refunded automatically.
5. **No double charge:** the checkout idempotency key already includes the invoice id and amount due. Webhooks are already idempotent through `stripe_events`. New tests replay accept, checkout completion and the invoice route concurrently.

**Rejected alternative:** a negative "deposit" line on the final invoice. It breaks the proportional discount math in `invoiceTotals` and the `min(0)` line validation.

**QuickBooks:** the deposit invoice syncs normally. The final invoice syncs with an extra non-taxable negative line on a configured "Customer deposits" item that equals `deposit_applied_cents`. That is the usual QuickBooks way to apply a deposit, and it keeps both totals equal. This is unproven against Intuit until gate **G-QBO-DEPOSIT**. Until the deposit item is mapped, such an invoice gets a new `deposit_mapping_missing` conflict, the same way `tax_mapping_missing` works today.

### 3.7 Tax: mixed taxable lines in QuickBooks

Aerowise math already supports taxable and untaxed lines at one rate per invoice. The only blocker is the sync.

The plan:

- Add tax mapping to `quickbooks_connections`: `tax_mode` (`off | taxcode`), `taxable_code_ref`, `nontaxable_code_ref` and `tax_rate_ref`.
- When the mode is on, send `TaxCodeRef` per line and `TxnTaxDetail` with the rate and total. After the create, compare QuickBooks' `TotalAmt` and `TotalTax` with Aerowise's. A difference produces a new `tax_total_mismatch` conflict and nothing is retried silently.
- With the mode off, today's `tax_mapping_missing` behavior and its "enter it yourself" message stay as they are.
- The design must cover companies that use QuickBooks Online automated sales tax, where QuickBooks may recompute tax. That is unknown until gate **G-QBO-TAX**. The fallback is the current conflict, so no wrong total is ever posted.

### 3.8 UI

- **Office:** an `/estimates` list and editor that reuses `InvoiceEditor` patterns, with optional lines, deposit, expiry and terms. Also: send, resend, revise, void, mark accepted with evidence, convert, and an estimate timeline. "Create estimate" appears on the inbox `estimate_required` issue and on service requests.
- **Homeowner:** a public `/estimate/[token]` page that shows the version, lets them pick options with a live total, sign (the same typed or drawn component as renewals), decline with a reason and pay the deposit. The portal lists the homeowner's estimates.
- **Demo:** one sent estimate, one accepted with a paid deposit (test payment provider) and converted, and one expired. Demo email is recorded in the test outbox only.

---

## 4. Plan-specific agreements, coverage and service cycles

### 4.1 Today

- `plans` holds name, customer type, term, visits, price, billing frequency and `service_type` (only `aerobic_inspection`).
- Contracts copy those values when created. `service_obligations` has one row per visit window.
- The agreement text is one per organization: `organizations.renewal_terms` or `DEFAULT_RENEWAL_TERMS`.
- Renewal add-ons are global to the organization, quantity 1, priced and taxable.
- Signing snapshots `AgreementContent` into `signed_documents` with a sha256.
- There are no per-plan terms, intake questions, coverage, conditional fields or non-inspection cycles.
- Inspection templates are already versioned and support `showWhen` conditions and photo requirements (`packages/domain/src/inspections.ts`).

**Evidence:** corroborated for configurable renewal forms and plan tiers. Schema-only for priced options, per-plan terms and pumping plans.

**Questions:** the provider's real tier definitions (gate **G-COVERAGE**) and legal text review (gate **G-LEGAL**).

### 4.2 Model: versioned plan definitions

- **`plan_versions`**: immutable once a contract or renewal references it. Columns:
  - `plan_id`, `version`.
  - `terms_text`: nullable. Null means "use the organization terms", which keeps current behavior the default for every existing plan.
  - `intake_template_id`: nullable, a form version (§5) for questions asked at signing, with conditional fields through the existing `showWhen`.
  - `options`: jsonb list of `{ addonId | serviceItemId, priceCents, taxable, required, default }`.
  - `coverage`: jsonb list of `{ category | serviceItemId, rule: included | percent_off | excluded, percentOff?, limitPerTerm? }`.
  - `service_cycles`: jsonb list of `{ serviceType, visitsPerTerm | everyMonths }`.
  - `created_by`, `created_at`.

  `plans` gains `current_version_id`. Editing a plan in the office creates a new version. Contracts and renewals reference `plan_version_id` (new nullable columns on `contracts` and `renewals`).

- **Backfill:** one migration creates v1 for every existing plan. It uses `terms_text = null`, no intake, no options or coverage, and `service_cycles = [{ serviceType: 'aerobic_inspection', visitsPerTerm }]`. It sets `contracts.plan_version_id` where `plan_id` matches. Contracts keep their copied columns (term, visits, price), which stay authoritative for existing obligations, so **nothing about an existing contract changes**.
- **Agreement snapshot:** `AgreementContent` gains the plan version's resolved terms, the intake answers, the selected options with prices, the coverage summary and the cycles. It stays hashed and immutable in `signed_documents`. `contracts.agreement_document_id` already exists as `signed_document_id`. Office-created contracts without signing get a non-signed `agreement_snapshot` jsonb on the contract, so coverage on a repair invoice always reads a frozen copy.
- **Basic, Gold and Platinum** are just plan names. Benefits come only from the `coverage` rules in the plan version the contract was made under. A Gold label with no coverage rules covers nothing, and the UI says "No coverage rules" rather than guessing.

### 4.3 Coverage in practice

- When a work order is created for a site with an active contract, Aerowise evaluates the frozen coverage and writes `work_orders.coverage_snapshot` (which contract, which rules matched, remaining uses).
- **Office** sees "Covered by Gold (contract #…): pump replacement parts 100%, labor 20% off, 1 of 2 service calls used".
- **Technician** sees a short "Covered" or "Not covered, quote needed" badge on the stop. No prices are shown to the technician unless the organization turns that on.
- **Repair invoice:** covered lines are priced with the rule applied and carry `covered_by_contract_id` and a coverage note. The office can override with a reason, which is audited.
- **`coverage_uses`**: `unique (contract_id, rule_key, work_order_id)` counts uses idempotently. A cancelled work order releases its use.
- A covered amount of zero is still an invoice line at zero with the note, so the homeowner sees the benefit. Nothing changes the plan's own installment billing.

### 4.4 Recurring cycles that are not aerobic inspections

- `SERVICE_TYPES` grows to `['aerobic_inspection', 'pumping', 'maintenance']`. `insertContract` (`packages/renewals/src/contracts.ts`) builds obligations per cycle:
  - Aerobic visits use today's `buildTermSchedule` and `buildAnchoredSchedule`, including authority more-visits rules and `acceptVisits`, unchanged.
  - Pumping and maintenance cycles use a plain interval schedule. They are **never** passed through authority rules and never become filings.
- **Scheduling a non-aerobic obligation** creates a work order (`source_kind='contract_cycle'`) and a `type='work'` job carrying the `obligation_id`. Completing that job completes the obligation.
- **Guards:** `openFiling`, `contractVisitDeadline`, the due list's compliance labels and the more-visits warning filter on `service_type = 'aerobic_inspection'`. A regression test asserts that a pumping obligation can never reach `openFiling`.
- **Due list:** a service-type filter is added. Aerobic visits stay the default view, so the current office experience is unchanged.
- A plan whose only cycle is pumping is a pumping service plan, not a relabeled aerobic inspection.

### 4.5 Builder UI

- `/plans/[id]` gains tabs: Terms (with preview), Intake questions (the form builder from §5), Options, Coverage, Cycles and Versions. Versions are read-only history with which contracts use each.
- "Preview agreement" renders exactly what the homeowner will sign. The renewal page and office contract creation use the plan version's intake and options.
- The existing organization terms stay the default. A plan with no overrides behaves exactly like today.

---

## 5. Conventional systems and installation work

### 5.1 Today

- `wastewater_systems.system_type`, `treatment_type` and `disposal_type` are free text.
- Every plan and obligation is `aerobic_inspection`.
- There is one active organization inspection template (versioned). Forms support `pass_fail`, `boolean`, `text`, `number` and `select` fields, conditional `showWhen` and photo requirements.
- The phone has **no signature capture**. Homeowner drawn signatures exist only on the renewal web page.

**Evidence:** schema-only for the system categories and install intake. Corroborated for installation jobs.

### 5.2 Model

- `wastewater_systems.system_category`: nullable enum `aerobic | conventional | low_pressure_dosing | drip | holding_tank | lift_station | other | unknown`. The free-text columns are kept.
  - Backfill: `aerobic` for systems at sites with an `aerobic_inspection` contract, `unknown` otherwise. Nothing is guessed from text.
  - Creating an `aerobic_inspection` contract on a site whose systems are all non-aerobic returns a warning that needs explicit confirmation, like `acceptVisits`, rather than a hard refusal, because records may be wrong.
- **Forms:** `inspection_templates` gains `purpose` (`inspection | work | intake`, default `inspection`). Existing rows stay `inspection`. The template definition schema is reused unchanged, with one addition: a `signature` requirement block, `{ key, label, signer: customer | technician, required }`.
  - Work types point at a template key.
  - Templates stay immutable per version.
  - Built-in starter templates are seeded for pumping (tank count, sludge/scum observations, lid condition, disposal section), conventional service (tank and baffle checks, distribution box, field observations), repair (problem, cause, parts used, photos before and after) and installation (existing or new system, bedrooms, tank sizes, line lengths, install-location photos, as-built sketch photo, customer completion signature).
  - **Configurable:** every form's fields, photos and signature requirements, per organization, versioned. **Specialized (code):** the disposal section (§2, structured records rather than form values) and the aerobic inspection with its authority requirements (unchanged).
- **Signatures on the phone:** a new drawn or typed signature pad in `/tech`. It is stored offline as a blob (§8.1) and uploaded to a `signed_documents` row with `kind = 'work_completion'`, holding a hashed snapshot of the work record summary the customer saw. Only a homeowner signature on a summary of the work done, not a regulatory signature. MP report signing is unchanged and remains office-side with license checks.
- **Completion document:** a "Work completion summary" PDF (packages/reports) is customer-facing only. It is watermarked for demo organizations and listed in the portal. It is never an authority report.

### 5.3 Boundaries

There is no engineering design, permit application, site evaluation or approval automation. Installation support covers intake, checklist, photos, sign-off, scheduling and billing only. A conventional site with no aerobic contract never gets aerobic reporting. Nothing applies an authority's aerobic report rules to pumping, conventional or install jobs.

---

## 6. Shared street map and schedule

### 6.1 Status of the map work (PR #97 head `a96f8b2`, read 2026-10-07 21:40Z)

Draft, unmerged, local checks still running when read. As built on that head:

- `apps/web/components/map/StreetMap.tsx`: a MapLibre GL JS 6.11 component (bundled, loaded only when shown). Props are `routes: StreetMapRoute[]` (`{ id, name?, color, stops: StreetMapStop[] }`), `start`, `returnToStart`, `selected`, `onSelect(key)`, `fitKey`, `label` and `onUnavailable`. `StreetMapStop` extends `RouteMapStopInput` (`{ key: jobId, lat, lng, number, done }`) with a `title`.
- `packages/domain/src/route-map.ts`: `planRouteMap` places stops, lists unlocated ones and fans out stops at the same spot. It also draws straight visit-order segments labeled `1 → 2` and marks stops outside the coverage bounds.
- `apps/web/components/RouteMap.tsx` (office, built from `Stop[]` and the routing day) and `apps/web/components/tech/TechRouteMap.tsx` (phone List/Map switch, list by default).
- The tiles are one PMTiles file served same-origin at `/map-data/basemap.pmtiles` (`MAP_TILES_FILE`), with local Noto Sans glyphs. A synthetic e2e fixture is included. No real extract has been installed or measured yet. The recommended Central Texas box does not cover the north and east Texas research counties.
- `DemoGatedGeocoder` (`packages/tasks/src/demo-gate.ts`) sends demo-company addresses only to the test geocoder on any server.
- Documentation is in `docs/engineering/MAP.md` and the RUNBOOK section "Street map on staging".
- **Not included:** road-following routing, traffic, navigation and offline basemap (MAP.md says tiles are not cached offline). The stop list stays available whenever the map fails.

SW-10 must be rebased on whatever #97 becomes when it merges. If its interface changes in review, the merged code wins over this summary.

### 6.2 What this plan adds on top (SW-10, after #97 merges)

- **Data:** `Stop` gains the optional fields `kind: 'inspection' | 'work'`, `workOrder: { id, number, category, title } | null` and `durationMinutes`. `StreetMapStop` gains an optional `glyph` (or `kind`) so a marker can show its kind without changing the number, the technician color or the done state. `planRouteMap` needs no change: work stops are ordinary route stops keyed by job id.
- **Pins and filter:** a distinct marker glyph per category (inspection, pumping, repair, installation, other). The office gets a kind filter that hides markers and their order segments only for display. The route order itself is untouched.
- **Routing:** work jobs live in `jobs`, so `/routing/day`, `/routing/optimize` and the `/route` download include them once `stopQuery` returns them. One change is needed in `packages/routing`: a per-stop service time (`durationMinutes` from the work type) instead of only `routeStopMinutes`.
- **Labels:** keep #97's "straight lines, not roads" key and the "estimated from straight-line distance, without traffic" travel wording. There are no ETAs, traffic or turn-by-turn claims, and no offline basemap claim unless a later PR implements and tests one.
- **Demo:** work stops in demo companies use the same synthetic coordinates. New addresses go only through `DemoGatedGeocoder`.

Files owned by #97 (`StreetMap.tsx`, `RouteMap.tsx`, `TechRouteMap.tsx`, `StopList.tsx`, `route-map.ts`, `/map-data`, `public/map`, `MAP.md`) are not edited in parallel. SW-10 starts from the merged map.

---

## 7. Filing interoperability

### 7.1 Today

- One adapter: `EmailManualAdapter` (`email-manual@2`, `packages/compliance/src/adapter.ts`). `adapterFor()` always returns it.
- Submission methods are `email` and `manual_export` (DB check in 0006).
- Filing states are versioned, and `sent` and `confirmed` are "never merged". There is no "signed" state: an unsigned report holds the filing with the `AWAITING_SIGNATURE` review reason.
- Immutable submission packages include a cover sheet and official form fill (`packages.ts`).
- There is no authority CSV export: the only CSVs are the full data export.

### 7.2 What can be built from public sources now (SW-11)

- A **per-authority export framework**. A ruleset version may declare `export: { format: 'csv', columns: [...], encoding, dateFormat, filename }`, with each column mapped from the canonical inspection, site, permit, provider and filing fields.
  - `submission_method` adds `csv_export`. Producing the file moves the filing to an "exported" note in its package, **not** to `sent`.
  - The provider records the upload or send with the existing `mark-sent` route plus evidence, and the acknowledgment with `confirm`. Signed, sent and acknowledged stay distinct.
  - Demo exports carry the notice column.
  - The framework is tested only with the fictional `tx-example-county` ruleset. Real authorities stay drafts and get no `export` block until G-AUTH-CSV is satisfied for that authority.
- The existing email and manual-portal fallback stays the default for every real authority.

### 7.3 What needs provider or authority evidence (gate G-AUTH-CSV)

The pilot authority's current accepted column specification and file naming, its upload channel and receipt meaning, and one accepted sample from the provider, recorded in `/admin/rulesets/<key>` evidence. If the pilot is under Fort Bend, the 2025 notice shows a compatible CSV existed for one vendor. We would still need the county's spec itself, and possibly a Fort Bend draft ruleset built from primary sources. Nothing is claimed statewide. Adding an `export` block for a real authority is a separately reviewed immutable ruleset version, as the W12 process requires.

---

## 8. Cross-cutting design

### 8.1 Offline technician app (the largest risk)

**Today** (`apps/web/lib/offline`):

- There is one IndexedDB database per tenant and user, at `DB_VERSION = 1`, with stores `kv`, `inspections` (keyed by `jobId`), `photos` and `outbox`.
- Outbox ops are `sync` or `photo`, keyed by `inspectionClientId`.
- Retries are classified by `RetryLater`. Ops that fail permanently stay failed and visible.
- The revision/acknowledge rule from `5e491a0` preserves newer edits.
- Cache handling for ended demos (STG-03) is per tenant.
- The service worker never caches `/api/`.

**Plan:**

- Bump to `DB_VERSION = 2`. The upgrade adds `work` (local work records keyed by `jobId`) and `signatures` (blobs keyed by `clientId`). The upgrade keeps every existing store and its data, and still adopts the legacy shared database. A test opens a v1 database holding pending inspection ops, upgrades it, and syncs those ops exactly once.
- Outbox ops become a tagged union: `{ kind: 'inspection-sync' | 'inspection-photo' | 'work-sync' | 'work-photo' | 'signature', ... }`. Existing queued v1 ops (`sync`/`photo`) are read as their inspection equivalents, and no queued op is dropped.
- `PUT /work/sync` mirrors `PUT /inspections/sync`. It sends the whole record every time, is idempotent on `offline_client_id`, treats a completed record as final, rejects reuse of a client id for a different job, and checks the assignee. Disposal records and signature references ride in the payload with their own client ids. The photo and signature uploads mirror the inspection photo route (`config.imageUpload`, sha256, `ON CONFLICT DO NOTHING`).
- `/route` returns work stops with their form template ids. The phone caches each needed template version (generalizing `template:active` to `template:<id>`, which already exists for lookups). It also caches the organization's vehicles, facilities and work types for the day, so the form works without signal.
- `acknowledgeSync` and the `RetryLater` classes are reused generically.
- STG-03 cleanup (`forgetTenant`, `pendingFor`) counts pending work ops as well as inspection ops.

**Acceptance:** two pumping and one install completed with no signal, each with photos and a customer signature. Then reload, reconnect, and confirm the office has each record exactly once. A newer phone edit made during an in-flight sync is preserved. An ended demo clears work data. Another company's sign-in on the same phone stays separate.

### 8.2 Data export, backup and restore, demo lifecycle

- Every new table is added to `EXPORT_TABLES` where it is customer data (work orders, lines, events, disposal records, estimates, plan versions), and to the API test truncate list.
- `pg_dump` and file backups pick up new tables and the `${org}/work/` and `${org}/estimates/` prefixes automatically. SW-12 repeats the scratch restore check from the RUNBOOK with the new data present.
- Demo reset and expiry rely on `organization_id` (reseed's automatic table discovery) and the key prefix. A test asserts that a reseeded public demo leaves no work, disposal or estimate rows and that prospect demos keep theirs.

### 8.3 Queue and providers

- New tasks:
  - `estimate.expire` (dedupe per estimate and version).
  - `estimate.render` and `work.render_summary` (PDFs).
  - `estimate.send` (through the existing gated email transport and test outbox).
- QuickBooks gains `service_item` mapping, the tax mode and deposit mapping. No new outside provider is introduced, so no new gate class is needed. The geocoder gating belongs to the map thread.

### 8.4 Versioning choices

| What | How it is versioned |
|---|---|
| Work order and estimate state machines | `state_machine_version` per row, like `jobs` and filings |
| Forms | Existing immutable template versions |
| Plans | `plan_versions`, immutable once referenced |
| Agreements | `signed_documents` snapshots with sha256 |
| Estimates | `estimate_versions`, frozen once sent |
| Authority exports | Ruleset versions |
| Disposal records | Superseding rows |

---

## 9. PR sequence

Each PR is a draft until local checks pass on its exact head ([§9.2](#92-validation-for-every-implementation-pr)). Codex reviews and merges. Migrations are forward-only and additive. Numbers are assigned in merge order starting after `0047`: **only one migration-carrying PR is open for merge at a time**, and a PR that loses the race renumbers before merge (DECISIONS records that renumbering leaves stale local test databases). Every PR updates its ROADMAP.md row, adds demo data for its feature, records ambiguous choices in DECISIONS.md and keeps the existing aerobic tests green.

| # | PR | Depends on | Scope | Acceptance highlights | Migration |
|---|---|---|---|---|---|
| SW-0 | This plan | none | `docs/engineering/SERVICE-WORKFLOWS-IMPLEMENTATION-PLAN.md`, a ROADMAP row | Links resolve; lint and typecheck pass | none |
| SW-1 | **Work foundation** | SW-0 | `work_types`, `work_orders`, `work_order_events`, `work_order_notes`, `work_order_lines` (without service items), jobs `type='work'`/`work_order_id`/`retest_of_inspection_id`, `issues.work_order_id`, `service_requests.work_order_id` plus the response join fix, permissions, routes from §1.4 except sync and invoice, office `/work` list/detail/create/schedule, inbox conversion buttons, schedule kind badge, demo story entries | §1.6; zero filings or obligations touched; converting twice gives one work order; the retest link is stored for new retests | yes (one) |
| SW-2 | **Technician offline work** | SW-1 | IndexedDB v2, outbox union, `work_records`, `work_attachments`, `/work/sync`, photo route, `/route` work stops, `/tech` work form (generic template renderer reused from `InspectionForm`), signature pad and `signed_documents.kind='work_completion'`, `purpose` on templates and the starter work templates | §8.1 acceptance; v1→v2 upgrade with pending inspection ops; existing offline e2e unchanged | yes |
| SW-3 | **Service items and work invoicing** | SW-1 | `service_items`, `invoice_lines.service_item_id`/`quantity_milli`, invoice from a work order (idempotent per work order), QuickBooks `service_item` mapping with default-item fallback | One invoice per work order under concurrent calls; old invoices are byte-identical in QuickBooks payloads; untaxed work invoices sync | yes |
| SW-4 | **QuickBooks mixed tax** | SW-0 (independent) | `tax_mode`/code refs on the connection, `TaxCodeRef`/`TxnTaxDetail` payload, `tax_total_mismatch` conflict, setup UI on `/quickbooks` | The test QuickBooks provider round-trips mixed lines; mode off keeps today's conflict; sandbox evidence for G-QBO-TAX recorded separately | yes (small) |
| SW-5 | **Estimates** | SW-1, SW-3 (SW-4 for taxed sync) | §3.3–§3.8: estimates, versions, events, public page, acceptance (`signed_documents.kind='estimate_acceptance'`), deposit invoice, `deposit_applied_cents`, `deposit_applications`, conversion, expiry task, portal list, QuickBooks deposit line plus `deposit_mapping_missing` | Concurrent accept, accept replay and checkout replay create one work order, one deposit invoice and one charge; revised version gives 409; demo uses the test payment provider only | yes |
| SW-6 | **Pumping and disposal** | SW-1, SW-2 | `vehicles`, `disposal_facilities`, `disposal_records`, the disposal section in the phone form, "delivered later" inbox item, site pumping history, CSV and PDF disposal log, export entries | §2.5; no compliance wording | yes |
| SW-7 | **System categories, conventional and installation** | SW-2 | `wastewater_systems.system_category` plus backfill, the aerobic-contract warning, conventional, repair and install starter forms and intake, work completion summary PDF, portal listing | No aerobic reporting on non-aerobic work; install offline with signature exactly once | yes |
| SW-8 | **Plan versions, terms, options, coverage** | SW-3 (service items), SW-1 | `plan_versions` plus v1 backfill, `contracts`/`renewals.plan_version_id`, `agreement_snapshot`, plan builder tabs, agreement preview, intake at renewal, options linked to add-ons, coverage evaluation, `coverage_uses`, covered lines on work invoices | Existing contracts unchanged after backfill (same obligations, same renewal text); covered repair invoice shows rule and note; override audited | yes |
| SW-9 | **Non-inspection service cycles** | SW-8, SW-6 | `SERVICE_TYPES` += `pumping`, `maintenance`; cycle obligations; scheduling them as work jobs; filters on `openFiling`/deadlines/due list | A pumping cycle never reaches filings; aerobic schedules for Hays, Montgomery and Williamson fixtures are byte-identical | yes |
| SW-10 | **Work on the street map** | #97 merged, SW-2 | `Stop.kind`/`workOrder`/`durationMinutes`, pins and filter, per-stop service time in `packages/routing` | Same-origin network check still passes; honest estimate labels; optimize includes work stops | none |
| SW-11 | **Authority export framework** | SW-0 (independent, in compliance) | Ruleset `export` block, `csv_export` method, export file in the submission package, Example County fixture only | Signed, sent and confirmed unchanged; demo notice column; no real-authority block | yes (check widening) |
| SW-12 | **Cross-feature walkthrough** | all above | Full §12 matrix, scratch backup/restore with new data, screenshots, handoff/README/ROADMAP update | Every row in §12 passes on one integration SHA, recorded with exceptions | none |

### 9.1 Merge, deploy and rollback for each PR

- **Merge:** Codex reviews the draft and the local check record, then squash-merges. A schema PR merges only after the previous migration PR is on `main`. The branch merges `main` and reruns checks if it moved.
- **Deploy:** staging only, through the documented manual workflow in [DEPLOY.md](DEPLOY.md) and [RUNBOOK.md](RUNBOOK.md), run by Codex. `DEMO_MODE` stays on. Run the migration, then the public demo reseed so the new demo story appears, then a quick role walk (owner, office, tech) on the new feature. Production stays pinned until Justin separately authorizes it.
- **Rollback:** every migration is additive, with nullable columns, new tables and widened checks. Rolling back the application to the previous SHA leaves the new columns unused and keeps old code working. Exceptions to watch:
  1. SW-1 widens `jobs.type`. Old code reading a `type='work'` row in `stopQuery` would show it as an inspection. Rollback therefore means cancelling open work jobs first (a script in the RUNBOOK).
  2. SW-2's IndexedDB v2 cannot be downgraded in the browser. The v1 code must tolerate a v2 database, so SW-2 ships a guard in which unknown stores are ignored. That is tested by loading v1 code against a v2 database.
  3. SW-5's total check change is compatible because the default is 0.

  If a migration itself must be undone, restore from the pre-deploy backup as the RUNBOOK describes. No down migrations are written, following the repository's forward-only rule.

### 9.2 Validation for every implementation PR

Hosted Actions cannot start (account minutes), so each PR runs these on its exact head and posts the SHA, commands, results and exceptions on the PR:

```sh
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level=high
pnpm lint
pnpm typecheck --force
TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:5432/aerowise_test pnpm test --force
pnpm db:seed            # fresh database, plus an upgrade-path run from the previous main
pnpm build
pnpm --filter @aerowise/web build && CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm --filter @aerowise/web e2e
./scripts/compose-smoke.sh   # with the documented scratch Dockerfile/override exception
```

Also run the shellcheck and compose `config -q` steps from `.github/workflows/ci.yml` when deploy files change. List exceptions separately (Render schema 403, IPv4 nginx copy, mirror.gcr.io images, scratch Docker override, any sandbox interruption). Never claim hosted CI passed. For a migration PR, run the upgrade-path check: seed at the previous `main` in a worktree, then `pnpm db:migrate` on the head.

---

## 10. Implementation workers and file ownership

These are proposed only. **No worker starts until Justin says so.** Suggested concurrency is two or three at once, because of Justin's usage limits. Shared foundations land first through one owner.

| Worker | PRs | Owns (edits only here, plus its own tests) | Must not edit |
|---|---|---|---|
| **A: Work foundation** | SW-1, then SW-3 | `packages/domain/src/work*.ts`, `service-items.ts`, roles additions, `apps/api/src/routes/work-orders.ts`, `schedule.ts` work job paths, `readiness.ts` response join, office `/work` pages and inbox buttons, its migrations, `schema.ts` sections for its tables, `apps/api/src/lib/invoices.ts` (SW-3) | Offline lib, compliance package, renewals package |
| **B: Technician offline** | SW-2, then SW-10 | `apps/web/lib/offline/**`, `apps/web/app/tech/**`, `apps/web/components/tech/**`, `apps/api/src/routes/work-sync.ts`, template `purpose`, starter work templates; after #97 merges, `packages/routing` service time and pin props | Inspection sync server code (read-only reference), invoices, map files until merged |
| **C: Billing and estimates** | SW-4, then SW-5 | `packages/quickbooks/**`, `packages/domain/src/estimates.ts`, `apps/api/src/routes/estimates.ts`, public `/estimate/[token]`, office `/estimates`, deposit columns in its migration, the checkout reuse layer | `invoices.ts` lib core (A owns it; C adds through a reviewed hook landed in SW-3), offline lib |
| **D: Plans and contracts** | SW-8, then SW-9 | `packages/renewals/**`, `packages/domain/src/contracts.ts`, `renewals.ts`, `schedule.ts` (domain), `apps/api/src/routes/contracts.ts`, `renewals.ts`, `/plans` and `/renewals` pages, compliance `openFiling` service-type guard (single-line, coordinated with F) | Offline lib, quickbooks |
| **E: Pumping and systems** | SW-6, SW-7 | Disposal/vehicle/facility domain and routes, site pumping history, `crm.ts` system category, reports work summary PDF, phone disposal section **delivered as a component that B mounts** | Offline store schema (asks B) |
| **F: Filing interop** | SW-11 | `packages/compliance/**` (export framework), ruleset schema, Example County fixture | Real-authority rulesets (drafts stay as they are) |

**Waves:**

1. A (SW-1). C (SW-4) and F (SW-11) may run alongside, because they touch separate packages. Their migrations queue behind SW-1.
2. B (SW-2) and A (SW-3).
3. C (SW-5), E (SW-6, then SW-7) and D (SW-8).
4. D (SW-9), B (SW-10, after #97 merges), then one owner for SW-12.

**Shared files:** `packages/db/src/schema.ts`, `apps/api/test/helpers.ts` (truncate list), `packages/tasks/src/export-task.ts`, `roles.ts`, `demo-story.ts`, ROADMAP.md and DECISIONS.md are edited by several PRs. Each PR appends only its own section and merges `main` before review, so conflicts stay small and textual.

---

## 11. Risk and effort

Effort is relative (S, M, L, XL) and assumes the conventions above. No calendar dates are given.

| Area | Effort | Main risks | Mitigation and assumptions |
|---|---|---|---|
| SW-1 Work foundation | L | Widening `jobs.type` affects every stop query and the due list; mixing work into inspection counts | Explicit `type` filters in each existing query, with a test per query; zero-filing assertions |
| SW-2 Offline work | XL | IndexedDB upgrade with queued ops; signature blobs; exactly once across three record kinds; physical phone behavior | v1→v2 upgrade tests; reuse the revision/acknowledge rule; gate G-DEVICE on a real phone before pilot reliance |
| SW-3 Service items and invoicing | M | Fractional quantities change line math | `quantity_milli` only on new rows; old rows untouched; QuickBooks payload snapshot tests |
| SW-4 Mixed tax in QuickBooks | M | Automated sales tax may recompute; totals drift | Compare after create, raise a conflict and never post a wrong total; G-QBO-TAX |
| SW-5 Estimates and deposits | L | Double conversion or charge; deposit application in QuickBooks | Unique indexes and row locks; replay tests; G-QBO-DEPOSIT; refunds stay manual |
| SW-6 Pumping and disposal | M | Implying regulatory compliance; facility data licensing | Neutral wording; only provider-entered or cited public facility data; G-HAUL, G-FAC |
| SW-7 Conventional and installation | M | Misclassified existing systems | Backfill only from aerobic contracts; warning instead of refusal |
| SW-8 Plan versions and coverage | XL | Backfill must not change any existing contract, renewal text or obligation; legal text | v1 backfill uses `terms_text=null`; snapshot equality tests on seeded and demo data; G-LEGAL, G-COVERAGE |
| SW-9 Service cycles | L | A pumping obligation reaching filings or deadlines | Service-type guards plus negative tests; aerobic fixture schedules byte-identical |
| SW-10 Map work pins | S–M | Dependency on an unmerged branch | Start only after the merge; additive `Stop` fields |
| SW-11 Export framework | M | Over-claiming acceptance | Example County only; G-AUTH-CSV before any real block |
| SW-12 Walkthrough | M | Sandbox interruptions | Record exceptions; one integration SHA |

The largest assumptions are that the pilot actually uses pumping, installation or estimates (Needs from Justin) and that a QuickBooks sandbox is available for G-QBO checks with test credentials Codex already holds.

---

## 12. Browser acceptance matrix

SW-12 runs the full matrix on one integration SHA. Each feature PR runs its own rows. Phone rows use the e2e Pixel 7 profile; a physical phone is gate G-DEVICE.

| # | Scenario | Org types | Device | Expected |
|---|---|---|---|---|
| 1 | Create, schedule and complete each work category (pumping, repair, install, other) | Public demo, personalized demo, trial, real-test | Office desktop + tech phone | Lifecycle and events correct; no filing, report, compliance event or obligation change |
| 2 | Aerobic inspection regression: schedule, offline complete, sign, file, confirm, retest | Same | Both | Unchanged results versus `0906828` baseline tests |
| 3 | Offline: two work jobs plus one inspection completed with no signal, photos and signatures, reload, reconnect | Demo and trial | Phone | Each record, photo and signature arrives exactly once; newer in-flight edits preserved |
| 4 | IndexedDB v1→v2 upgrade with pending inspection ops | Trial | Phone | Pending ops sync once; nothing lost |
| 5 | Convert an inspection issue and a portal request to work, twice each | All | Office | One work order each; history on both sides |
| 6 | Pumping record with "delivered later", then completed; correction | Demo and trial | Phone + office | Inbox item raised then cleared; original row kept |
| 7 | Estimate send, view, revise, accept old version (409), accept current, pay deposit, convert, complete, final invoice | Demo (test payments) and trial | Homeowner phone + office | One work order, one deposit invoice, one charge; final amount due = total − deposit |
| 8 | Concurrent double accept and checkout replay | Trial | API + browser | Idempotent; no double charge |
| 9 | Decline after deposit, then refund through the existing flow | Trial | Office | Refund recorded; QuickBooks refund receipt where connected |
| 10 | Mixed taxable invoice with QuickBooks tax mode off and on (test provider) | Trial | Office | Off gives today's conflict; on syncs, or a mismatch conflict |
| 11 | Plan builder: new version with terms, intake, options, coverage; renewal signed; repair invoice on covered site | Trial and personalized demo | Office + homeowner | Snapshot frozen; coverage shown to office and tech; covered line note; override audited |
| 12 | Existing contracts after the plan-version backfill | Seeded and demo | Office | Same obligations, agreement text and renewal amounts as before |
| 13 | Pumping cycle plan | Trial | Office + phone | Cycle obligations scheduled as work; never reach filings |
| 14 | Conventional site and installation with a completion signature | Trial | Phone | No aerobic reporting; summary PDF in the portal |
| 15 | Map with mixed kinds (after #97 merges) | Demo and trial | Office + phone | Pins and filter correct; same-origin requests only; estimate labels honest |
| 16 | Authority CSV export on Example County | Demo | Office | File has the demo notice column; filing stays unsent until mark-sent; confirm separate |
| 17 | Tenant isolation: every new route with another org's ids | All | API + browser | 404 |
| 18 | Roles: read_only cannot write; technician sees only own work; office cannot change org-level work types | All | Both | 403 or hidden as specified |
| 19 | Cancelled or expired visitor demo, ended prospect demo | Demo | Phone + office | Work data cleared from the phone (STG-03); server rows removed by reset or expiry; prospects kept on the nightly reseed |
| 20 | Read-only (lapsed subscription) organization | Trial | Office + phone | Writes refused with `organization_read_only`; phone retries later without losing work |
| 21 | Data export includes new CSVs; scratch backup and restore with new data | Trial and demo | Ops | New tables and files restored; demo CSVs marked |
| 22 | Outbound requests during the demo | Demo | Both | No real email, SMS, payment, QuickBooks or geocoding call; test outbox only |

---

## 13. Validation gates and needs from Justin

### 13.1 Gates

These gates never stop the software from being built. Each one decides only whether a real-world claim or real-authority configuration may be switched on.

| Gate | Question | Evidence needed | Blocks |
|---|---|---|---|
| **G-QBO-TAX** | Do mixed taxable invoices post with matching totals, including with automated sales tax? | Intuit sandbox round trip recorded by Codex | Turning tax mode on for a real company |
| **G-QBO-DEPOSIT** | Does a deposit-item negative line keep the totals equal? | Sandbox round trip | Deposit invoices syncing for real companies |
| **G-HAUL** | Which transporter registration and manifest fields does the pilot provider's jurisdiction require, and what is the retention period? | The provider's current manifest form and registration, plus a primary-source citation | Any field marked "required by regulation" |
| **G-FAC** | Which facilities does the pilot use, and is there a usable public list? | Provider list, or a named public source and its terms | Bulk facility import |
| **G-AUTH-CSV** | What is the pilot authority's accepted export spec, upload channel and receipt? | Authority spec plus one accepted sample, logged as evidence | A real-authority `export` block |
| **G-COVERAGE** | What do the provider's real tiers cover? | Redacted plan documents and contracts | Seeding real tier definitions (demo uses fictional tiers) |
| **G-LEGAL** | Is the estimate, agreement and sign-off text acceptable? | Legal review | Use with real homeowners |
| **G-DEVICE** | Does a physical phone handle camera, signature, close, reopen and reconnect? | Physical-device run | Field-pilot reliance |
| **G-STRIPE-DEPOSIT** | Do Stripe test-mode deposit, payment and refund work on staging? | Staging walkthrough with test keys (no new account) | Real deposits |

### 13.2 Needs from Justin

Each item has a stand-in so the build can go ahead without it.

1. **Pilot provider and actual permit authority.** These are already open in the handoff. They decide G-AUTH-CSV and G-HAUL scope. Stand-in: Example County and fictional data. *Recommendation: answer this first. Nothing else here waits on it.*
2. **Does the pilot do pumping, repairs, installation and estimates?** This sets the build order after SW-2. Stand-in: build everything in the plan's order. *Recommendation: keep the order and only reorder SW-5 to SW-7 if the pilot lacks a category.*
3. **The provider's redacted plan, contract and estimate documents** (G-COVERAGE, G-LEGAL). Stand-in: fictional Basic, Gold and Platinum in the demo. *Recommendation: ask for them with the existing sample pack.*
4. **Deposit policy and estimate expiry default.** Stand-in: no deposit and 30-day expiry by default, configurable per estimate. *Recommendation: accept these defaults.*
5. **Whether the pilot uses QuickBooks and automated sales tax.** Stand-in: tax mode off, with today's conflict. *Recommendation: have Codex run G-QBO-TAX in the sandbox regardless.*
6. **Approval to start workers** in the waves of §10. *Recommendation: start Wave 1 with Worker A only, which is the step in §14.*

---

## 14. First implementation step

When Justin authorizes it, start **Worker A on SW-1 (work foundation)** from the then-current `main`. The first commit is migration `0048` (or the next free number), creating:

- the `work_types`, `work_orders`, `work_order_events`, `work_order_notes` and `work_order_lines` tables;
- the `jobs.type` widening, `work_order_id` and `retest_of_inspection_id`;
- `issues.work_order_id` and `service_requests.work_order_id`.

That commit also adds the matching `schema.ts` types, the truncate-list entries and a test that a work job never opens a filing. Routes, office UI and demo story follow in the same PR. Nothing else in this plan should start before SW-1 merges, except SW-4 (QuickBooks tax) and SW-11 (export framework), which touch separate packages.
