# City of Denton Environmental Services, OSSF (`tx-city-of-denton`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-city-of-denton.md` (North Texas research thread). The city publishes its OSSF permit procedures and fees but nothing on maintenance reports. Its OSSF ordinance could not be read. City of Denton inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. City of Denton Environmental Services can answer them: (940) 349-8619.

1. **Where should providers send aerobic inspection reports, and is there a city form?** No channel is published. This is the blocker for sending.
2. **How and when are contract renewals filed, and may the provider file them?**
3. **Does the city cover only its limits, or also its ETJ?**
4. **Does Code Ch. 26 Art. IX change TCEQ's schedule (every 4 months, 6 with monitoring) or the 14-day deadline, or add lab tests or report fields?**
5. **Are there fees for filing reports or contracts, or late fees?**
6. **Who is the current OSSF designated representative, and what is their email?**

## Evidence gaps and conflicts

- The ordinance (Code of Ordinances Ch. 26, Art. IX, on Municode) renders by script and returned no text, so it was not read. An unofficial mirror timed out and wouldn't count anyway.
- Both permit outlines were read through a page summarizer. The city-site version is undated and lists (940) 349-8619 with no named contact. The 2019 version names Stewart White, (940) 349-8623. The undated one is treated as current.
- The outline requires an initial contract of at least two years. TCEQ's 30 TAC 285.7 doesn't set that minimum, so this is the city's own rule. Aerowise doesn't check contract length.

## Identity

- key: `tx-city-of-denton`, ruleset v1
- state: TX
- authority: City of Denton Environmental Services, On-Site Sewage Facilities
- requirement in effect: unknown (question 4), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. City of Denton inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - On-Site Sewage Facility: https://www.cityofdenton.com/664/On-Site-Sewage-Facility
  - Permit procedures outline (undated): https://www.cityofdenton.com/DocumentCenter/View/3672/Outline-of-City-of-Denton-On-Site-Sewage-Facility-Permit-Procedures-PDF
  - Permit procedures outline (2019): https://lfpubweb.cityofdenton.com/publicweblink/4/edoc/42522/OUTLINE-OF-CITY-OF-DENTON-OSSF-PERMIT_-PROCEDURES_2019.pdf
  - Code Ch. 26 Art. IX (not readable): https://library.municode.com/tx/denton/codes/code_of_ordinances?nodeId=SPACOOR_CH26UT
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

The city permits OSSFs in Denton as TCEQ's designated representative. Whether that includes its ETJ is not published (question 3). Denton County covers the unincorporated county (`tx-denton-county`). `assignment: "reviewed"`: the office checks city limits and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). See question 4.

## Lab tests

None published.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual).

## Required attachments/photos

None published.

## Required report/form

None published (question 1).

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None published.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

A maintenance contract is required for aerobic systems, initially for at least two years. No renewal channel or timing is published. Timing comes from 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand.

## Exceptions

None published.

## Test fixtures

`apps/api/test/denton.test.ts` covers these cases:
- a valid City of Denton inspection: due 14 days later, next visit in 4 months, held for review and never sent
- the 6-month schedule with monitoring on record
- a Denton site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the ordinance is read and the city names its submission channel.
