# Hill County Development Services, OSSF (`tx-hill-county`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-hill-county.md` (Central Texas research thread). Hill County moved its OSSF program from the Sheriff's Office Environmental Compliance Unit to Development Services on 2026-01-01. No way to submit maintenance reports or contracts is published, so Hill inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. The OSSF Designated Representative can answer them: 254-283-6846. Development Services is at 254-337-1210.

1. **Where and how must aerobic maintenance reports be submitted?** Is ksmith@co.hill.tx.us an approved channel? This is the blocker for sending.
2. **Where are contracts and renewals filed now, how many days before expiry, and does the 30-days-after-transfer rule still apply?**
3. **Which Hill County OSSF order is in effect, and does it change TCEQ's schedule or deadline, or allow 6 months with monitoring?**
4. **Does any city, or any agency such as BRA or USACE around Lake Whitney or Lake Aquilla, run its own OSSF program?**
5. **Are there fees for filing reports or contracts, or late fees? Does the county acknowledge receipt?**
6. **Are there commercial or RV-park intervals or lab tests beyond TCEQ's?**
7. **Is homeowner self-maintenance allowed, and what must a homeowner file?**

## Evidence gaps and conflicts

- The current Development Services page was read directly. The 2026 permit application has a poor text layer and was read through a page summarizer, and no maintenance text was found in it.
- The contract-on-transfer rule comes from a legacy affidavit that sent contracts to the Sheriff's Office unit, which no longer runs the program. Whether it still applies is unknown (question 2).
- The December 2025 Commissioners Court minutes, which may hold the transfer and any new order, are scans with no text.
- Legacy pages and forms (newtools.cira.state.tx.us: 406 Hall St, 254-582-5313 x414, $325/$475 fees) are superseded by the 2026 page ($600 permit fee, 218 N Waco St). Only current contacts are used.
- The designated representative's email is published as a general contact, not as a report channel, so it isn't used.

## Identity

- key: `tx-hill-county`, ruleset v1
- state: TX
- authority: Hill County Development Services, On-Site Sewage Facilities
- requirement in effect: unknown (question 3), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Hill inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - OSSF Permits & 911 Signage: https://www.co.hill.tx.us/page/hill.OSSFPermits-911Signage
  - OSSF Permit Application (2026): https://www.co.hill.tx.us/upload/page/7634/docs/2026/OSSF%20Application.pdf
  - Affidavit to the Public (legacy): https://newtools.cira.state.tx.us/upload/page/7608/docs/ossfaffidavit.pdf
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Development Services runs OSSF permits in Hill County. Excluded cities aren't published (question 4). `assignment: "reviewed"`: the office checks with Development Services and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). See question 3.

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

None published. The govpay link on the county page is for permit payments.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

Aerobic systems need "a continuous maintenance contract" (legacy affidavit). Renewal timing comes from 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand (question 2).

## Exceptions

None published locally (question 7). Commercial and RV-park permits also need TCEQ approval.

## Test fixtures

`apps/api/test/hill.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Hill site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county names its submission channel and its order is found.
