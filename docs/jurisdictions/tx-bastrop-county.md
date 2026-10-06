# Bastrop County Development Services, OSSF (`tx-bastrop-county`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-bastrop-county.md` (Central Texas research thread). The county's OSSF Order is an unreadable scan. No way to submit maintenance reports is published, so Bastrop inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Bastrop County Development Services can answer them: (512) 581-7176.

1. **Where and how must providers submit the 4-month aerobic reports, and is there a county form?** MyGovernmentOnline takes permit applications; nothing says it takes reports. This is the blocker for sending.
2. **What is the $20 "OSSF Renewal Fee" for, when must a renewal contract be filed, and when does the $100 Maintenance Contract Late Fee apply?**
3. **What are the order's number, adoption date and TCEQ approval date, and does it add lab tests or a commercial interval?**
4. **Does electronic monitoring allow 6 months between visits?**
5. **Must self-maintaining homeowners submit reports, and what training is approved?**
6. **Does the county permit inside the City of Bastrop, Elgin or Smithville, or does each city run its own program?**
7. **On a sale, must the new owner file a new contract, and by when?**

## Evidence gaps and conflicts

- The OSSF Order (TCEQAppdOSSFOrder.pdf) is a scan with no text layer, and direct download is blocked from the research session. Every order-level rule is unknown.
- The county pages and PDFs were read through a page summarizer, and the profile relies only on what they don't say. The two published fees ($100 late fee, $20 renewal fee) are listed without saying what they cover, so they aren't recorded on filings.
- The fee page shows "Effective Date: 09/28/2026", which may be a new schedule.
- The City of Bastrop publishes its own OSSF checklist, but whether it is a TCEQ authorized agent, and over what area, is not stated.
- LCRA's published OSSF zones (around the upper Highland Lakes and Lake Travis) don't reach Bastrop County, so the LCRA profile doesn't list it.

## Identity

- key: `tx-bastrop-county`, ruleset v1
- state: TX
- authority: Bastrop County Development Services, Environmental & Sanitation, On-Site Sewage Facilities
- requirement in effect: unknown (question 3), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Bastrop inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - On-Site Sewage Facilities: https://www.bastropcounty.gov/page/ds.ossf
  - OSSF Order (not readable, scan): https://www.bastropcounty.gov/upload/page/0148/docs/TCEQAppdOSSFOrder.pdf
  - Application Fees: https://www.bastropcounty.gov/page/ds.fees
  - Affidavit for Aerobic OSSF Systems (2019-02-12): https://www.bastropcounty.gov/upload/shared/DevServices/2019.02.12%20Affidavit%20-%20Aerobic%20OSSFs.pdf
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Bastrop County Development Services permits OSSFs in the county. City exclusions aren't published (question 6). `assignment: "reviewed"`: the office checks city limits and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). See question 4.

## Lab tests

None in the readable sources.

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

None published for maintenance reports.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

A two-year initial contract comes with the permit application. After that, a single-family owner "shall either obtain a maintenance contract within 30 days or maintain the system personally". Renewal timing comes from 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand (question 2).

## Exceptions

After the initial two years, single-family owners may maintain their own system with county-approved training. Emergency repairs must be reported within 72 hours.

## Test fixtures

`apps/api/test/bastrop.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Bastrop site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the order is read and the county names its submission channel.
