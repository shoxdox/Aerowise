# DOMAIN-MODEL.md

## Core model

Organization
  -> Membership/User
  -> Customer
     -> Contact
     -> Site
        -> WastewaterSystem
           -> Equipment
        -> Contract
           -> ContractLine/AddOn
           -> ServiceObligation
              -> Job
                 -> Inspection
                    -> InspectionValue
                    -> Attachment
                    -> Issue
              -> Filing
                 -> FilingAttempt
        -> Invoice
           -> InvoiceLine
           -> Payment
        -> ComplianceEvent
        -> Exception

## Core tables

### organizations
- id
- name
- phone
- email
- address
- timezone
- logo_url
- created_at

### users
- id
- name
- email
- phone
- auth identity
- active

### memberships
- organization_id
- user_id
- role
- technician_license
- permissions

### customers
- id
- organization_id
- display_name
- billing address
- status
- source
- tags

### contacts
- id
- organization_id
- customer_id
- site_id nullable
- name
- email
- phone
- type
- communication consent

### sites
- id
- organization_id
- customer_id
- service address
- lat/lng
- jurisdiction_id
- permit_number
- access notes
- gate code
- safety flags
- active

### wastewater_systems
- id
- site_id
- manufacturer
- model
- serial
- installed_at
- system_type
- treatment_type
- disposal_type
- chlorination_method
- notes

### equipment
- id
- wastewater_system_id
- type
- manufacturer
- model
- serial
- installed_at
- status

### plans
- id
- organization_id
- name
- term_months
- price
- billing_frequency
- service template references
- contract template
- active

### contracts
- id
- organization_id
- site_id
- plan_id
- start_at
- end_at
- renewal_at
- status
- price
- auto_renew
- signed_document_id
- payment policy

### service_obligations
- id
- organization_id
- contract_id
- site_id
- service_type
- interval_unit
- interval_value
- visits_required
- last_completed_at
- next_due_at
- scheduling_window_start
- scheduling_window_end
- jurisdiction_ruleset_id

### jobs
- id
- organization_id
- site_id
- obligation_id nullable
- type
- status
- scheduled_start
- scheduled_end
- technician_id
- route_id
- priority
- notes

### inspections
- id
- organization_id
- job_id
- site_id
- wastewater_system_id
- template_version_id
- status
- started_at
- completed_at
- arrival_lat/lng
- completion_lat/lng
- technician_id
- notes
- validation_status
- offline_client_id

### inspection_values
- inspection_id
- field_key
- value_json
- source
- entered_at

### attachments
- id
- organization_id
- site_id
- inspection_id nullable
- job_id nullable
- type
- storage_key
- captured_at
- lat/lng
- immutable_after_filing boolean

### issues
- id
- inspection_id
- type
- severity
- description
- status
- followup_job_id nullable

### jurisdictions
- id
- key
- state
- authority_name
- type
- active

### jurisdiction_rulesets
- id
- jurisdiction_id
- version
- effective_from
- effective_to
- rules_json
- source_reference
- status

### filings
- id
- organization_id
- inspection_id
- jurisdiction_id
- ruleset_id
- deadline_at
- status
- submission_method
- artifact_id
- sent_at
- confirmed_at
- confirmation_reference
- exception_id

### filing_attempts
- filing_id
- attempt_no
- method
- started_at
- finished_at
- status
- response_metadata
- error

### compliance_events
- id
- organization_id
- site_id
- contract_id nullable
- inspection_id nullable
- filing_id nullable
- event_type
- occurred_at
- actor
- metadata_json

### exceptions
- id
- organization_id
- site_id
- entity_type
- entity_id
- category
- severity
- status
- due_at
- message
- resolution

### invoices / invoice_lines / payments
Keep conventional SMB structure.
Do not build a general ledger.

## Rules

- every tenant-owned row contains `organization_id` directly or through an enforced parent
- no giant "everything" tables
- jurisdiction variability goes into versioned rules/templates
- filed artifacts become immutable
- audit events are append-only
