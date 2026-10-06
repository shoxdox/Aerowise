# Denton County Environmental Health, OSSF (`tx-denton-county`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-denton-county.md` (North Texas research thread). It draws on Denton County Public Health's Environmental Health pages, its OSSF sheet, its Testing and Reporting Form and TCEQ's rules. The county's own form says to email completed reports to ossfinspections@dentoncounty.gov, so Denton County inspection reports go there once the office presses Send. Nothing is sent on its own. No contract channel is published, so contract filings are held for review and filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Denton County Environmental Health can answer them: 940-349-2920.

1. **May providers send their own report to ossfinspections@dentoncounty.gov, or must they use the county's Testing and Reporting Form (Rev 3/9/2021)?** The form says to email it there. It doesn't say whether another layout is accepted.
2. **How are contracts and renewals submitted, and may the provider submit them for the owner?** No channel is published, and nothing says the ossfinspections address takes contracts.
3. **Is there a deadline for sending each report?** None is published; Aerowise uses TCEQ's 14 days.
4. **Does the county order allow 6 months with electronic monitoring, or set a commercial schedule?** The form says every 4 months and does not mention monitoring, so Aerowise schedules every 4 months.
5. **Does the county acknowledge emailed reports or contracts?**
6. **Where can we read the current Denton County OSSF order (number and adoption date)?**
7. **Are there filing or late fees for reports or contracts?**

## Evidence gaps and conflicts

- curl to dentoncounty.gov is denied from the research session (403). The three PDFs (the OSSF sheet, the Testing and Reporting Form and the permit packet) were read through a page summarizer that was asked for exact quotes. The email instruction was fetched a second time from the form on 2026-10-06 and came back with the same wording: "After inspection, please mail, fax or email this form to: … Email: ossfinspections@dentoncounty.gov". Nobody has compared it with the PDF in a browser yet. Do that before verifying.
- The Denton County OSSF order is referenced ("per Denton County OSSF order") but not published on the county's Documents page, so it was not read.
- The form is linked as the "Homeowners Inspection Form", but its text covers maintenance companies as well ("If a maintenance company is performing the maintenance test…").
- The county form asks for a CL2 grab result, complaint response dates and lid security in its own layout. Aerowise's report records chlorine residual and complaints but doesn't reproduce the county form.

## Identity

- key: `tx-denton-county`, ruleset v1
- state: TX
- authority: Denton County Public Health, Environmental Health Division, On-Site Sewage Facilities
- requirement in effect: unknown (question 6), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Denton County inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - Environmental Health Division: https://www.dentoncounty.gov/657/Environmental-Health-Division
  - What You Must Know, OSSF (Rev 9/14/20): https://www.dentoncounty.gov/DocumentCenter/View/1441/What-You-Must-Know-PDF
  - Testing and Reporting Form (Rev 3/9/2021): https://www.dentoncounty.gov/DocumentCenter/View/1439/Homeowners-Inspection-Form-PDF
  - Septic Permit Application Packet (Rev 11/26/24): https://www.dentoncounty.gov/DocumentCenter/View/1440/Septic-Permit-Application-Packet-PDF
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)

## Applicability

Unincorporated Denton County only: "throughout the unincorporated portions of Denton County". The City of Denton runs its own program (`tx-city-of-denton`); other cities are not listed. `assignment: "reviewed"`: the office checks city limits and records what it checked. A Denton County site matched by county alone lists both authorities as candidates.

## Service frequency

Every 4 months: "Required frequency of maintenance check and test: Every 4 months" (county form). The form does not mention electronic monitoring, so there is no 6-month schedule here (question 4).

## Lab tests

None published. The form asks only for a chlorine (CL2 grab) result.

## Filing deadline

None published ("After inspection"). Aerowise uses TCEQ's 14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual). See the form layout under evidence gaps.

## Required attachments/photos

None published.

## Required report/form

The county's Testing and Reporting Form (Rev 3/9/2021). Whether another layout is accepted is question 1.

## Submission method

Email to ossfinspections@dentoncounty.gov, subject "OSSF maintenance inspection report, permit {permitNumber}, {address}". The office presses Send on each report (`autoSubmit: false`, draft profile). The form also lists fax (940) 349-2588 and mail to 3900 Morse St, Denton, TX 76208.

## Destination / portal

No portal.

## Customer copy requirement

Required: "One copy shall be sent to the homeowner, and one copy shall be sent to the permitting authority."

## Confirmation / proof

None published (question 5).

## Contract requirements

Owners send a copy of the contract to Environmental Health "at least thirty (30) days prior to expiration of the previous contract". No channel is published, so `contracts.submission` is `unknown`. Contract filings are held for review and never emailed, and the office files them by hand (question 2).

## Exceptions

An owner may maintain the system with "written approval from this department showing approved homeowner training".

## Test fixtures

`apps/api/test/denton.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, ready only after the office presses Send, then emailed to ossfinspections@dentoncounty.gov
- a missing spray-area condition, which keeps the inspection a draft
- 4 months between visits even with monitoring on record
- a Denton site never matched by county alone
- a signed contract held for review, never emailed

## Verification

Draft. To verify, follow TEMPLATE.md once the county answers questions 1 and 2 and someone has read the form PDF directly.
