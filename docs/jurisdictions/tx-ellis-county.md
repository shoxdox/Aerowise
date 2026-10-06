# Ellis County Department of Development, OSSF (`tx-ellis-county`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-ellis-county.md` (North Texas research thread). It draws on the Department of Development's site (ellispermits.com) and TCEQ's rules. Ellis County publishes no way to submit maintenance reports, so Ellis inspection filings are held for review and never sent, and contracts are filed by hand. The county's Septic Regulations and fee schedule are on elliscountytx.gov, which timed out on 2026-10-06, so they were not read.

## Questions for Justin

Each of these is open in `profile.unresolved`. The Ellis County Department of Development can answer them: 972-825-5200.

1. **Where should providers send aerobic inspection reports, and in what form?** No channel is published. The department's general email (dod@elliscountytx.gov) is not stated as one. This is the blocker for sending.
2. **Where are contracts and renewals submitted, how many days before expiry, and may the provider submit them?** The FAQ says the homeowner makes sure they reach the department.
3. **Do the Septic Regulations change TCEQ's schedule (every 4 months, 6 with monitoring) or the 14-day deadline?** They could not be read.
4. **Are there fees for filing reports or contracts, or late fees?** The Master Fee Schedule (effective 2023-09-01) could not be read.
5. **Which cities run their own OSSF program?**
6. **Is there a county form or field list for maintenance reports?**
7. **What are the current regulations' order number and adoption date?**

## Identity

- key: `tx-ellis-county`, ruleset v1
- state: TX
- authority: Ellis County Department of Development, On-Site Sewage Facilities
- requirement in effect: unknown (question 7), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Ellis inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - Permits: https://www.ellispermits.com/permits
  - Links & FAQs: https://www.ellispermits.com/faq
  - Contact: https://www.ellispermits.com/contact
  - Septic Regulations (not readable, host timed out): https://elliscountytx.gov/DocumentCenter/View/6592/
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

The Department of Development issues OSSF permits. Which cities are excluded is not published (question 5). `assignment: "reviewed"`: the office checks with the department and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). See question 3.

## Lab tests

None in the readable sources.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual).

## Required attachments/photos

None beyond the template's.

## Required report/form

None published (question 6).

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None published.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published. The county mails lapse letters to homeowners when a contract lapses (FAQ Q7).

## Contract requirements

Contracts go to the Department of Development (FAQ Q7), and an initial maintenance contract comes with an aerobic permit application. Timing is from 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand. No fees are set (question 4).

## Exceptions

None published beyond TCEQ's rule that a single-family owner may maintain their own system. The OSSF Affidavit to the Public is filed with the County Clerk and is not a maintenance filing.

## Test fixtures

`apps/api/test/ellis.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- an Ellis site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the regulations are read and the county names its submission channel.
