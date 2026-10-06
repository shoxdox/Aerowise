# Kaufman County Development Services, OSSF (`tx-kaufman-county`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-kaufman-county.md` (North Texas research thread). The County thread re-read three pages that had timed out for the helper: the OSSF page and FAQ answers 169 and 173. Kaufman County publishes no way to submit maintenance reports or contracts, so Kaufman inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Kaufman County Development Services can answer them: (469) 376-4127.

1. **Where should providers send aerobic inspection reports, and is there a county form?** No channel is published. Publicworks@kaufmancounty.net is given for general OSSF questions, not as a report channel. This is the blocker for sending.
2. **How are contract renewals submitted, and may the provider submit them?** The FAQ says they go to Development Services 30 days before the previous contract expires, but names no channel.
3. **Does the county change TCEQ's schedule (every 4 months, 6 with monitoring) or the 14-day deadline?**
4. **Do any cities besides Oak Ridge and Terrell run their own OSSF program?**
5. **Are there fees for filing reports or contracts, or late fees?**
6. **Which county OSSF order is in effect (number and adoption date)?**

## Evidence gaps and conflicts

- kaufmancounty.net timed out on most fetches on 2026-10-06. The permit application (DocumentCenter 4772), the Contact Us and Permits and Inspections pages, and FAQ answers 171 and 172 were not read. No county OSSF order was found.
- The OSSF page and FAQ answers 169 and 173 were read on a second try through a page summarizer. Their quotes haven't been compared with the pages in a browser.
- publicworks@kaufmancounty.net appears twice: for general OSSF questions (FAQ 169) and for emailing the notarized deed-record Certificate of OSSF Requiring Maintenance. Neither makes it a channel for maintenance reports or contracts, so it isn't used.

## Identity

- key: `tx-kaufman-county`, ruleset v1
- state: TX
- authority: Kaufman County Development Services, On-Site Sewage Facilities
- requirement in effect: unknown (question 6), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Kaufman inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - On-Site Sewage Facilities: https://www.kaufmancounty.net/355/On-Site-Sewage-Facilities
  - FAQ 173, maintenance contracts: https://www.kaufmancounty.net/Faq.aspx?QID=173
  - FAQ 169, OSSF in Kaufman County: https://www.kaufmancounty.net/FAQ.aspx?QID=169
  - Certificate of OSSF Requiring Maintenance: https://www.kaufmancounty.net/404/Certificate-of-OSSF-Requiring-Maintenanc
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Kaufman County outside Oak Ridge and Terrell city limits: "those living within Oak Ridge or Terrell city limits should contact those municipalities directly, as they are Authorized Agents" (FAQ 169). Other cities are not mentioned (question 4). `assignment: "reviewed"`: the office checks city limits and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). See question 3.

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

None published.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

"Kaufman County requires a maintenance contract be kept on all aerobic systems. These are usually annual and must be submitted to Development Services 30 days prior to the expiration of previous contract" (FAQ 173). No channel is published, so Aerowise files them by hand.

## Exceptions

None published. The Certificate of OSSF Requiring Maintenance is a one-time deed-record filing with the County Clerk, not a maintenance filing.

## Test fixtures

`apps/api/test/kaufman.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Kaufman site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county names its submission channel and its order is read.
