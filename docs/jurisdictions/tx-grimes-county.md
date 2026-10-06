# Grimes County Environmental Permits, OSSF (`tx-grimes-county`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-grimes-county.md` (Southeast Texas research thread). The county's main OSSF page and its OSSF order could not be read. No way to submit maintenance reports is published, so Grimes inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Grimes County Environmental Permits can answer them: (936) 873-4495 (Mon-Thu 7:30-4:30, Fri 7:30-11:30).

1. **How should providers submit aerobic inspection reports: email (which address), portal, mail to 270 FM 149 W, or in person?** This is the blocker for sending.
2. **What are the title, adoption date and TCEQ approval date of the current OSSF order (reportedly updated 2023-08-16), and can the county send a readable copy?**
3. **How often must residential and commercial aerobic systems be inspected, and does monitoring allow 6 months?**
4. **What is the report deadline?**
5. **Is there a county report form or extra fields?**
6. **Do any systems need lab tests, and at what limits?**
7. **May single-family owners maintain their own systems, and what makes a maintenance company "approved"?**
8. **How and when are renewal contracts filed?**
9. **Are there fees for reports or contracts, or late fees?**
10. **Does the county acknowledge reports or contracts?**
11. **Which cities run their own program or need their own filings, like Todd Mission's city septic permit? For Todd Mission sites, do reports go to the county, the city or both?**
12. **Does any river authority have OSSF jurisdiction in Grimes County?**

## Evidence gaps and conflicts

- The county's robots.txt blocks automated fetching of its `index.asp` pages, including the main OSSF page ("TCEQ On-Site Sewage Facilities - Environmental Services"), and later in the session several PDFs as well. curl is refused by the proxy. A person should open that page in a browser first.
- Not read: the OSSF order, the commercial application, the Infrastructure Regulations, the "Septic Permit Fees" document, the Commissioners Court minutes of July 5, 2023, and TCEQ's authorized-agent search.
- Every county PDF was read through a page summarizer. The affidavit's sentence on contract renewals came back incomplete.
- Only a local newspaper reports that the order was updated on 2023-08-16 and that the update changed aerobic reporting. That's not an official source. It's used only to ask the county for the order (question 2).
- The affidavit's "approved maintenance company" may mean the county doesn't allow homeowner self-maintenance, which TCEQ otherwise allows for single-family homes. That's unconfirmed (question 7).

## Identity

- key: `tx-grimes-county`, ruleset v1
- state: TX
- authority: Grimes County Environmental Permits, On-Site Sewage Facilities
- requirement in effect: unknown (question 2), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Grimes inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - Environmental Permits: https://grimescountytexas.gov/permits
  - TCEQ On-Site Sewage Facilities page (not readable): https://grimescountytexas.gov/index.asp?DE=DE2DB1C7-211D-4F70-A422-2891027B6ED5&SEC=51D0BA70-3EF0-4E47-86C8-5613AD1C8E1A
  - Affidavit to the Public (2024): https://grimescountytexas.gov/vertical/sites/%7B958238D0-27E6-4F6C-919E-F1D98542C5FD%7D/uploads/OSSF_Affidavit_(2024).pdf
  - Seven Steps to Obtaining a Permit: https://grimescountytexas.gov/vertical/sites/%7B958238D0-27E6-4F6C-919E-F1D98542C5FD%7D/uploads/Seven_Steps_to_Obtaining_a_Permit.pdf
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Grimes County Environmental Permits issues OSSF permits countywide. Todd Mission also requires its own city septic permit after the county's. Other cities and river authorities aren't published (questions 11 and 12). `assignment: "reviewed"`: the office checks with the county and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). See question 3.

## Lab tests

None in the readable sources.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before. See question 4.

## Required inspection fields

None beyond the template's own (which include the chlorine residual).

## Required attachments/photos

None published.

## Required report/form

None published (question 5).

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None published.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

"This OSSF must be covered by a continuous maintenance contract", and a signed contract goes to Grimes County within 30 days after a property transfer (2024 affidavit). Renewal timing comes from 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand (question 8).

## Exceptions

None published (question 7).

## Test fixtures

`apps/api/test/grimes.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Grimes site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county's OSSF page and order are read and it names its submission channel.
