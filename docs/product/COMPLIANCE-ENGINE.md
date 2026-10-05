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

A filing's next due date uses the same interval, taking the type from the site's contract in force on the inspection date (residential when there is none).

Published versions never change, so an authority that changes its interval gets a new ruleset version with a new `effectiveFrom`; contracts already made keep their visits.

Fixture tests: `apps/api/test/intervals.test.ts`, with fictional quarterly and commercial-monthly rulesets in `apps/api/test/fixtures/rulesets/`.

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
