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
