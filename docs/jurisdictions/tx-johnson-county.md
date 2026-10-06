# Johnson County Public Works, OSSF (`tx-johnson-county`): draft profile

Status: **draft**. Written 2026-10-06 from Johnson County's Public Works and Development Services pages and TCEQ's rules. Johnson County publishes no way to submit maintenance reports, so Johnson inspection filings are held for review and never sent. Contracts are filed by hand. The county's OSSF rules are listed by name, but the document could not be found or read.

## Questions for Justin

Each of these is open in `profile.unresolved`. Johnson County Public Works can answer them: (817) 556-6380.

1. **Where do maintenance providers send inspection reports and contracts?** No email, portal or mailing address for them is published. This is the blocker: once the county names a channel, a v2 ruleset can send them.
2. **What do the Rules of Johnson County for On-Site Sewage Facilities add?** A readable copy settles the schedule, deadline, report contents, lab tests, fees and dates. Until then Aerowise follows TCEQ: every 4 months (6 with monitoring), reports within 14 days.
3. **Which cities run their own OSSF program?** None is named, so every Johnson site needs a person to check it.

## Identity

- key: `tx-johnson-county`, ruleset v1
- state: TX
- authority: Johnson County Public Works, On-Site Sewage Facilities (TCEQ's designated representative)
- requirement in effect: unknown (question 2), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Johnson inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - Public Works: https://johnsoncountytx.org/departments/public-works
  - Development Services permit applications and information: https://www.johnsoncountytx.org/departments/development-services/permit-applications-and-information
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Public Works issues OSSF permits as TCEQ's designated representative. Its coverage area is not published (question 3). `assignment: "reviewed"`: the office checks that Public Works holds the site's permit and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)).

## Lab tests

None in the readable sources.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual).

## Required attachments/photos

None beyond the template's.

## Required report/form

No county form is published.

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None published.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

30 days before the service policy or current contract expires (30 TAC 285.7(d)(2)). Aerowise files it by hand. No fees are set.

## Exceptions

None published beyond TCEQ's: a single-family owner may maintain their own system.

## Test fixtures

`apps/api/test/johnson.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Johnson site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county names its submission channel and its rules are read.
