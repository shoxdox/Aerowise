# COMPLIANCE-ENGINE.md

## Goal

Convert a completed canonical inspection into the correct jurisdiction-specific compliance outcome.

## Components

### Jurisdiction resolver

Input:
- site address
- county
- permit metadata
- authority override

Output:
- jurisdiction key
- active ruleset version

### Ruleset

Defines:
- service/inspection frequency
- required fields
- required photos
- required lab values
- filing deadline
- report template
- submission method
- destination
- customer-copy rules
- contract/renewal rules
- confirmation behavior

### Service intervals

`service.intervalMonths` in a ruleset is the longest the authority allows between inspections: 4 for the TCEQ default, 3 for quarterly. `service.commercialIntervalMonths`, when set, is a shorter maximum for commercial systems (1 for monthly). A ruleset without it uses `intervalMonths` for every system.

A contract is residential or commercial, copied from its plan (`customerType`) like its term and visits, and kept on renewal.

When a contract is created (from the office, an import or a renewal), Aerowise resolves the site's authority under the rules in force on the contract's start date and takes the interval for the contract's type. If the plan's visit windows would be longer than that, the contract gets the fewest extra visits that split the term into equal whole-month windows within it. A 12-month plan with 3 visits stays at 3 under a 4-month rule, becomes 4 under a quarterly rule and 12 under a monthly one. Visits are only ever added; the price stays the plan's. A site with no resolved authority keeps its plan's visits. A renewal offer shows the visits the new contract will get.

`service.monitored`, when set, is a longer maximum (6 months) for systems with qualifying electronic monitoring, for the system types it names (`appliesTo`). The office records monitoring on a system: the kind (autodialer, remote telemetry, other), the device or service, who it notifies automatically and how, when it started and when someone checked that it works. Ending it records the date and reason. Monitoring counts on a date when it had been checked by then and had not ended. Without it, or where the ruleset does not allow the longer interval, the usual interval applies: a plan with two visits a year gets three under a 4-month rule.

A filing's next due date uses the same interval, taking the type from the site's contract in force on the inspection date (residential when there is none) and monitoring as it stood that day.

Published versions never change, so an authority that changes its interval gets a new ruleset version with a new `effectiveFrom`; contracts already made keep their visits.

Fixture tests: `apps/api/test/intervals.test.ts` and `apps/api/test/monitoring.test.ts`, with fictional quarterly, commercial-monthly and monitored rulesets in `apps/api/test/fixtures/rulesets/`.

### Lab tests

A ruleset can require lab tests on a schedule with `labTests`: the analytes (`bod`, `tss`), `everyMonths` (12 for annual) and `appliesTo` (residential, commercial or both). A ruleset without it requires none.

The office records each result from the lab's report on the site page: sample date, lab, the lab's report or sample number, and a value in mg/L for each analyte. Every analyte the authority requires must have a result. A record is never changed. A mistake is fixed by recording a correction that replaces the record, and only the correction counts.

A site has a lab test requirement while it has a contract in force and its authority's rules apply to that contract's type. The next test is due `everyMonths` after the latest sample. With none on record, it counts from the later of the site's first contract and the date the authority's rules took effect, so renewing a contract does not restart the clock. The site page shows "due soon" 30 days ahead. A late test is a high-severity inbox item until a result is recorded.

Fixture tests: `apps/api/test/lab-tests.test.ts`, with a fictional annual BOD/TSS ruleset in `apps/api/test/fixtures/rulesets/`.

### Report layout and fees

A ruleset can lay out its own copy of the inspection report with `report`: a title, the form it follows (`formReference`), and sections, each listing template field keys in order with an optional label in the authority's wording. The authority copy then shows only those answers, in that order. A listed answer the inspection never asked for (a chlorine reading with no chlorinator) or an optional one left blank is left off. The customer copy is unaffected. The layout comes from the ruleset version the inspection's filing recorded, so corrected versions keep it. A bundled ruleset whose layout leaves off a field it requires is refused. Without `report`, the authority copy uses the template's sections as before.

A ruleset can set fees with `fees`: for `inspectionReport` and `contract` filings, a filing fee and a late fee in cents, with the `basis` they come from. A filing records them when it opens (or is checked again), so a later fee schedule never changes what an earlier filing owed. The late fee is decided the first time the filing reaches the authority, by email or by hand, on the organization's date: after the deadline day it is owed, otherwise it is 0. Sending again after a rejection does not decide it again. The filing page shows the fees and the timeline says when a late fee applied. Aerowise records fees; it does not pay or invoice them.

Fixture tests: `apps/api/test/report-templates.test.ts`, with a fictional ruleset that has a report layout and fees in `apps/api/test/fixtures/rulesets/`.

### Validation

Inspection cannot reach `COMPLETE_VALID` until required inputs are present.

Override:
- supervisor only
- reason required
- logged permanently

### Filing state machine

`PENDING`
-> `READY`
-> `QUEUED`
-> `SUBMITTING`
-> `SENT`
-> `CONFIRMED`

Failure branches:
- `FAILED`
- `REJECTED`
- `NEEDS_REVIEW`

Retries must be idempotent.

### Submission methods

Support adapters for:
- email
- file export/manual portal
- API
- batch upload
- other officially-supported mechanisms

Do not automate browser portals unless permission and reliability are explicitly confirmed.

### Proof

Possible evidence:
- provider email message ID
- delivery confirmation
- API acknowledgement
- portal confirmation number
- uploaded receipt
- manual verification

The product should distinguish:
- GENERATED
- SENT
- CONFIRMED

Never collapse these concepts.

## Adapter interface

```ts
interface JurisdictionAdapter {
  key: string;
  version: string;

  resolveRequirements(ctx: SiteContext): Promise<Requirements>;
  validate(inspection: CanonicalInspection): Promise<ValidationResult>;
  render(inspection: CanonicalInspection): Promise<Artifact[]>;
  buildSubmission(inspection: CanonicalInspection, artifacts: Artifact[]): Promise<SubmissionPackage>;
  submit?(pkg: SubmissionPackage): Promise<SubmissionResult>;
  verify?(submission: SubmissionResult): Promise<VerificationResult>;
}
```

## Versioning

Rules/forms change.

Each filing must retain:
- jurisdiction key
- ruleset version
- template version
- submission method version

Historical records must remain reproducible.
