# Jurisdiction Adapter Template

## Identity

- key:
- state:
- authority:
- effective date:
- source links:

## Applicability

Which systems/properties does this ruleset apply to?

## Service frequency

## Filing deadline

## Required inspection fields

## Required attachments/photos

## Required report/form

## Submission method

- email
- portal
- API
- batch
- manual

## Destination / portal

## Customer copy requirement

## Confirmation / proof

## Contract requirements

## Exceptions

## Test fixtures

- valid inspection
- missing required field
- rejected submission
- deadline calculation

## Verification

Draft until someone confirms the requirements with the authority itself. To verify, add a new ruleset version with `profile.status: "verified"`, no `unresolved` items, and `profile.verification`: who at the authority confirmed it (`confirmedWith`), who asked (`confirmedBy`), `confirmedOn`, `method` (email, phone, meeting or letter) and where the evidence is kept (`evidence`). Only Justin marks a ruleset verified (PILOT-BUILD-BRIEF.md). Record the confirmation here too.
