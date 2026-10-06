# Travis County TNR, On-Site Sewage Facilities (`tx-travis-county`): draft profile

Status: **draft**. Written 2026-10-06 from Travis County's code and pages. Travis County publishes no way to submit maintenance reports, so Travis inspection filings are held for review and never sent. Contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Travis County TNR can answer them: 512-854-4215, or its contact form.

1. **Where do maintenance providers send inspection reports and contracts?** No email, portal or mailing address for them is published. This is the blocker: once the county names a channel, a v2 ruleset can send them.
2. **Does the county want unauthorized alterations and the provider's emergency phone on each report?** Chapter 448.034(e) says so, and Aerowise's report has neither field yet. Should they be added to the form?
3. **Is there an acknowledgment?** None is published.

## Identity

- key: `tx-travis-county`, ruleset v1
- state: TX
- authority: Travis County Transportation and Natural Resources (TNR), On-Site Sewage Facilities
- requirement in effect: Travis County Code Chapter 448 as amended 2023-11-28, effective 2024-07-16. It was first adopted 2014-12-30, effective 2015-02-23. Aerowise applies v1 from 2024-07-16.
- source links (all read 2026-10-06):
  - Chapter 448: https://www.traviscountytx.gov/images/commissioners_court/Doc/county-code/subtitle19/Ch448_Rules_On-Site_Sewage_Facilities.pdf (read through a page summarizer)
  - Affidavit to the public for OSSFs requiring maintenance: https://www.traviscountytx.gov/images/tnr/Docs/SP-04.pdf
  - Permit enforcement page: https://www.traviscountytx.gov/tnr/development-services/permitting-center/permit-enforcement
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Chapter 448.005 covers unincorporated Travis County, plus Webberville, Manor, Mustang Ridge, San Leanna and the part of Leander in Travis County. It excludes areas under another local entity's order and areas the City of Austin annexed for the limited purpose of public health. LCRA permits OSSFs within 1,000 feet of Lake Travis (TNR's enforcement page).

`assignment: "reviewed"`: a Travis site is offered both LCRA and Travis County, and the office picks one with evidence. Check LCRA's map first, then city limits.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). The county adds nothing.

## Lab tests

None published.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

- The spray area's condition (`dispersal_field`), from 448.034(e)(2).
- Also required by 448.034(e), but not checked by Aerowise: unauthorized alterations and the provider's emergency phone (question 2). The report already shows the permit number, the provider's name and signature, the OSSF's address, and the provider's address and phone.

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

The owner gives the permitting authority a copy of the signed contract 30 days before the service policy or current contract expires (30 TAC 285.7(d)(2)). Aerowise files it by hand. Chapter 448.034(f) lists what a contract shows. A single-family owner who maintains their own system must produce a contract within ten days of the county's notice (448.034(d)).

## Exceptions

Homeowners who maintain their own system (448.034(b)–(c)) file their own reports.

## Test fixtures

`apps/api/test/travis.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing spray-area answer, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Travis site offered both LCRA and Travis County, never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county names its submission channel.
