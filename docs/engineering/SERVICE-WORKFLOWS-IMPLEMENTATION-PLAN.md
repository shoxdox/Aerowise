# Service workflows: implementation plan

**Current status: SW-1–SW-12 engineering is built, reviewed and validated with recorded exceptions, and deployed to staging at a444be2/migration0060.** This document retains the implementation design and acceptance criteria. Use [the current handoff](../DEMO-PILOT-BRIEF.md) and [RUNBOOK](RUNBOOK.md) for verified releases, final validation and remaining gates. Staging evidence does not establish physical-phone behavior, real-provider integration or authority acceptance. Justin authorized the planning on October 7, 2026 and wants these capabilities built. On October 7, 2026 (22:42Z) Justin gave a standing authorization to build all of SW-1 to SW-12 in the dependency order below: each wave starts when its prerequisites are reviewed and merged, without asking him again. Costs, purchases, accounts, DNS, pricing changes, production changes and real outreach, filings, charges or provider calls still each need his separate approval. **Revised** after Codex's review of `54e2672` (see [§15](#15-review-response-codex-on-54e2672)).

- **Baseline:** `09068280c2fcc036706734807167ff32524f7f8f` (`0906828`, "docs: record merged staging fixes and live prospect walkthrough"), fetched from `origin/main` at 2026-10-07 21:30Z. That commit includes the staging fixes #93–#96 and `5e491a0` (newer technician edits survive an in-flight sync). Migrations run through `0047_demo_request_delivery.sql`. No open PRs existed at that time.
- **Map dependency:** #97 merged as `220b4e7` and later SW-10 added mixed-work participation. The original draft/head described in the design sections was the October 7 planning snapshot. Current map deployment and limits are recorded in ROADMAP/RUNBOOK; the interfaces are summarized in [§6](#6-shared-street-map-and-schedule).
- **Sources:** current `main` code and docs ([README](../../README.md), [handoff](../DEMO-PILOT-BRIEF.md), [delivery record](ROADMAP.md), [decisions](../DECISIONS.md), [pilot worksheet](../PILOT-CALL-SHEET.md), [agent guidance](../../CODEX.md)). It also uses the sanitized Fieldbase findings in Justin's request and the public pages cited in [§0.2](#02-outside-evidence-and-how-much-it-proves). No private Fieldbase data, credentials, customer files or proprietary assets were used. None may be used during implementation.

Contents: [0 Ground rules](#0-ground-rules-that-apply-to-every-pr) · [1 Work orders](#1-general-work-orders) · [2 Pumping and disposal](#2-pumping-and-disposal-records) · [3 Estimates](#3-estimates-and-quotes) · [4 Plans and agreements](#4-plan-specific-agreements-coverage-and-service-cycles) · [5 Conventional and installation](#5-conventional-systems-and-installation-work) · [6 Map](#6-shared-street-map-and-schedule) · [7 Filing interoperability](#7-filing-interoperability) · [8 Cross-cutting](#8-cross-cutting-design) · [9 PR sequence](#9-pr-sequence) · [10 Workers](#10-implementation-workers-and-file-ownership) · [11 Risks](#11-risk-and-effort) · [12 Browser acceptance](#12-browser-acceptance-matrix) · [13 Gates and needs from Justin](#13-validation-gates-and-needs-from-justin) · [14 First step](#14-first-implementation-step) · [15 Review response](#15-review-response-codex-on-54e2672)

---

## 0. Ground rules that apply to every PR

These restate standing rules from the handoff, the decisions log and Justin's request. Any implementation PR that breaks one is wrong, even if it passes its tests.

1. **Work and compliance stay separate.** A pumping, repair, installation or other work order **never changes an aerobic inspection obligation**. It never opens a filing, never produces an authority report, never counts as an aerobic contract visit and never moves an aerobic due date. Only `aerobic_inspection` obligations completed through an inspection job do those things, exactly as today (`apps/api/src/routes/inspections.ts` `completeJob`). The one deliberate exception is the opposite direction: a work job may complete a **non-aerobic** cycle obligation, such as a pumping visit owed under a pumping plan (§4.4). The database enforces which job kinds can reference which obligation kinds (§4.4), and tests cover both directions.
2. **Aerobic behavior is preserved.** Obligations, retests (Hays 10.V.4), due dates, the more-visits warning, the report release rules, MP signing (`reports:sign` plus the person's own active license), sent and confirmed kept apart, and the Montgomery/Hays handling are unchanged. In particular, Montgomery food sites never default to monthly without a recorded contract, permit or confirmation, and the Hays end-of-window rule stays a labeled interpretation. Each PR runs the existing aerobic API and browser tests unchanged.
3. **Demo isolation is server-side and fails closed.** New tables carry `organization_id` with composite tenant foreign keys, so `removeCompanies` in `packages/db/src/reseed.ts` finds them automatically. New files are stored under the organization's key prefix, so `deleteOrganization` removes them. Any new outside service gets a stand-in and a gate in `packages/tasks/src/providers.ts` and `demo-gate.ts`. Demo contacts stay fictional (database triggers from migration 0040). Demo PDFs and CSVs are watermarked or carry the leading notice column.
4. **Public rules, implemented behavior and authority acceptance are three different things.** Real authorities stay drafts. Nothing here says a format is accepted unless dated evidence from that authority says so. There is never a blanket "call every authority": each external question becomes a named gate tied to the pilot ([§13](#13-validation-gates-and-needs-from-justin)).
5. **One accounting stack.** Estimates, deposits and work invoices reuse `invoices`/`invoice_lines`, `invoiceTotals`, `issueDraft`, `openCheckout`, Stripe Connect, refunds and the one-way QuickBooks sync. There is no second ledger, no separate payment path and no change to Aerowise subscription pricing.
6. **Offline exactly once, and no lost field work.** Any record a phone creates is keyed by a client-generated id with a unique `(organization_id, offline_client_id)` constraint and retried whole, following the existing inspection sync pattern and the `5e491a0` revision/acknowledge rule. A business conflict, such as a job reassigned or cancelled while the phone was offline, never discards the technician's record. It goes to a reviewable conflict queue instead (§8.5).
9. **Expand, read, then write.** Every schema-changing release follows three steps: (1) an additive schema plus a release whose code can *read* the new shapes safely; (2) writers behind a feature flag that is off by default; (3) the flag is turned on. Rollback is promised only down to each release's declared **rollback floor** (§9.1), never to an arbitrary earlier SHA.
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
- **`work_attachments`**: photos and files for work.
  - Columns: `offline_client_id` (unique per organization), `photo_key`, `storage_key`, `content_type`, `byte_size`, `sha256`, `captured_at`, `lat`, `lng`, `uploaded_by`.
  - **Exactly one owner:** nullable `work_record_id`, `disposal_load_group_id` (§2.2) and `work_sync_conflict_id` (§8.5). Each has a composite tenant foreign key `(organization_id, …)`, and a check `num_nonnulls(work_record_id, disposal_load_group_id, work_sync_conflict_id) = 1`.
  - The storage key is fixed by the owner at upload time: `${org}/work/records/<clientId>/…`, `${org}/work/loads/<groupId>/…` or `${org}/work/conflicts/<id>/…`. Keys never move. When ownership changes (a held draft becomes a conflict, or the office attaches a conflict to a job, §8.5), only the owner column changes, in one transaction. Everything stays under the organization prefix, so `deleteOrganization` and demo reset remove it.
  - The data export lists every attachment with its owner and path (`EXPORT_TABLES` plus the stored-documents list in `export-task.ts`).
  - This is a separate table: `attachments.inspection_id` stays `NOT NULL`, and inspection code is untouched.

Changes to existing tables, all additive and nullable:

- `jobs`:
  - Widen the `type` check to `('inspection', 'work')`.
  - Add `work_order_id` (composite foreign key) and `retest_of_inspection_id` (composite foreign key, which fixes the lost retest link).
  - Add a check: `type='inspection'` requires `work_order_id is null`; `type='work'` requires `work_order_id is not null`.
  - **Kind guards without a NULL bypass.** PostgreSQL accepts NULL in a `CHECK`, and a composite foreign key with any NULL column is not checked under the default `MATCH SIMPLE` ([PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)). So no guard relies on a nullable discriminator:
    - `jobs` gains `obligation_service_type`, a composite foreign key `(organization_id, obligation_id, obligation_service_type)` to a new `unique (organization_id, id, service_type)` on `service_obligations`, and a pairing check `(obligation_id is null) = (obligation_service_type is null)`. With the pairing, the key is always fully non-null whenever an obligation is referenced, so it is always checked.
    - **Old writers:** a binary from before SW-1 inserts jobs with `obligation_id` but no discriminator. A `BEFORE INSERT OR UPDATE OF obligation_id` trigger (`jobs_derive_obligation_kind`) derives `obligation_service_type` from the referenced obligation in the same organization, overwriting any value supplied, so a stale or forged discriminator cannot survive. An unknown obligation still fails the foreign key.
    - **Allowed kinds** (§4.4 explains why work jobs never reference obligations):
      - `type = 'work'` requires `obligation_id is null`.
      - `type = 'inspection'` requires `obligation_id is null or obligation_service_type = 'aerobic_inspection'`. Because of the pairing check, that NULL can only mean "no obligation".
    - `jobs` also gains `unique (organization_id, id, type)`.
  - `inspections` gains `job_type text not null default 'inspection' check (job_type = 'inspection')`, with a composite foreign key `(organization_id, job_id, job_type)` to that new unique key. Adding the column with a default fills every existing row. An old writer that omits it gets the default, and an explicit NULL fails `NOT NULL`. An inspection can therefore never point at a work job, and filings hang off inspections, so a work job cannot reach `openFiling` even through a bug in application code.
  - **Direct SQL tests** run in the migration test suite, so they fail regardless of application code:
    - an explicit NULL and an explicit wrong discriminator on a job with an aerobic obligation (derived to aerobic, then a work job is refused);
    - a work job with any `obligation_id`;
    - an inspection with NULL `job_type`, and one pointing at a work job;
    - an old-writer insert of a job without the discriminator (derived correctly).
  - **Several visits per work order are supported deliberately.** An installation over two days, or a repair needing a return visit for a part, is one work order with several jobs. `jobs.visit_number` is unique per work order. At most **one open** job per work order exists at a time, through a new unique partial index on `work_order_id where status in ('scheduled','in_progress')`. That index is separate from, and does not change, the existing aerobic `jobs_one_live_per_obligation` index, whose `where status <> 'cancelled'` also counts completed jobs. Earlier completed visits stay. Each job has its own `work_record`, with `job_id` unique. A record marked `final_visit = true` completes the work order. Otherwise, completing a visit returns the work order to `open` with "Another visit needed" and the reason.
  - **Known limitation:** one technician per job, as today. A two-person crew is recorded by naming the second person in the record (`crew_note`). Multiple assignees per job is an unresolved design choice (§15).
  - Backfill: existing rows get `type='inspection'`. The migration sets `obligation_service_type` from the obligation (always `aerobic_inspection` today) wherever `obligation_id` is set, before adding the pairing check. Old retest jobs keep `retest_of_inspection_id = null`, because the link was never stored. The UI keeps showing them as "extra visit".
- `issues`: add `work_order_id`, set when converted.
- `service_requests`: add `work_order_id`. Fix the response join to `left join service_obligations`, so a response can cite a work job or a retest job. Classification and authority reporting of complaints are unchanged: a request turned into a work order still needs its reportable classification and response recorded exactly as today.

### 1.3 Work order state machine (versioned, like `JOB_STATE_MACHINE`)

`draft → open → scheduled → in_progress → (open again for another visit) → completed`, with `cancelled` reachable from any state except `completed`. Rules:

- `open` means ready to schedule.
- `scheduled` follows its live job. Cancelling the live job returns the work order to `open`.
- `completed` comes only from a completed `work_record` with `final_visit = true`, or from an office "complete without a field record" (reason required, audited).
- Cancelling a work order that has completed visits keeps those visit records and their attachments. They are never deleted.
- Invoicing is tracked separately (`billing_status`: `unbilled | invoiced | no_charge`). It is not a lifecycle state, so voiding an invoice never reopens field work.
- Job status and work order status move in the same transaction, under a `FOR UPDATE` lock on the work order row.

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
| `PUT /work/sync`, `PUT /work/:clientId/photos/:photoClientId`, `PUT /work/:clientId/signatures/:signatureClientId` (phone, see §8.1) | `work:complete` |
| `GET /work/conflicts`, `POST /work/conflicts/:id/resolve` (§8.5) | `work:write` |
| `POST /work-orders/:id/invoice` (draft invoice from lines; one **non-void** invoice per work order, so a void allows a replacement, §3.6) | `invoices:write` |

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
- **Demo story:** add one completed pumping work order with its pump-out, a disposal load and an invoice, one scheduled repair converted from an inspection issue, and one portal request converted to a work order. Add them in `playDemoStory` (`apps/api/src/demo-story.ts`) through the API, so the conversions are exercised. The public demo, personalized prospect demos and visitor demos all get them, because they share `seedDemoCompany` and `playDemoStory`. A new trial company gets the default work types and no work orders.

### 1.6 Acceptance

- A work order goes from draft through completion and invoice for each category, on office and phone, without creating any filing, report, compliance event or aerobic obligation change (pumping cycles in SW-9 deliberately complete their own non-aerobic obligations). Assert counts before and after.
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

Pumping at a site and disposing of the load are separate events. One truck load may combine several sites' pump-outs, and disposal may happen later the same day or another day. The model therefore keeps them apart on purpose:

- **`vehicles`**: `name`, `plate`, `capacity_gallons`, `registration_reference` (free text; Aerowise does not verify it), `active`.
- **`disposal_facilities`**: organization-scoped.
  - Identity: `name`, `kind` (`wastewater_treatment_plant | land_application_site | transfer_station | other`), address, lat/lng, `permit_or_registration_number`.
  - Origin: `source` (`entered_by_provider | public_source`), `source_url`, `source_retrieved_on`, `notes`, `active`.
  - No shared dataset is shipped and nothing is copied from a competitor. An office can add facilities by hand. Later, if a pilot needs it, an admin import from a *named public source* can store `source_url` and the retrieval date per row, subject to that source's terms and gate **G-FAC**.
- **Revision identity.** Pump-outs and loads are immutable rows grouped by a stable identity:
  - `group_id` is the id of the first revision, and `revision` counts from 1.
  - `is_current` is a boolean with a unique partial index `(group_id) where is_current`.
  - A correction runs in one transaction: lock the group's current row (`FOR UPDATE`), set its `is_current = false`, then insert revision n+1 as current with `correction_reason`.
  - Everything that counts or links uses the **group**, read through the current revision (views `current_pumping_records` and `current_disposal_loads`). Old and corrected volumes are therefore never both counted, and never both eligible for a load.
- **`pumping_records`**: one group per pump-out at a site, recorded on the job.
  - Links: `work_order_id`, `job_id`, `work_record_id`, `site_id`, `technician_user_id`, `vehicle_id`.
  - What and when: `service_date`, `waste_type` (`septage | grease_trap | holding_tank | portable_toilet | other`, plus `waste_type_note`), `tanks` (jsonb list: compartment or tank label, volume).
  - Volume: as entered, `entered_volume` (numeric(10,1)) and `entered_unit` (`gallons | liters`), shown to people as recorded. Canonical **`volume_milligallons`** (integer thousandths of a US gallon) is computed at write time. Liters convert with the exact definition 1 US gallon = 3.785411784 L, so `round(liters × 1000 / 3.785411784)`. All totals, comparisons and load sums use the canonical value. Mixed units in one load are therefore exact up to that single rounding, and the display shows both.
  - Identity and history: `offline_client_id` (unique per organization), `group_id`, `revision`, `is_current`, `correction_reason`.
- **`disposal_loads`**: one group per delivery to a facility.
  - What: `vehicle_id`, `disposal_facility_id`, `delivered_on`, `manifest_reference`, the entered total plus its unit, canonical `total_milligallons`, and `notes`.
  - Who: `recorded_by` (technician or office).
  - Identity and history: `offline_client_id`, `group_id`, `revision`, `is_current`, `correction_reason`, as above.
- **`disposal_load_items`**: holds `(organization_id, load_group_id, pumping_group_id)` with tenant foreign keys to both groups.
  - **`unique (pumping_group_id)`** means a pump-out is in at most one load, whatever its revisions.
  - A load correction creates a new load revision. Its items stay attached to the group, and changing membership is an explicit add or remove, audited.
  - A pump-out correction after its load was recorded keeps its membership, because the item points at the group. The load's "volumes differ" note is recomputed from the current revisions. Differences are shown, not refused, because measurement methods differ.
- **Files:** a manifest photo or the facility's receipt goes in `work_attachments`, owned by the load group (`disposal_load_group_id`, `photo_key = manifest`), so it survives load corrections. It is stored under `${org}/work/loads/<groupId>/`, listed in the data export, and removed with the organization on demo reset or expiry.

### 2.3 Flow

- **Dispatch:** a pumping work order is scheduled like any work.
- **At the site:** the phone form for a work type with `requires_disposal_record` records the pump-out: volume, unit, waste type, tanks and vehicle. Completing the job needs only the pump-out.
- **Disposal:** a separate "Record disposal" action on `/tech` and in the office creates a load. Its candidate items are the technician's pump-outs not yet in any load, for the same vehicle. It records the facility, manifest reference, delivery date and photo.
  - Pump-outs older than the organization's `disposal_overdue_days` setting (default 2, configurable) and not in a load raise an inbox item "Disposal not recorded".
  - The load can be recorded offline, and syncs with its own client id.
- **Billing:** work order lines can price by gallon (`quantity_milli`). The invoice line cites the pump-out volume.
- **History:** the site page gets a "Pumping history" panel listing pump-outs and their load.
- **Export:** `pumping_records.csv`, `disposal_loads.csv` and `disposal_load_items.csv` join the data export (`packages/tasks/src/export-task.ts` `EXPORT_TABLES`), with the demo notice column. A date-range "Disposal log" CSV and PDF is available from the office for the provider's own records.

### 2.4 What the UI says and does not say

The labels are "Disposal record" and "Manifest/reference number". Aerowise does **not** say a load is legally compliant, that a manifest satisfies a regulator, or that a facility accepted it. Requirements specific to a regulator are not invented. If the pilot's evidence shows a required manifest field, it is added as a configurable required field after gate **G-HAUL**, with its citation recorded in DECISIONS.

### 2.5 Acceptance

- Offline pumping completion with a manifest photo reaches the office exactly once.
- A pump-out correction after its load was recorded: the load counts only the new volume, and the item still points at the same group.
- A load correction keeps its items and its manifest file.
- Mixed units: a liters pump-out and a gallons pump-out in one load. The canonical total is exact and both entered values are displayed.
- Adding a pump-out group to a second load is refused by the unique index, including after the pump-out is corrected.
- A pumping job never touches aerobic obligations or filings.
- The CSV export of a demo organization carries the notice column and lists load attachments.
- After a public demo reset or demo expiry, the load rows, attachment rows and stored manifest objects are all gone, and a stored download link returns 404. A prospect demo's manifest is still retrievable after the nightly reseed.

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

`draft → sent → (viewed) → accepted | declined | expired`. `void` is reachable from `draft` or `sent`. **`accepted → cancelled`** is the office's cancellation after acceptance; the homeowner asks the office, and there is no public route. Expiry runs as a queued task on `expires_on`, using the organization's local day as renewals do.

Cancelling after acceptance is allowed only while the estimate's work order has **no completed visit** and **no issued final invoice**. In one transaction it does the following:

1. The work order and its live job are cancelled, and coverage reservations are released (§4.3).
2. A draft final invoice is discarded. An issued final invoice blocks the cancellation: the office voids it first, using the existing void rules, which refuse an invoice with payments.
3. The deposit is handled by its state:
   - An unpaid deposit invoice is voided.
   - A paid deposit becomes **"deposit disposition needed"**, an inbox item. The office then either refunds it through the existing refund route (credit or reverse intent) or records it as retained under the estimate's terms with a reason. Both are written to the deposit ledger (§3.6). Nothing is refunded or retained automatically.

If work has already been done, the estimate cannot be cancelled. The office invoices the completed visits from the actual lines, which applies the deposit, and cancels the rest of the work order.

### 3.5 Acceptance and evidence

`POST /estimates/:token/accept` takes `{ version, selectedOptionalLineIds, signerName, signatureKind, signatureImage? }`.

- A stale version gets 409 `estimate_revised`.
- It inserts a `signed_documents` row with `kind = 'estimate_acceptance'` (the kind check is widened) containing the exact version snapshot, the selected options, totals, terms and consent text. It stores the sha256, IP address and user agent as renewals do.
- **Accepting twice is a no-op** that returns the existing acceptance. This is enforced by a unique index on `estimates.accepted_document_id` and a row lock.
- A decline records the reason.
- The office can mark an estimate accepted from a paper or phone approval, but must attach evidence (an uploaded file or a typed note). That acceptance is labeled "Recorded by office" and is never shown as a homeowner e-signature.

### 3.6 Conversion, deposits and invoices (exactly once)

1. **On acceptance:** in the same transaction, create the work order (`source_kind='estimate'`, protected by the unique index) with lines copied from the accepted version and the chosen options.
2. **Deposit:** if one is required, create and issue **one** deposit invoice D. The deposit invoice has one line, "Deposit for EST-1001", on the deposit service item. It is paid through the existing `openCheckout`, which already charges the full amount due of *that* invoice, so no partial-checkout change is needed.
3. **Final invoice:** after completion, `POST /work-orders/:id/invoice` makes the final invoice F from the actual work order lines and applies available deposit money (below). The total check becomes `total = subtotal − discount + tax − deposit_applied`.
4. **No double charge:** the checkout idempotency key already includes the invoice id and the amount due, and webhooks are already idempotent through `stripe_events` and the unique `provider_refund_id`. New tests replay accept, checkout completion, the invoice route and refund webhooks concurrently.

**Invoice identity, with voids and replacements.** `estimate_invoices (estimate_id, invoice_id, role, replaces_invoice_id, voided_at)` links invoices to the estimate, with `role` either `deposit` or `final`. A unique partial index `(estimate_id, role) where voided_at is null` allows **at most one active** deposit invoice and one active final invoice, while keeping every voided one in history. Voiding an invoice sets `voided_at` on its link in the same transaction. A replacement final invoice F2 records `replaces_invoice_id = F`. A retried accept or invoice request returns the active row instead of creating another. Every work order follows the same rule: `invoices.work_order_id` with a unique partial index `(organization_id, work_order_id) where status <> 'void'`. So "one invoice per work order" never blocks re-invoicing after a void, and a concurrent pair of invoice requests still yields one.

**Deposit ledger.** For each deposit invoice D there is an append-only `deposit_ledger`. Rows are never updated or deleted, and corrections are new rows. Every entry carries `amount_cents > 0`, its kind, actor, reason, the related ids and a `cause_key` (unique per D) naming the event that produced it, so a replay of that event finds its rows and writes nothing:

| Kind | Meaning | Created by |
|---|---|---|
| `received` | Cleared payment on D | Payment success (webhook or manual) |
| `refunded` | Settled refund of D's money started in Aerowise | The refund's status becoming `succeeded` (below) |
| `refunded_external` | Settled refund of D's money that Aerowise did not start (for example the Stripe dashboard), keyed by `provider_refund_id`, unique | Webhook reporting `succeeded` |
| `applied` / `unapplied` | Money moved to final invoice F / moved back when F is voided | Final invoice / void |
| `retained` / `retain_reversed` | Kept under the estimate's terms / an explicit office reversal of that | Office, with reason |
| `shortfall` / `shortfall_released` | Increase / decrease of the **current** deficit (below) | Any operation, in its own transaction |
| `deposit_reversal` | Applied deposit money returned to the customer after F was issued, paired with a credit on F | Settlement of a "Refund the job" refund |

Refunds that are requested but not settled are **not** ledger entries. They are the existing `refunds` rows (`status` `pending | succeeded | failed`, `packages/payments`), which the ledger reads.

Per D, in cents, the balances are:

- `R` = received
- `X` = refunded + refunded_external + deposit_reversal
- `A` = applied − unapplied − deposit_reversal
- `T` = retained − retain_reversed
- `Q` = pending Aerowise-started refunds of D's free money (reserved, below)
- `S` = shortfall − shortfall_released, the **current** deficit

**The shortfall is the current deficit, never a running total.** Every operation on D, under the lock below, recomputes `need = max(0, X + Q + A + T − R)` after its own entries and writes the difference `need − S_before`: a `shortfall` entry if positive, a `shortfall_released` entry if negative, nothing if zero. So `S = need` after every commit, and

`U = R − X − Q − A − T + S = max(0, R − X − Q − A − T)`.

`U` is exactly the deposit money that is really free. A shortfall that has been booked can never look like available money: once the deficit disappears (for example F is voided), the shortfall is released in the same transaction, and `U` counts only real money.

Whether a shortfall has been **dealt with** is tracked separately, in `deposit_shortfall_resolutions` (amount, a linked supplemental invoice or an office write-off with a reason). That table never changes `S` or `U`. The outstanding amount shown in the inbox is `max(0, S − resolved)`. If resolutions ever exceed the current `S` (the deficit went away after a supplemental invoice was paid), the inbox shows "Shortfall resolved more than is now owed" so the office can credit the customer.

**Rules.** Each rule is enforced in one transaction that first locks D's invoice row with `SELECT … FOR UPDATE`, which the webhook path takes too:

- **I1 (reconciled):** `U ≥ 0` and `S = max(0, X + Q + A + T − R)` at commit. A deferred constraint trigger checks both, so it never sees a half-written transaction.
- **I2 (Aerowise-initiated movements):** `applied`, `retained` and a new refund request may each take at most `U`. Only real, free money can be applied, kept or returned. A request for more gets 409 `deposit_not_available`. Retained money is outside `U`, so it cannot later be refunded or applied unless an explicit `retain_reversed` entry puts it back first.
- **I3 (external refunds are never refused):** when the webhook reports an external refund as `succeeded`, it records `refunded_external` and then the shortfall difference above, in the same transaction. A replayed webhook finds the existing `provider_refund_id` and its `cause_key` and adds nothing. A pending external refund is shown in the inbox ("Refund pending at Stripe") and booked only when it succeeds. A failed one is never booked.
- **I4 (F never negative):** for each active F, `deposit_applied ≤ subtotal − discount + tax`. A deposit larger than the final amount is applied only up to F's total. The remainder stays free, and "Unapplied deposit" stays in the inbox until it is refunded or retained.
- **I5 (voiding F):** the existing rules allow voiding only with no direct payment on F. Voiding writes `unapplied` for everything applied to F (and so releases any shortfall it no longer needs), and a replacement F2 can then apply again.

**Refunds Aerowise starts can be pending or fail.** A SQL transaction cannot undo a Stripe refund that has already been issued, so no balance moves until the provider says the money moved:

1. **Reserve.** Under D's lock, check I2 and insert the `refunds` row with `status = 'pending'`, no provider id yet, and its idempotency key (the existing scheme in `apps/api/src/routes/invoices.ts`: one key per refund request). Commit. The pending row is `Q`, so it is unavailable to any other apply, retain or refund.
2. **Call the provider after the commit** with that key (`PaymentProvider.createRefund` in `packages/payments/src/provider.ts`), passing the refund row id as metadata. A retried request reuses the key, so Stripe returns the same refund. Store the provider refund id and status.
3. **Settle by provider status**, through the existing path that already moves a refund from `pending` to a final status (`refundEvent` in `packages/payments/src/webhooks.ts`, which also matches a refund by its stored id). In the same transaction as that change:
   - `succeeded`: write `refunded` (or, for the deposit part of "Refund the job", `deposit_reversal` plus its credit on F), which removes it from `Q`. Then recompute the shortfall.
   - `failed`: write nothing to the ledger. The reservation is released because the row has left `pending`, `U` returns, and the inbox shows "Refund failed" with the provider's reason.
   - `pending`: nothing changes.
   - As today, a final status never changes again, so a replayed or late webhook is a no-op.
4. **Lost response.** If the process stops between step 1 and step 2, or the provider's answer is lost, a new `payments.reconcile_refunds` task finds pending refund rows with no provider id after a few minutes and repeats step 2 with the same key. A webhook for a refund that carries the row id in its metadata settles that reservation, and is never booked as `refunded_external`.
5. **Manual refunds** (check or cash, recorded by the office) have no provider and settle immediately, as today.

**"Refund the job" after F was issued and paid**, partly or entirely by the deposit. One audited office action takes the amount to return and splits it:

1. F's own direct payments, through the existing refund route (credit intent).
2. Then the deposit-funded part, as a refund of D's payment that reserves against F's applied amount (at most `applied_F` minus pending reversals on F, 409 otherwise) rather than against `U`. Only when that refund **succeeds** does settlement write the `deposit_reversal` entry and an equal **`deposit_reversal` credit on F**. That is a new credit kind, counted in F's `credited_cents` by `recalcInvoice` (which already counts only succeeded refunds), so F never becomes owed again. While it is pending, F shows "Refund pending" and nothing is booked. If it fails, F is unchanged.

This also covers a fully deposit-funded F with $0 due and no direct payments: everything goes through step 2.

**Ledger equality** (tested for every estimate after every operation). The terms, in cents:

- `P` = cleared payments on D and on every final invoice for the estimate, minus all **succeeded** refunds of those payments.
- For each active F: `G_F = subtotal − discount + tax`, `C_F` = all credits on F (including deposit reversals), and `due_F = G_F − deposit_applied_F − C_F − paid_F`.

The equality:

`P + Σ due_F = Σ (G_F − C_F) + T + U + Q − S`

So the money held, plus what is still owed, equals the value of the work after credits, plus retained deposit, plus free deposit, plus deposit money reserved for pending refunds, less the current deficit. With no final invoice the F terms are zero. A pending reversal on F changes no term until it settles. When it settles, `P` and `G_F − C_F` fall by the same amount.

**Worked example** (Codex's case). D received `R = 10000`, all applied to F (`A = 10000`), `T = 0`:

| Step | X | A | S | U | Entries written |
|---|---|---|---|---|---|
| External refund 2000 succeeds | 2000 | 10000 | 2000 | 0 | `refunded_external` 2000, `shortfall` 2000 |
| A second, distinct external refund 3000 succeeds | 5000 | 10000 | 5000 | 0 | `refunded_external` 3000, `shortfall` 3000 (not 5000) |
| Replay of either webhook | unchanged | | | | none |
| Apply 1 more cent from D | unchanged | | | | refused, 409 `deposit_not_available` |
| Void F | 5000 | 0 | 0 | 5000 | `unapplied` 10000, `shortfall_released` 5000 |
| Apply 6000 to F2 / apply 5000 to F2 | 5000 | 5000 | 0 | 0 | refused / `applied` 5000 |

**Tests** (built-in test payment provider only; no real provider calls or accounts):

- a partly paid F with an applied D;
- a fully deposit-funded F with $0 due;
- a full refund of everything the customer paid;
- the worked example above, step by step: two distinct external refunds with each webhook replayed (`S = 5000`, not 7000), an apply refused while `S > 0`, then void, release, and apply up to `U` only;
- an external refund while a final invoice is only partly applied (shortfall only for the real deficit);
- a retained remainder followed by attempts to refund or apply it (refused) and a retain reversal (then allowed);
- void and replacement F, applying again: F2 is created with `replaces_invoice_id = F` despite the per-work-order index, and a replayed request returns F2;
- a deposit larger than the final amount;
- concurrent apply and webhook refund (serialized by the lock);
- **pending → succeeded:** a refund of free deposit money is reserved (`Q`), a second request for the same money gets 409, then the success webhook is delivered twice. One `refunded` entry, `Q` back to 0, equality holds at every step;
- **pending → failed:** the reservation is held, then the failure webhook is delivered twice. No ledger entry, `U` restored once, one "Refund failed" inbox item;
- **"Refund the job" deposit part, pending → succeeded and pending → failed**, each with replay: the credit on F appears only on success and only once; on failure F and its amount due are unchanged;
- **lost provider response:** the test provider records the call but the response is dropped. Reconciliation repeats it with the same key and gets the same refund id; one refund, one settlement;
- a webhook for an Aerowise-started refund that arrives before the route stored the provider id settles the reservation and is not booked as external.

**Accounting hypotheses, not facts.** The software can implement either treatment behind a flag (`deposit_mode`), but neither is asserted as correct accounting:

- **H-DEP-1:** a deposit is an untaxed prepayment, and tax belongs on F's work lines. Whether that is right for the pilot's services and Texas sales tax depends on the provider's own tax treatment (gate **G-TAX-TREATMENT**). The alternative, taxing the deposit when it is collected, is selectable.
- **H-DEP-2:** in QuickBooks, the deposit invoice line goes to a "Customer deposits" item tied to a liability account, and F carries a non-taxable negative line on that same item for the applied amount. Then F's QuickBooks total matches Aerowise's, and the liability nets to the unapplied amount. The alternative is applying D's payment across invoices with QuickBooks' own linked transactions. Gate **G-QBO-DEPOSIT** decides between them.
- **Tests use the built-in test QuickBooks provider.** They check matching `TotalAmt`, and also that revenue sits on the work items, tax only once, and that the deposit item's balance equals the unapplied amount.
- **Real companies:** until the gates pass, an invoice involving a deposit stays out of QuickBooks with a `deposit_mapping_missing` conflict, the same way `tax_mapping_missing` works today.

**Rejected alternative:** a negative "deposit" line on F inside Aerowise. It breaks the proportional discount math in `invoiceTotals` and the `min(0)` line validation.

### 3.7 Tax: mixed taxable lines in QuickBooks

Aerowise math already supports taxable and untaxed lines at one rate per invoice. The only blocker is the sync.

The plan:

- Add tax mapping to `quickbooks_connections`: `tax_mode` (`off | taxcode`), `taxable_code_ref`, `nontaxable_code_ref` and `tax_rate_ref`. With the mode off, today's `tax_mapping_missing` conflict and its "enter it yourself" message stay as they are.
- When the mode is on, send `TaxCodeRef` per line and `TxnTaxDetail` with the rate and total. Creates already pass a deterministic `requestid` (`packages/quickbooks/src/intuit.ts` `createInvoice`), so a retry after a lost response does not create a second remote invoice. The plan keeps and tests that behavior.
- **A mismatch is found only after QuickBooks has created the invoice.** After the create, Aerowise compares QuickBooks' `TotalAmt` and `TotalTax` with its own. On a difference:
  - The link becomes **`quarantined`** with a `tax_total_mismatch` conflict. The remote id is stored, so nothing is ever created again for it.
  - No further updates are pushed, and payments and refunds for that invoice are held, so nothing compounds the error.
  - The review screen shows both totals and offers two choices. "I corrected it in QuickBooks, check again" re-reads the invoice and releases the hold when the totals match. "Keep it as is and stop syncing this invoice" requires a reason. Aerowise never edits or deletes the remote invoice by itself, following the existing one-way rule.
- Companies using QuickBooks Online automated sales tax may have tax recomputed by QuickBooks. How often that differs is unknown until gate **G-QBO-TAX**. Until then, tax mode stays off for real companies. Quarantine limits the damage of a mismatch; it does not prevent the first wrong remote invoice.

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
  - `options`: jsonb list of `{ optionKey, addonId | serviceItemId, priceCents, taxable, required, default }`.
  - `coverage`: jsonb list of coverage rules, `{ ruleKey, match: { category | serviceItemId }, effect: included | percent_off | excluded, percentOff?, limit?: { count, per: 'term' } }`.
  - `service_cycles`: jsonb list of `{ cycleKey, serviceType, workTypeKey?, schedule }` (§4.4).
  - `created_by`, `created_at`.

  `ruleKey`, `optionKey` and `cycleKey` are stable slugs, unique within a version. The builder carries a key forward to the next version unchanged unless the office says the meaning changed, in which case it gets a new key.

  `plans` gains `current_version_id`. Editing a plan in the office creates a new version. Contracts and renewals reference `plan_version_id` (new nullable columns on `contracts` and `renewals`).

- **Backfill:** one migration creates v1 for every existing plan. It uses `terms_text = null`, no intake, no options or coverage, and one cycle `{ cycleKey: 'aerobic', serviceType: 'aerobic_inspection', schedule: { kind: 'visits_per_term', visitsPerTerm } }`. It sets `contracts.plan_version_id` where `plan_id` matches. Contracts keep their copied columns (term, visits, price), which stay authoritative for existing obligations, so **nothing about an existing contract changes**.
- **Frozen per contract:** when a contract is created, its coverage rules and cycles are copied into `contract_coverage_rules` and `contract_service_cycles` (§4.3, §4.4). From then on, a contract is evaluated **only** against those rows, never against a newer plan version.
- **Agreement snapshot:** `AgreementContent` gains the plan version's resolved terms, the intake answers, the selected options with prices, the coverage summary and the cycles. It stays hashed and immutable in `signed_documents`, which `contracts.signed_document_id` already links. Office-created contracts without signing get a non-signed `agreement_snapshot` jsonb on the contract.
- **Basic, Gold and Platinum** are just plan names. Benefits come only from the frozen coverage rules. A Gold label with no coverage rules covers nothing, and the UI says "No coverage rules" rather than guessing.

### 4.3 Coverage in practice, and its concurrency rules

**Tables**

- **`contract_coverage_rules`**: holds `contract_id`, `rule_key`, `rule` (frozen jsonb), `plan_version_id`, `limit_count` (null means unlimited), `period_start` and `period_end` (the contract term). It has `unique (contract_id, rule_key)`, is written once at contract creation and is never updated.
- **`coverage_uses`**: holds `contract_coverage_rule_id`, `work_order_id`, `state` (`reserved | consumed | released`), `invoice_id`, the time of each state change and `reason`. It has `unique (contract_coverage_rule_id, work_order_id)`. One work order uses a rule at most once, whatever its lines. Per-quantity limits, such as "up to 2,000 gallons", are an unresolved choice (§15).

**Which contract applies:** the contract active at the site on the work order's `requested_on`. A work order requested within the term keeps its coverage even if the visit falls after the term ends. A renewal is a new contract with fresh rule rows and fresh limits.

**Reserve, consume, release**

- **Reserve:** when the office creates or converts a work order and accepts the suggested coverage, the transaction locks the rule row (`SELECT … FOR UPDATE` on `contract_coverage_rules`), counts uses that are `reserved` or `consumed`, and inserts `reserved` only if the count is below the limit. Two concurrent covered work orders on the last allowed use therefore serialize: exactly one gets it, and the other's snapshot says "limit reached, not covered".
- **Consume:** when the work order's final invoice is issued, or when the work order is completed with `billing_status = no_charge`.
- **Release:**
  - Cancelling the work order releases its use.
  - The office choosing "don't apply coverage" before invoicing releases it, with a reason.
  - Voiding the invoice returns a consumed use to `reserved` while the work order is live, and releases it if the work order is cancelled.
- **Unchanged by:**
  - Refunds: the service was performed. "Restore benefit" is a separate, explicit office action with a reason, which releases the use.
  - Rescheduling: no change.

**Line changes, overrides and visibility**

- **Line changes:** at invoicing, the covered amount is computed from the frozen rule against the *actual* lines. Adding a part in the field gets the same rule. The work order still uses one count per rule.
- **Office override:** per line, with a reason, audited. An override that removes coverage from every line releases the use.
- **Visibility:**
  - `work_orders.coverage_snapshot` is refreshed from the frozen rules whenever the reservation changes.
  - The **office** sees "Covered by Gold (contract #…): pump replacement parts 100%, labor 20% off, 1 of 2 service calls used".
  - The **technician** sees "Covered" or "Not covered, quote needed" and no prices, unless the organization turns prices on.
  - A covered line at zero is still printed with its note.
  - Nothing changes the plan's own installment billing.
- **Tests:**
  - 10 concurrent reservations against a limit of 1 succeed exactly once.
  - The cancel, void and override paths restore counts.
  - Changing the plan after the contract was created does not change any of the contract's evaluations.

### 4.4 Recurring cycles that are not aerobic inspections

- **Service types:** `SERVICE_TYPES` grows to `['aerobic_inspection', 'pumping', 'maintenance']`.
- **Cycle identity:** a new table, **`contract_service_cycles`**:
  - Columns: `contract_id`, `cycle_key`, `service_type`, `work_type_id` (null for aerobic; required otherwise), `schedule` and `snapshot` (frozen jsonb from the plan version), `plan_version_id`.
  - Constraints: `unique (contract_id, cycle_key)` and `unique (organization_id, id, service_type)`.
  - Written once at contract creation. Backfill creates one `aerobic` cycle for every existing contract.
- **Obligations:**
  - `service_obligations` gains `cycle_id`, **`NOT NULL`**.
    - The fill happens in a `BEFORE INSERT` trigger (`obligations_assign_cycle`), and PostgreSQL runs it before the `NOT NULL` check. For an aerobic obligation inserted without `cycle_id`, the trigger finds the contract's `aerobic` cycle, or **creates it** from the contract's own term, visits and service type (`insert … on conflict (contract_id, cycle_key) do nothing`, then select). An old binary creating a **new** contract (`insertContract`, then its obligations) therefore gets a valid cycle, not just existing contracts through the backfill.
    - For a non-aerobic obligation without `cycle_id`, the trigger raises an error, so non-aerobic obligations always name their cycle.
    - A pumping-only contract never gets an aerobic cycle, because the trigger acts only when an aerobic obligation is inserted.
  - **Consistency:** a composite foreign key `(organization_id, contract_id, cycle_id, service_type)` references `contract_service_cycles (organization_id, contract_id, id, service_type)`, with a matching unique key. An obligation's cycle must belong to the same contract and have the same kind. All of these columns are `NOT NULL`, so `MATCH SIMPLE` cannot skip the check.
  - **Numbering:** the existing `unique (contract_id, sequence)` from migration 0002 is replaced by `unique (cycle_id, sequence)`, plus a partial `unique (contract_id, sequence) where service_type = 'aerobic_inspection'`. Each cycle numbers its visits from 1, and aerobic numbering keeps exactly today's meaning.
  - **Backfill order:** create the cycles, set `cycle_id` on every row, add `NOT NULL` and the keys, then swap the unique constraint, all in one migration transaction.
  - **Direct SQL tests:**
    - an old-writer insert of a new contract and its aerobic obligations creates one cycle, and a second obligation reuses it;
    - a non-aerobic obligation without a cycle is refused;
    - an obligation pointing at another contract's cycle, and one whose kind differs from its cycle's, are refused;
    - two cycles on one contract both number from 1.
- **Schedules:**
  - Aerobic visits use today's `buildTermSchedule` and `buildAnchoredSchedule`, including the authority more-visits rules and `acceptVisits`, unchanged.
  - Non-aerobic cycles support `{ kind: 'every_months', everyMonths, windowDays = 30 }`, **anchored to the contract start**. Due dates are start + k × everyMonths that fall inside the term. The window is the due date ± `windowDays`, clipped to the term.
  - A cycle with no due date inside a term (for example, every 36 months on a 12-month plan) is refused by the builder unless the office accepts "no visit this term". Carrying the anchor across renewals ("36 months after the last pump-out") is an unresolved choice (§15).
  - These cycles never pass through authority rules.
- **Scheduling, idempotently, with several visits:** a non-aerobic obligation is linked to its **work order**, not to its jobs.
  - `work_orders` gains `obligation_id` and `obligation_service_type`. It gets the same NULL-proof scheme as jobs: a pairing check, a derivation trigger and a composite foreign key, plus a check `obligation_service_type <> 'aerobic_inspection'`.
  - A unique partial index `work_orders_one_per_obligation on (obligation_id) where status <> 'cancelled'` gives one work order per obligation. It includes completed ones, mirroring the aerobic rule.
  - Scheduling the obligation creates that work order (`source_kind='contract_cycle'`) of the cycle's work type. Visits are ordinary work jobs with `obligation_id` null, so visit 2 after a completed non-final visit 1 is allowed.
  - The work order's final visit completes the obligation in the same transaction.
  - Scheduling again after the final completion is refused twice over: the existing "This visit is completed" check, and the index above.
  - The aerobic `jobs_one_live_per_obligation` index is **not** widened or changed. Aerobic visits keep exactly one non-cancelled inspection job per obligation, as today.
  - **Tests:**
    - two visits (non-final, then final) on one pumping-cycle obligation;
    - scheduling the same obligation twice concurrently;
    - scheduling again after final completion;
    - aerobic schedule, cancel and reschedule tests unchanged.
- **Database enforcement:** work jobs cannot reference obligations at all (§1.2). Work orders can reference only non-aerobic obligations. Inspection jobs can reference only aerobic ones. `inspections.job_type` keeps work jobs away from filings.
- **Reporting and counts:** each of these filters by `service_type` or cycle:
  - the due list (aerobic is the default view, so today's office experience is unchanged; a service-type filter is added);
  - inbox overdue visits;
  - readiness;
  - `contractVisitDeadline` and `openFiling` (also blocked by the database);
  - the more-visits warning;
  - contract visit counts and renewal previews;
  - SMS "inspection due" wording (per service type);
  - `visits.csv` (adds `service_type` and `cycle_key`).

  Aerowise subscription billing counts contracts, not obligations, so it is unaffected. A test covers it anyway.
- **Tests:**
  - Aerobic schedules for the Hays, Montgomery and Williamson fixtures are byte-identical before and after.
  - A pumping obligation cannot reach `openFiling`.
  - A work job cannot complete an aerobic obligation, and the database rejects the attempt.
  - Two cycles on one contract both number from 1 without collision.
  - Scheduling the same cycle obligation twice yields one work order and one live job.
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
- **Forms (delivered by SW-F, the shared form foundation, §9):** `inspection_templates` gains `purpose` (`inspection | work | intake`, default `inspection`). Existing rows stay `inspection`. The template definition schema is reused unchanged, with one addition: a `signature` requirement block, `{ key, label, signer: customer | technician, required }`.
  - Work types point at a template key.
  - Templates stay immutable per version.
  - Built-in starter templates, each owned by exactly one PR:
    - **SW-F:** generic repair (problem, cause, parts used, photos before and after) and generic service call. These exercise the framework.
    - **SW-6:** pumping (tank count, sludge/scum observations, lid condition). The disposal part is structured records, not form values.
    - **SW-7:** conventional service (tank and baffle checks, distribution box, field observations) and installation (existing or new system, bedrooms, tank sizes, line lengths, install-location photos, as-built sketch photo, customer completion signature), plus the completion summary PDF.
  - **Configurable:** every form's fields, photos and signature requirements, per organization, versioned. **Specialized (code):** the disposal section (§2, structured records rather than form values) and the aerobic inspection with its authority requirements (unchanged).
- **Signatures on the phone (SW-F builds the pad and the `work_completion` document kind; SW-2 stores and syncs it offline):** a new drawn or typed signature pad in `/tech`. It is stored offline as a blob (§8.1) and uploaded to a `signed_documents` row with `kind = 'work_completion'`, holding a hashed snapshot of the work record summary the customer saw. Only a homeowner signature on a summary of the work done, not a regulatory signature. MP report signing is unchanged and remains office-side with license checks.
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

- There is one IndexedDB database per tenant and user, opened with a fixed `DB_VERSION = 1` (`db.ts`, `indexedDB.open(name, DB_VERSION)`). Its stores are `kv`, `inspections` (keyed by `jobId`), `photos` and `outbox`.
- Outbox ops are `sync` or `photo`, keyed by `inspectionClientId`.
- Retries are classified by `RetryLater`. Ops that fail permanently stay failed and visible.
- The revision/acknowledge rule from `5e491a0` preserves newer edits.
- Cache handling for ended demos (STG-03) is per tenant.
- The service worker never caches `/api/`.

**Why not a v2 bump of that database:** a binary that opens with a fixed version 1 fails with `VersionError` against a version-2 database before any of its own code runs ([W3C IndexedDB, "open a database connection", step 7](https://w3c.github.io/IndexedDB/#opening)). A guard shipped inside the new release cannot help an older binary. So the plan never raises that database's version, and ships a compatibility release first.

**SW-2a: phone compatibility release.** Client-only, no schema change. It is deployed to staging before SW-2 and is the **phone rollback floor**. It does three things:

1. **Opens by store presence, not a fixed number.** It opens with `indexedDB.open(name)` and no version, which opens whatever version exists. It upgrades (current + 1) only when a store it needs is missing. After this release, a future store never locks this binary out.
2. **Knows the future work database's name**, `aerowise-tech-work:<org>:<user>`, without writing to it. `forgetTenant` deletes it for an ended demo, `pendingFor` and `tidyOthers` count its pending ops, and the sign-out screen shows them.
3. **Outbox ops of an unknown kind wait.** They are neither run, failed nor deleted. A banner says "N items will send after the app updates".

Tests: v1 data and pending ops survive opening under SW-2a. A database created by SW-2 or later opens without error under SW-2a. Ended-demo cleanup removes both databases.

**SW-2: work storage in its own database.** Work records, work photo and signature blobs, and the work outbox live in `aerowise-tech-work:<org>:<user>`, which has its own stores and versioning. The existing inspection database stays at version 1, untouched. So even today's `0906828` binary can still open it.

- Work ops never span the two databases, because each op references only its own database's rows. Inspection and work sync independently, using the same `navigator.locks` lock name, so one tab drains both.
- Outbox ops in the work database are a tagged union: `work-sync`, `work-photo`, `signature`, `pumping-record`, `disposal-load`.
- **Below the floor:** if staging were ever rolled back below SW-2a, inspection work would be unaffected. Pending work ops would stay on the phone unsent, and an ended demo's work database would not be cleaned, until a release at or above SW-2a returned. This is disclosed, which is why SW-2a is the floor.

**Server side of SW-2:**

- `PUT /work/sync` mirrors `PUT /inspections/sync`. It sends the whole record every time, is idempotent on `offline_client_id`, treats a completed record as final and rejects reuse of a client id for a different job.
- Pump-outs, loads and signature references ride with their own client ids.
- Photo and signature uploads mirror the inspection photo route (`config.imageUpload`, sha256, `ON CONFLICT DO NOTHING`).
- `/route` returns work stops with their template version ids. The phone caches each needed template version (`template:<id>`, which already exists for lookups) plus the day's work types, vehicles and facilities, so the form works with no signal.
- `acknowledgeSync` and the `RetryLater` classes are reused.
- Business conflicts are covered in §8.5.

**Acceptance:**

- Two pumping jobs and one installation are completed with no signal, each with photos and a customer signature, then reloaded and reconnected. The office has each record exactly once.
- A newer phone edit made during an in-flight sync is preserved.
- An ended demo clears both databases.
- Another company's sign-in on the same phone stays separate.
- The rollback-floor tests above pass.

### 8.2 Data export, backup and restore, demo lifecycle

- Every new table is added to `EXPORT_TABLES` where it is customer data (work orders, lines, events, pumping records, disposal loads, estimates, plan versions, coverage uses), and to the API test truncate list.
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

### 8.5 Business conflicts while a technician is offline

The `5e491a0` rule protects the phone's own newer edits. It does not settle what happens when the office changed the job meanwhile. Those cases are handled as follows, and the field record is never discarded.

**Local completion is not server acceptance.** The phone shows three states per stop:

- "Done on this phone, waiting to send"
- "Sending: 2 photos, 1 signature left"
- "Received by the office"

A record is sent as `completed` only after every required photo and signature op for it is acknowledged. The draft downgrade already used for inspection photos is extended to signatures. The server accepts completion only when the required photo and signature counts are present server-side. Blobs are deleted from the phone only after the server acknowledges each upload.

**Signature-bound snapshot.** Before signing, the phone builds the customer summary (work done, parts, pump-out volume, notes marked customer-visible). It hashes the canonical JSON with sha256, and the customer signs that summary. The fields in the summary are then locked on the phone; editing one clears the signature and asks for a new one. The server recomputes the hash from the submitted record. A mismatch returns 409 `signature_mismatch`, the record stays on the phone, and the conflict screen explains it.

**Draft first, then uploads (R4).** The server must hold a record before any photo or signature can attach to it.

- When a technician starts a stop, the phone enqueues a `work-sync` op with `status: 'draft'` before anything else for that record. Every `work-photo` and `signature` op carries the record's client id and `after: <draft op id>`. The outbox drain sends an upload only once that draft op is acknowledged (the phone stores `draftAckedAt` on the record). Later full-record syncs follow the same order.
- `PUT /work/sync` with a draft creates the `work_record` idempotently on `(organization_id, offline_client_id)`. A completed record is still final, and reusing a client id for a different job is still refused.
- The upload routes resolve the owner by the record's client id: a `work_record`, else a `work_sync_conflicts` row, else **409 `record_not_synced`**. The phone classifies that one code as `RetryLater`, so a drain-order bug delays an upload but never strands it. It is a defensive path; the ordering above means it should not occur.
- **Signature identity.** A signature op carries its own `signatureClientId` and the snapshot sha256. The upload creates a `signed_documents` row with `unique (organization_id, offline_client_id)`, owned by the record or the conflict exactly like a photo. The record names its signature by client id, and the server resolves it at completion.
- A client id lives in `work_records` or in `work_sync_conflicts`, never both. Every insert or move takes a transaction-level advisory lock on `(organization_id, offline_client_id)` and checks the other table.

**Who may send: persisted assignment provenance.** A technician who has lost the job must still be able to hand in what they did, but an arbitrary technician must not.

- New append-only table **`job_assignments`**: `organization_id`, `id`, `job_id`, `technician_user_id`, `assigned_at`, `assigned_by`, `ended_at`, `end_reason` (`reassigned | unassigned | cancelled | office_completed`). Composite tenant foreign keys to the job and the technician's membership. Every assignment change on a work job writes it in the same transaction as the job update, under the job's `FOR UPDATE` lock. Rows are never updated except to set `ended_at` and `end_reason` once.
- `PUT /work/sync` and the upload routes decide by the caller and the job, in the caller's organization only:

| Caller | Response |
|---|---|
| Current assignee of a live job | Normal path (200) |
| Has a `job_assignments` row for this job (same organization, same user, still a member with `work:complete`), and the job was reassigned, cancelled, or its work order completed by the office | **202 `{ outcome: 'held_for_review', conflictId }`**, payload or blob stored on the conflict |
| Same organization, no provenance row for this job | 403 `not_assigned`; nothing is stored |
| Job, record or client id in another organization | 404, as everywhere else |

- **202 is an acknowledgement, not an error.** The retry classifier treats every 2xx as delivered: `acknowledgeSync` runs, the op leaves the outbox, and the stop shows "Sent to office for review". So a held item can never be stranded as a failed 409 or retried forever. 409 is now reserved for cases where the technician must act: `signature_mismatch` (below) and client id reuse for a different job. Those stay visible with a Retry button, as today.
- While a conflict is `held`, a repeat full sync replaces its payload and keeps the newest phone revision. Repeat uploads with the same client id are `ON CONFLICT DO NOTHING`. After the office resolves it, further sends return 200 `{ outcome: 'resolved', resolution }` and change nothing.

**What the office does to the job converts a draft.** Reassigning, cancelling or office-completing a job, in the same transaction and under the job lock, ends the `job_assignments` row and moves any **draft** `work_record` for that job into a new `work_sync_conflicts` row (status `held`, same client id). Its photos and signature change owner to the conflict. That frees the job's unique `job_id` for the new assignee's own record. A completed record is already final and is never moved.

**The office changed the job while the phone was offline.** Server responses:

| Situation | Server response | What happens to the field record |
|---|---|---|
| Job reassigned to another technician | 202 `held_for_review` (original assignee, by provenance) | Stored in **`work_sync_conflicts`**: the full payload, plus photos and signature owned by the conflict. The phone marks it "Sent to office for review". The office attaches it (accepted as submitted by the original technician, audited) or dismisses it with a reason. Attaching to a job that already has a completed record creates a new visit job on the same work order for it. |
| Job or work order cancelled | 202 `held_for_review` | Same. Attaching to a cancelled job records it on a new completed visit job, so the cancellation and the work both stay in the history. |
| Office completed the work order without a field record | 202 `held_for_review` | Same. The office may attach it as the field record, which replaces "completed without record". |
| Form template changed | Accepted | The record is validated against the template version it was started with, which the phone pinned. Retired versions remain valid for records started before retirement. |
| Prices or service items changed | Accepted | Field-added lines carry the price snapshot from download. At invoicing the office sees "price changed since the visit" per line and chooses which price to bill. |
| Coverage changed (limit used by another work order) | Accepted | The phone's "Covered" badge was informational. The office invoice uses the reservation state (§4.3). |

The phone's conflict screen lists each held item with the reason and "Sent to office for review", or "Needs your action" for a signature mismatch. Retries reuse the same client ids, so a conflict entry is created at most once per record (`unique (organization_id, offline_client_id)` on `work_sync_conflicts`).

**R4 tests** (API integration plus one Playwright offline run, each with two photos and a customer signature taken offline):

1. Reassign **before the first draft sync**: the draft sync, both photos, the signature and the completed sync each get 202 for the same `conflictId`. There is one conflict row, two photo attachments and one `signed_documents` row owned by it. The outbox is empty afterwards and the stop says "Sent to office for review".
2. Cancel before the first draft sync: same as test 1.
3. Reassign **after the draft sync, before the first upload**: the reassign transaction moves the draft to a conflict. The uploads that follow get 202 and attach to it. The new assignee then starts and completes their own record for the same job without a unique violation.
4. Cancel after the draft sync, before the first upload: same as test 3.
5. Office-complete after the draft sync, before the first upload: same, and attaching replaces "completed without record".
6. Forced out-of-order upload (test hook skips the drain order): 409 `record_not_synced`, retried, then accepted after the draft lands.
7. A same-organization technician never assigned to the job gets 403 with nothing stored. Another organization gets 404.
8. Replay of every op after a 202: no new rows and no duplicate blobs. After the office resolves the conflict, a replay gets 200 `resolved`.
9. Office attach: the attachments change owner, storage keys are unchanged, and the record is credited to the original technician in `audit_events`.

**Storage and failures.**

- The app requests `navigator.storage.persist()`.
- On a quota error the phone keeps every existing record and blob and blocks new photos with "Phone storage full: send waiting items first". Nothing queued is dropped.
- A permanently failed upload (non-retryable 4xx) is shown with a Retry button and is never deleted.
- An ended or expired demo deletes its pending work, photo and signature ops along with the demo's databases (fictional data, as STG-03 does for inspections).
- For a real company, cleanup never deletes pending ops.

**Tests:**

- Reassign, cancel and office-complete while offline, then reconnect: one conflict row each, and the office resolves them (R4 tests 1–9 above).
- A template change while offline.
- A signature mismatch after an edit.
- A quota error simulated in the browser test.
- A permanently failed upload.
- An expired demo with pending signature ops.
- A real company with pending ops whose session expired: the work is kept.

## 9. PR sequence

Each PR is a draft until local checks pass on its exact head ([§9.2](#92-validation-for-every-implementation-pr)). Codex reviews and merges. Migrations are forward-only and additive. Numbers are assigned in merge order starting after `0047` by the integration owner (§10): **only one migration-carrying PR is open for merge at a time**, and a PR that loses the race renumbers before merge (DECISIONS records that renumbering leaves stale local test databases). Every PR updates its ROADMAP.md row, adds demo data for its feature behind its flag, records ambiguous choices in DECISIONS.md and keeps the existing aerobic tests green.

| # | PR | Depends on | Scope | Acceptance highlights | Migration |
|---|---|---|---|---|---|
| SW-0 | This plan | none | `docs/engineering/SERVICE-WORKFLOWS-IMPLEMENTATION-PLAN.md`, a ROADMAP row | Links resolve; lint and typecheck pass | none |
| SW-1 | **Work foundation** (flag `work_orders`) | SW-0 | `work_types`, `work_orders`, `work_order_events`, `work_order_notes`, `work_order_lines` (without service items); the `jobs` changes from §1.2 (type, `work_order_id`, `retest_of_inspection_id`, `visit_number`, `obligation_service_type` with its pairing check, derivation trigger and composite key, the one-open-job-per-work-order index); `inspections.job_type` (not null, composite key); `issues.work_order_id`; `service_requests.work_order_id` plus the response join fix; permissions; routes from §1.4 except sync, invoice and conflicts; **every existing `jobs` query filtered by `type` explicitly** (schedule, routing, inspections, inbox, readiness, SMS route and task, invoice lib, compliance packages); office `/work` pages; inbox conversion; schedule kind badge; demo story | §1.6; zero filings or aerobic obligation changes; the §1.2 direct SQL tests (NULL and forged discriminators, old-writer insert); converting twice gives one work order | yes |
| SW-2a | **Phone compatibility release** (rollback floor for the phone) | SW-0 | Client only: store-presence open, awareness of the work database name in cleanup and pending counts, unknown outbox ops wait (§8.1) | v1 data and pending ops survive; a later database opens without `VersionError`; ended demo removes both databases | none |
| SW-F | **Shared form and signature foundation** | SW-1 | `inspection_templates.purpose` and the signature requirement block; distinct template keys per purpose (old readers select the inspection template by key, `apps/api/src/routes/inspections.ts` `activeTemplate`); generic repair and service-call templates; the signature pad component (phone and web); `signed_documents.kind` widened to `work_completion` and `estimate_acceptance`; the web intake-form renderer used later by SW-8 | Old binary still serves the inspection template after seeding; templates immutable per version; signature snapshot hash test | yes |
| SW-2 | **Technician offline work** | SW-1, SW-F, SW-2a **deployed to staging** | Work database (§8.1), `work_records`, `work_attachments` (record and conflict owners), `work_sync_conflicts`, `job_assignments` (written by SW-1's assign routes from this PR on), draft-first ordering, `/work/sync`, photo and signature routes with `held_for_review`, conflicts API and screens (§8.5), `/route` work stops, `/tech` work form | §8.1 acceptance; §8.5 R4 tests 1–9; existing offline e2e unchanged | yes |
| SW-3 | **Service items and work invoicing** (flag `service_items`) | SW-1 | `service_items`, `invoice_lines.service_item_id`/`quantity_milli`, invoice from a work order (idempotent per work order), QuickBooks `service_item` mapping with default-item fallback | One invoice per work order under concurrent calls; old invoices' QuickBooks payloads byte-identical; untaxed work invoices sync | yes |
| SW-4 | **QuickBooks mixed tax** (per-connection `tax_mode`, off) | SW-0 | Tax code mapping, `TaxCodeRef`/`TxnTaxDetail`, deterministic `requestid` kept, compare after create, `quarantined` link state, held payments, review choices (§3.7) | Test provider: matching, mismatching and lost-response cases; no duplicate remote invoice; mode off is today's behavior | yes (small) |
| SW-5 | **Estimates and deposits** (flag `estimates`; `deposit_mode` per organization) | SW-1, SW-3, SW-F; SW-4 for taxed sync | §3.3–§3.8, including cancellation after acceptance, `estimate_invoices` with void-aware uniqueness, the append-only `deposit_ledger`, invariants I1–I5, the "Refund the job" flow with the `deposit_reversal` credit, refund reservations settled by provider status plus `payments.reconcile_refunds`, and QuickBooks deposit handling behind its conflict | Concurrent accept, checkout replay; the §3.6 test list, including the ledger equality after every operation, two distinct external refunds with replays, apply and unapply after a shortfall, and refund **pending → succeeded** and **pending → failed** with replayed webhooks (test payment provider) | yes |
| SW-6 | **Pumping and disposal** (flag `pumping`) | SW-2 | `vehicles`, `disposal_facilities`, `pumping_records` and `disposal_loads` as revision groups, canonical `volume_milligallons`, `disposal_load_items`, `work_attachments.disposal_load_group_id` (added here, widening the one-owner check), pumping starter template, "Record disposal" on phone and office, overdue-disposal inbox item, site history, CSV/PDF log, exports | §2.5 | yes |
| SW-7 | **System categories, conventional and installation** | SW-2, SW-F | `wastewater_systems.system_category` plus backfill, aerobic-contract warning, conventional and installation templates, multi-visit installation flow, completion summary PDF, portal listing | No aerobic reporting on non-aerobic work; two-visit install with final sign-off exactly once | yes |
| SW-8 | **Plan versions, terms, options, coverage** (flag `plan_builder`) | SW-1, SW-3, SW-F | `plan_versions` plus v1 backfill, `contracts`/`renewals.plan_version_id`, `contract_coverage_rules`, `coverage_uses`, agreement snapshot, builder tabs, intake at renewal (SW-F renderer), options, coverage evaluation and reservation (§4.3) | Existing contracts unchanged after backfill; concurrent exhaustion test; frozen rules ignore later plan edits; override audited | yes |
| SW-9 | **Non-inspection service cycles** (flag `service_cycles`) | SW-8, SW-6 | `contract_service_cycles` plus backfill, `service_obligations.cycle_id` (not null, creating fill trigger), unique-constraint replacement, `work_orders.obligation_id` with its NULL-proof key and `work_orders_one_per_obligation`, interval schedules, cycle scheduling as work orders with ordinary visit jobs, service-type filters (§4.4) | Aerobic fixture schedules byte-identical; §4.4 direct SQL tests; two-visit cycle obligation; two cycles both number from 1 | yes |
| SW-10 | **Work on the street map** | #97 merged, SW-2 | `Stop.kind`/`workOrder`/`durationMinutes`, pins and filter, per-stop service time in `packages/routing` | Same-origin network check still passes; honest estimate labels; optimize includes work stops | none |
| SW-11 | **Authority export framework** | SW-0 | Ruleset `export` block, `csv_export` method, export file in the submission package, Example County fixture only | Signed, sent and confirmed unchanged; demo notice column; no real-authority block | yes (check widening) |
| SW-12 | **Cross-feature walkthrough** | all above | Full §12 matrix, scratch backup/restore with new data, rollback-floor drills, screenshots, handoff/README/ROADMAP update | Every row in §12 passes on one integration SHA, recorded with exceptions | none |

### 9.1 Merge, deploy, feature flags, rollback floors and forward recovery

- **Merge:** Codex reviews the draft and the local check record, then squash-merges. A schema PR merges only after the previous migration PR is on `main`. The branch merges `main` and reruns checks if `main` moved.
- **Deploy:** staging only, through the documented manual workflow in [DEPLOY.md](DEPLOY.md) and [RUNBOOK.md](RUNBOOK.md), run by Codex. `DEMO_MODE` stays on. The steps are: run the migration, deploy with the PR's flag **off**, check the existing walkthrough, turn the flag on, reseed the public demo so the new story appears, and walk owner, office and tech through the feature. Production stays pinned until Justin separately authorizes it.
- **Feature flags:** `AEROWISE_FEATURES` is a comma-separated deployment setting read by API, worker and web. It is on for staging when Codex chooses and off elsewhere. A flag that is off:
  - hides the create UI;
  - refuses create routes with 409 `feature_off`;
  - skips that feature's part of the demo story.

  Existing records stay readable and can be finished, so nothing is stranded when a flag is turned off.
- **Rollback floors:** rollback is promised only down to a release's **floor**, never to an arbitrary earlier SHA. Below a floor, the only route back is restoring the pre-deploy backup, per the RUNBOOK, which loses later data. That is a disaster step, not a rollback.

| Release | Floor once its flag is on (or once it is deployed, if it has no flag) | Why | Forward recovery |
|---|---|---|---|
| SW-1 | SW-1 | Pre-SW-1 queries do not filter `jobs.type` and would treat any work job (live, completed or historical) as an inspection | Flag off stops new work; fix forward |
| SW-2a | SW-2a (phone) | Earlier binaries open IndexedDB with a fixed version and cannot clean or count the work database | Redeploy SW-2a or later |
| SW-F | SW-F | Work templates and new document kinds exist; earlier code ignores them safely by key, but SW-2 and later need them | Fix forward |
| SW-2 | SW-2 (server) and SW-2a (phone) | Work records, conflicts and attachments exist | Flag off; pending phone work waits safely |
| SW-3 | SW-3 | Earlier draft editing would rewrite `quantity_milli` lines | Flag off; fix forward |
| SW-4 | SW-4 only if any link is `quarantined` | Earlier code doesn't know that state; with tax mode off, rollback to before SW-4 is safe | Set every connection's tax mode off and resolve quarantines first |
| SW-5 | SW-5 once any invoice has `deposit_applied_cents > 0` | Earlier `recalcInvoice` would compute the wrong amount due | Flag off stops new estimates; existing deposits stay serviceable |
| SW-6 | SW-2 floor still holds | Pumping tables are separate; earlier code ignores them | Flag off |
| SW-7 | SW-2 floor still holds | A nullable column and templates under new keys | none needed |
| SW-8 | SW-8 once a plan has a version with its own terms, options or coverage | Earlier renewal signing would use organization terms and ignore frozen coverage | Flag off; contracts keep frozen rows |
| SW-9 | SW-9 once a non-aerobic obligation exists | Earlier due lists would show pumping visits as inspections. The database still blocks an inspection job on them. | Flag off; existing cycle obligations stay schedulable as work |
| SW-10 | none beyond SW-2 | Display only | none |
| SW-11 | SW-11 once a filing uses `csv_export` | Earlier code doesn't know that method | Fix forward |

**Rollback drills:** SW-12, and each PR that declares a floor, deploy the floor SHA against the new data in a scratch environment and run the floor's tests. That proves the floor actually works.

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

These are proposed only. **No worker starts until Justin says so.** Suggested concurrency is two or three at once, because of Justin's usage limits.

**Integration owner.** One role, held by Worker A for the whole program, owns the shared files:

- `packages/db/src/schema.ts` and migration numbering;
- `packages/domain/src/roles.ts`;
- `packages/db/src/seed.ts` and `apps/api/src/demo-story.ts`;
- `packages/tasks/src/export-task.ts`, the task kind registry in `packages/tasks/src/index.ts` and `providers.ts`;
- route registration in `apps/api/src/app.ts`;
- `apps/api/test/helpers.ts` (the truncate list);
- the feature-flag module, `docs/engineering/ROADMAP.md` and `docs/DECISIONS.md`.

Other PRs change these files only in one clearly labeled commit (`shared: …`). The integration owner reviews that commit, resolves any conflicts in these files when rebasing ahead of Codex's merge, and assigns the migration number. Nobody else resolves conflicts in shared files.

| Worker | PRs | Owns (edits only here, plus its own tests) | Must not edit |
|---|---|---|---|
| **A: Work foundation and integration** | SW-1, SW-3, SW-12; integration owner | Work domain/routes, `schedule.ts` work paths, the `type` filters in existing job queries, `readiness.ts` response join, office `/work` pages, inbox buttons, `service_items`, `apps/api/src/lib/invoices.ts` core, shared files above | Offline lib, compliance internals, renewals package |
| **B: Phone and forms** | SW-2a, SW-F, SW-2, SW-10 | `apps/web/lib/offline/**`, `apps/web/app/tech/**`, `apps/web/components/tech/**` (after #97 merges), template `purpose` and signature block, signature pad, generic templates, `work-sync.ts`, conflicts API and screens; after #97 merges, map pin props and `packages/routing` service time | Inspection sync server code (read-only reference), invoices, #97's files until it merges |
| **C: Billing and estimates** | SW-4, SW-5 | `packages/quickbooks/**`, estimates domain/routes/pages, public `/estimate/[token]`, deposit tables and invariants (through a reviewed hook in A's invoice core landed in SW-3) | Offline lib, renewals |
| **D: Plans and contracts** | SW-8, SW-9 | `packages/renewals/**`, `packages/domain/src/contracts.ts`, `renewals.ts`, domain `schedule.ts`, contracts/renewals routes and pages, coverage tables and reservation code, cycle tables and filters | Offline lib, quickbooks; `openFiling` only through the database constraint, not code |
| **E: Pumping and systems** | SW-6, SW-7 | Pumping/disposal/vehicle/facility domain and routes, pumping, conventional and installation templates, `crm.ts` system category, completion summary PDF, phone disposal and installation sections **delivered as components that B's form renderer mounts** | Offline store schema (asks B) |
| **F: Filing interop** | SW-11 | `packages/compliance/**` export framework, ruleset schema, Example County fixture | Real-authority rulesets (drafts stay as they are) |

**Waves** (covered by Justin's standing authorization of October 7, 2026; each starts once its prerequisites are reviewed and merged):

1. A (SW-1), B (SW-2a), and optionally C (SW-4) and F (SW-11). These touch separate code; migrations queue through A.
2. B (SW-F, then SW-2) and A (SW-3).
3. C (SW-5), E (SW-6, then SW-7) and D (SW-8).
4. D (SW-9), B (SW-10, after #97 merges), then A (SW-12).

## 11. Risk and effort

Effort is relative (S, M, L, XL) and assumes the conventions above. No calendar dates are given.

| Area | Effort | Main risks | Mitigation and assumptions |
|---|---|---|---|
| SW-1 Work foundation | L | Widening `jobs.type` affects every job query, including historical and completed rows | Explicit `type` filter in each existing query, with a test per query; database-enforced kinds; floor SW-1 |
| SW-2a Phone compatibility | S | A lingering old binary on a phone | It must be deployed before SW-2; floor drill |
| SW-F Forms and signatures | M | An old binary picking a work template as the inspection form | Distinct keys; upgrade-path test with the old binary |
| SW-2 Offline work | XL | Two databases, blob durability, business conflicts, quota, physical phone behavior | §8.1 and §8.5 tests, including draft-first ordering and `held_for_review`; G-DEVICE before pilot reliance |
| SW-3 Service items and invoicing | M | Fractional quantities change line math | `quantity_milli` only on new rows; payload snapshot tests; floor SW-3 |
| SW-4 Mixed tax in QuickBooks | M | Automated sales tax recomputes; a wrong remote invoice exists before detection | Mode off for real companies until G-QBO-TAX; deterministic `requestid`; quarantine and held payments |
| SW-5 Estimates and deposits | XL | Double conversion or charge; deposit larger than final; refunds after application; accounting treatment | Unique indexes (void-aware), one lock on D for every ledger write, invariants I1–I5, ledger equality tests, refund reservations settled only by provider status; G-TAX-TREATMENT, G-QBO-DEPOSIT |
| SW-6 Pumping and disposal | M | Implying regulatory compliance; facility data licensing; load/volume mismatch | Neutral wording; provider-entered or cited public facility data; mismatch shown, not refused; revision groups and exact unit conversion; G-HAUL, G-FAC |
| SW-7 Conventional and installation | M | Misclassified existing systems; multi-visit installs | Backfill only from aerobic contracts; warning not refusal; explicit `final_visit` |
| SW-8 Plan versions and coverage | XL | Backfill must not change any existing contract; concurrent limit use; legal text | v1 backfill uses `terms_text=null`; locked reservation; snapshot equality tests; G-LEGAL, G-COVERAGE |
| SW-9 Service cycles | L | Constraint replacement on obligations; a pumping obligation reaching filings | Fill trigger for old writers; database-enforced kinds; byte-identical aerobic fixtures |
| SW-10 Map work pins | S–M | Dependency on an unmerged PR | Start only after #97 merges; additive fields |
| SW-11 Export framework | M | Over-claiming acceptance | Example County only; G-AUTH-CSV before any real block |
| SW-12 Walkthrough | M | Sandbox interruptions | Record exceptions; one integration SHA; floor drills |

The largest assumptions:

- The pilot actually uses pumping, installation or estimates (Needs from Justin).
- QuickBooks work can be built and tested entirely against the built-in test QuickBooks provider. **Live Intuit sandbox access was not verified in this session.** It is a separate prerequisite for the G-QBO gates (prerequisite P-QBO-SANDBOX in §13), and no account will be created for it.

---

## 12. Browser acceptance matrix

SW-12 runs the full matrix on one integration SHA. Each feature PR runs its own rows. Phone rows use the e2e Pixel 7 profile; a physical phone is gate G-DEVICE.

| # | Scenario | Org types | Device | Expected |
|---|---|---|---|---|
| 1 | Create, schedule and complete each work category (pumping, repair, install, other) | Public demo, personalized demo, trial, real-test | Office desktop + tech phone | Lifecycle and events correct; no filing, report, compliance event or aerobic obligation change |
| 2 | Aerobic inspection regression: schedule, offline complete, sign, file, confirm, retest | Same | Both | Unchanged results versus `0906828` baseline tests |
| 3 | Offline: two work jobs plus one inspection completed with no signal, photos and signatures, reload, reconnect | Demo and trial | Phone | Each record, photo and signature arrives exactly once; newer in-flight edits preserved |
| 4 | Phone compatibility: v1 database with pending inspection ops opened by SW-2a, then SW-2; rollback drill to the SW-2a floor | Trial | Phone | Pending ops sync once; no `VersionError`; pending work waits during the drill and sends after |
| 5 | Convert an inspection issue and a portal request to work, twice each | All | Office | One work order each; history on both sides |
| 6 | Two pump-outs at different sites, one disposal load later (offline), then a correction | Demo and trial | Phone + office | Overdue-disposal item raised then cleared; each pump-out in exactly one load; original rows kept |
| 7 | Estimate send, view, revise, accept old version (409), accept current, pay deposit, convert, complete, final invoice | Demo (test payments) and trial | Homeowner phone + office | One work order, one deposit invoice, one charge; final amount due = total − deposit |
| 8 | Concurrent double accept and checkout replay | Trial | API + browser | Idempotent; no double charge |
| 9 | Cancel after acceptance with a paid deposit: refund it, and in a second case retain it with a reason | Trial | Office | Work order cancelled, reservations released, disposition recorded; QuickBooks refund receipt where connected |
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
| 23 | Deposit larger than the final amount; refund attempt beyond the free balance; webhook refund after application | Trial | Office + API | Applied only up to the final amount; unapplied item raised; 409 `deposit_not_available`; exactly one shortfall item; ledger equality holds |
| 24 | QuickBooks tax mismatch and lost-response retry (test provider) | Trial | Office | One remote invoice only; link quarantined; payments held; recheck releases |
| 25 | Two covered work orders racing for the last allowed use; then cancel, void and override paths | Trial | API + office | Exactly one covered; counts restored correctly |
| 26 | Job reassigned, cancelled and office-completed while the phone was offline | Trial | Phone + office | 202 "Sent to office for review", never a failed item; one conflict row each; record never lost; office resolves |
| 27 | Customer signature, then an edit of a signed field; template change while offline | Trial | Phone | Re-sign required; server rejects a mismatched hash; old template version accepted |
| 28 | Phone storage full; permanently failed upload | Trial | Phone | Nothing queued is dropped; clear message; Retry works |
| 29 | Expired demo with pending work, photo and signature ops; real company with an expired session and pending work | Demo and trial | Phone | Demo databases removed; real work kept |
| 30 | Two-visit installation with a final sign-off; work job against an aerobic obligation (API) | Trial | Phone + API | Second visit completes the work order; the database rejects the wrong kind |
| 31 | Pumping-cycle plan with two cycles on one contract | Trial | Office | Both number from 1; scheduling twice gives one work order and one live job |
| 32 | Work job, inspection and work order rows written with NULL or forged kind columns (direct SQL) | Test database | SQL | Every case in §1.2 and §4.4 refused or derived as specified |
| 33 | Reassign or cancel before the first draft sync, and after it but before the first upload, each with two photos and a signature | Trial | Phone + office | §8.5 R4 tests 1–5: one conflict with all blobs; outbox empties; the new assignee completes their own record |
| 34 | A same-organization technician never assigned to the job sends a record | Trial | API | 403 `not_assigned`, nothing stored |
| 35 | Fully deposit-funded final invoice ($0 due), then "Refund the job"; void and re-invoice | Trial | Office + API | Deposit reversal credit keeps F at $0 due; F2 created after void; ledger equality holds |
| 36 | Correct a pump-out after its load; liters and gallons in one load; load manifest after a demo reset | Trial and demo | Phone + office | §2.5: one current revision, exact canonical total, manifest follows the load group and is removed with the demo |
| 37 | Deposit refund that stays pending, then fails; another that succeeds; two distinct dashboard refunds after full application, then void (test payment provider) | Trial | Office + API | Pending money is unavailable; failure restores it once with an inbox item; success books once; shortfall equals the real deficit and is released on void |

---

## 13. Validation gates and needs from Justin

### 13.1 Gates

These gates never stop the software from being built. Each one decides only whether a real-world claim or real-authority configuration may be switched on.

| Gate | Question | Evidence needed | Blocks |
|---|---|---|---|
| **P-QBO-SANDBOX** (prerequisite) | Is live Intuit sandbox access available to Codex for this work? | Codex confirms existing access. Not verified in this session; no account is created. | Running G-QBO-TAX and G-QBO-DEPOSIT (software tests use the built-in test provider either way) |
| **G-QBO-TAX** | Do mixed taxable invoices post with matching totals, including with automated sales tax? | Sandbox round trip recorded by Codex | Turning tax mode on for a real company |
| **G-QBO-DEPOSIT** | Which QuickBooks representation of a deposit (H-DEP-2 or linked payments) keeps totals, revenue, tax and deposit balance coherent? | Sandbox round trip plus the provider's bookkeeper's preference | Deposit invoices syncing for real companies |
| **G-TAX-TREATMENT** | Is a deposit on the pilot's services untaxed until the work is invoiced (H-DEP-1)? | The provider's own tax treatment or advisor | Choosing `deposit_mode` for a real company |
| **G-HAUL** | Which transporter registration and manifest fields does the pilot provider's jurisdiction require, and what is the retention period? | The provider's current manifest form and registration, plus a primary-source citation | Any field marked "required by regulation" |
| **G-FAC** | Which facilities does the pilot use, and is there a usable public list? | Provider list, or a named public source and its terms | Bulk facility import |
| **G-AUTH-CSV** | What is the pilot authority's accepted export spec, upload channel and receipt? | Authority spec plus one accepted sample, logged as evidence | A real-authority `export` block |
| **G-COVERAGE** | What do the provider's real tiers cover, and do pumping cycles restart at renewal? | Redacted plan documents and contracts | Seeding real tier definitions (demo uses fictional tiers) |
| **G-LEGAL** | Is the estimate, agreement and sign-off text acceptable? | Legal review | Use with real homeowners |
| **G-DEVICE** | Does a physical phone handle camera, signature, storage limits, close, reopen and reconnect? | Physical-device run | Field-pilot reliance |
| **G-STRIPE-DEPOSIT** | Do Stripe test-mode deposit, payment and refund work on staging? | Staging walkthrough with existing test keys (no new account) | Real deposits |

### 13.2 Needs from Justin

Each item has a stand-in so the build can go ahead without it.

1. **Pilot provider and actual permit authority.** These are already open in the handoff. They decide G-AUTH-CSV and G-HAUL scope. Stand-in: Example County and fictional data. *Recommendation: answer this first. Nothing else here waits on it.*
2. **Does the pilot do pumping, repairs, installation and estimates?** This sets the build order after SW-2. Stand-in: build everything in the plan's order. *Recommendation: keep the order and only reorder SW-5 to SW-7 if the pilot lacks a category.*
3. **The provider's redacted plan, contract and estimate documents** (G-COVERAGE, G-LEGAL). Stand-in: fictional Basic, Gold and Platinum in the demo. *Recommendation: ask for them with the existing sample pack.*
4. **Whether Codex has live Intuit sandbox access** (P-QBO-SANDBOX). Stand-in: the built-in test QuickBooks provider. *Recommendation: Codex checks what already exists. Create no new account.*
5. **Deposit policy and estimate expiry default.** Stand-in: no deposit and 30-day expiry by default, configurable per estimate. *Recommendation: accept these defaults.*
6. **Whether the pilot uses QuickBooks and automated sales tax.** Stand-in: tax mode off, with today's conflict. *Recommendation: run G-QBO-TAX once P-QBO-SANDBOX confirms access; tax mode stays off for real companies until then.*
7. **Approval to start workers** in the waves of §10. *Decided October 7, 2026: a standing authorization for every wave in dependency order; Wave 1 (SW-1, SW-2a) started first. Gated actions (costs, accounts, DNS, pricing, production, real outreach, filings or charges) still need separate approval.*

---


## 14. First implementation step

Authorized October 7, 2026: start two workers. The other waves follow §10 under the same standing authorization, as their prerequisites land.

- **Worker A on SW-1 (work foundation), flag `work_orders` off by default.**
  - The first commit adds the explicit `type = 'inspection'` filter to every existing `jobs` query, with a test per query. That makes the code safe to read work rows before any exist.
  - The next commit is migration `0048` (or the next free number), adding:
    - the `work_types`, `work_orders`, `work_order_events`, `work_order_notes` and `work_order_lines` tables;
    - the `jobs` changes, including the kind-enforcing composite keys and `visit_number`;
    - `inspections.job_type`;
    - `issues.work_order_id` and `service_requests.work_order_id`.
  - Matching `schema.ts` types, the truncate-list entries and database tests that reject wrong job/obligation kinds come with it.
  - Routes, office UI and the demo story follow in the same PR.
- **Worker B on SW-2a (phone compatibility release).** This is client only and has no schema change. It must be deployed to staging before SW-2 can merge.

SW-4 (QuickBooks tax, against the test provider) and SW-11 (export framework) may run alongside, because they touch separate packages.

---

## 15. Review response (Codex on `54e2672`)

| # | Finding | Resolution in this revision |
|---|---|---|
| 1 | Rollback compatibility invalid: a fixed `DB_VERSION=1` binary gets `VersionError` on a v2 database; cancelling work jobs doesn't make historical rows safe; deposit/fractional rows; arbitrary-SHA rollback | The inspection database version is never raised. Work data lives in a separate per-tenant database. **SW-2a**, a client-only compatibility release (store-presence open, cleanup and counts of the work database, waiting unknown ops), ships first and is the phone floor (§8.1). New ground rule 9 (expand, read, then write). §9.1 now has feature flags, a **rollback floor per schema-changing release**, the reason and forward recovery for each, and floor drills. Rollback to arbitrary SHAs is explicitly not promised. SW-1 now filters every existing job query by `type`, and its floor is SW-1 because historical work rows exist. SW-3 and SW-5 floors cover fractional quantities and applied deposits. |
| 2 | Cycles collide on `UNIQUE(contract_id, sequence)`; identity, backfill and anchoring unspecified; rule 0.1 contradiction; app-only filters | §4.4: `contract_service_cycles` with a stable `cycle_key`, frozen snapshot and linked work type; `service_obligations.cycle_id` with a composite key matching service type; the unique constraint replaced by `unique(cycle_id, sequence)` plus an aerobic partial index; a fill trigger for old writers; contract-start anchoring and windows; idempotent scheduling; a list of count/report filters. Rule 0.1 now says "never changes **aerobic** obligations", and a work job may complete a non-aerobic cycle obligation. §1.2: job/obligation kinds and inspection/job kinds are **enforced by composite foreign keys and checks**. Tests cover both directions. |
| 3 | Deposit lifecycle and accounting underspecified; "no wrong total is ever posted" was false | §3.4: cancellation after acceptance, its effect on the work order, draft and issued final invoices, and deposit disposition (refund or retain, never automatic). §3.6: invariants I1–I5 (deposit larger than final, refund after application, outside refunds create a shortfall item) and a ledger test. Untaxed deposit and the negative QuickBooks line are now **hypotheses H-DEP-1/H-DEP-2** behind G-TAX-TREATMENT and G-QBO-DEPOSIT, with tests of revenue, tax and deposit balance, not just `TotalAmt`. §3.7: the sentence is corrected. A mismatch is detected after the remote invoice exists; the deterministic `requestid` prevents duplicate creates; quarantine holds payments; review choices are defined. The deposit model was then rebuilt by R3 (§15.1). |
| 4 | Coverage limits: no `rule_key`; concurrency; lifecycle | §4.2: stable `ruleKey`, `optionKey` and `cycleKey`. §4.3: rules frozen per contract in `contract_coverage_rules`; `coverage_uses` with reserved, consumed and released states; reservation under a row lock; defined effects of cancel, void, override, refund, reschedule and line changes; no recomputation against newer plans; concurrent exhaustion tests. |
| 5 | SW-8 missing a dependency on the form foundation; SW-2/SW-7 overlap; no integration owner; one live job and record per work order | New **SW-F** (forms, signatures, intake renderer), on which SW-2, SW-5, SW-7 and SW-8 depend. Starter templates are each owned by exactly one PR (§5.2). §10 names an **integration owner** (Worker A) for shared files, with `shared:` commits and migration numbering. §1.2/§1.3: several visits per work order are supported deliberately (`visit_number`, one *live* job at a time, `final_visit`). Pump-outs and disposal loads are separate records (§2.2). One technician per job is a disclosed limitation. |
| 6 | Server/offline business conflicts | New §8.5: local completion versus server acceptance states; completion only after durable photo and signature uploads; signature-bound snapshot hash; `work_sync_conflicts` for reassignment, cancellation and office completion (record never discarded); template and price change rules; conflict screens; retry semantics; quota and failed uploads; expired-demo cleanup with pending ops. Matrix rows 26–29. Upload bootstrap and the conflict acknowledgement were then redone by R4 (§15.1). |
| — | Sandbox credentials assumed | Corrected (§11, §13). Software tests use the built-in test QuickBooks provider. Live Intuit sandbox access is a separate prerequisite, **P-QBO-SANDBOX**, not verified in this session, and no account is created for it. |

**Design choices left open on purpose** (each has a default, so the build doesn't wait on it):

- **U1:** several assignees per job. Default: one technician plus a free-text `crew_note`.
- **U2:** per-quantity coverage limits, such as gallons. Default: one use per work order per rule.
- **U3:** pumping-cycle anchoring across renewals. Default: anchored to each contract's start. Gate G-COVERAGE decides whether to carry it forward.
- **U4:** the QuickBooks representation of deposits. Default: H-DEP-2 behind its conflict, until G-QBO-DEPOSIT.
- **U5:** deposit tax treatment. Default: H-DEP-1, selectable per organization, off for real companies until G-TAX-TREATMENT.
- **U6:** whether a conflict record may be turned into a new work order automatically. Default: no, the office decides.

### 15.1 Final targeted pass (Codex on `df8e51b`)

| # | Finding | Where it is resolved | Tests |
|---|---|---|---|
| R1 | Kind guards could be bypassed with NULL (`CHECK` accepts NULL; `MATCH SIMPLE` skips a key with a NULL column) | §1.2 "Kind guards without a NULL bypass": `jobs.obligation_service_type` with a pairing check, the `jobs_derive_obligation_kind` trigger (overwrites supplied values) and a fully non-null composite key; `inspections.job_type` is `NOT NULL` with a default. §4.4: `service_obligations.cycle_id` is `NOT NULL`, filled or created by `obligations_assign_cycle`, with an all-non-null composite key; `work_orders.obligation_id` uses the same pairing scheme | §1.2 and §4.4 direct SQL test lists; matrix rows 30 and 32 |
| R2 | Several visits per work order conflict with `jobs_one_live_per_obligation`, which also counts completed jobs | §1.2: work jobs never reference obligations; one open job per work order through a separate index; the aerobic index is unchanged. §4.4: a non-aerobic obligation links to its **work order** (`work_orders_one_per_obligation`), and its visits are ordinary work jobs | §4.4 scheduling tests (two visits, concurrent scheduling, scheduling after final); matrix rows 30 and 31 |
| R3 | Deposit model inconsistent: I1 against external refunds, retained bounds, refund of a paid F (including $0 due), unique final invoice blocking void and re-invoice, no concrete cent equality | §3.6: `estimate_invoices` with an active-only unique index plus void-aware `invoices.work_order_id`; append-only `deposit_ledger`; balances R, X, A, T, S and `U`; I1 (deferred check), I2 (Aerowise moves limited to real money, retained money excluded), I3 (external refunds recorded with an exact shortfall, never refused), I4, I5; "Refund the job" with the `deposit_reversal` credit; the ledger equality `P + Σ due_F = Σ (G_F − C_F) + T + U − S` | §3.6 test list (eight cases); matrix rows 23 and 35 |
| R3 follow-up | I3 appended the cumulative deficit on each distinct external refund, double-counting earlier shortfalls; Stripe refunds can be pending or fail | §3.6: `S` is now the **current** deficit, adjusted by `shortfall` / `shortfall_released` deltas so `U = max(0, R − X − Q − A − T)`; resolutions tracked separately in `deposit_shortfall_resolutions`; Aerowise-started refunds reserve (`Q`) in a committed pending `refunds` row, call the provider after commit with the existing idempotency key, settle (including the `deposit_reversal` credit on F) only on `succeeded` through `refundEvent`, release on `failed`, and are reconciled after a lost response; the equality gains `+ Q` | §3.6 worked example and test list (two distinct refunds with replays, apply/unapply after a shortfall, pending → succeeded and pending → failed with replays, lost response); matrix rows 23, 35 and 37 |
| R4 | Offline uploads could precede the draft; the original technician had no path to the conflict queue; a 409 acknowledgement would be stranded by the retry classifier | §8.5: draft-first ordering with `record_not_synced` as a defensive retry; signature identity; append-only `job_assignments` provenance (same organization and user only, 403 otherwise); **202 `held_for_review`** acknowledged as success; drafts move to the conflict when the office reassigns, cancels or completes the job | §8.5 R4 tests 1–9 (before the first draft sync and before the first upload, each with photos and a signature); matrix rows 26, 33 and 34 |
| R5 | Disposal loads lacked attachments, revision identity and a canonical unit | §1.2 `work_attachments` with exactly one owner, including `disposal_load_group_id`. §2.2: revision groups (`group_id`, `revision`, `is_current`), `disposal_load_items` keyed by pump-out group, entered value and unit kept, canonical `volume_milligallons` from the exact US gallon (3.785411784 L) | §2.5 acceptance list; matrix row 36 |

This was the last design pass on the plan. Nothing in it starts implementation.
