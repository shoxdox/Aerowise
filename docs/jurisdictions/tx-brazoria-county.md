# Brazoria County Environmental Health, OSSF (`tx-brazoria-county`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-brazoria-county.md` (Southeast Texas research thread). Most county pages (contacts, fees, regulations) returned 403. No confirmed way to submit maintenance reports was read, so Brazoria inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Brazoria County Environmental Health can answer them. Its phone couldn't be read; get it from https://www.brazoriacountytx.gov/departments/environmental-health/contact-us in a normal browser.

1. **What are the department's phone number and its address or email for OSSF maintenance?**
2. **Where do providers send aerobic maintenance reports: ehmaintenance@brazoriacountytx.gov, a portal, mail or in person? Is email an approved channel for reports and for contract renewals?** This is the blocker for sending.
3. **Is there a county report form, or fields beyond TCEQ's?**
4. **Is the report deadline TCEQ's 14 days, or shorter?**
5. **Which county OSSF order is in effect (number, adoption date, TCEQ approval), and is a readable copy online?**
6. **Is it every 4 months, with 6 allowed for monitored systems? Is there a commercial schedule or BOD/TSS testing?**
7. **When are renewals due, and what happens on a transfer?**
8. **Are there fees or late fees for reports or contracts?**
9. **How does a maintenance provider register with the county, and is there a fee?**
10. **Does the county acknowledge reports or contracts?**
11. **What does homeowner self-maintenance require, and must a self-maintaining homeowner still file reports?**
12. **Which cities run their own program or defer to TCEQ (Manvel, Brookside Village, Surfside Beach, Pearland, Alvin, Angleton, Lake Jackson and others), and does the county cover city ETJs?**

## Evidence gaps and conflicts

- **ehmaintenance@brazoriacountytx.gov is not used.** It was named in an earlier review, but the only page said to carry it (Contact Us) returned 403 on every attempt, and a search found it on no official page. Even if it's there, it may be a contact inbox rather than an approved report channel (question 2). `inspectionReports.submission` stays `unknown`.
- Returned 403 (one retry each): the Environmental Health home page, Contact Us, Permit Fees, Regulations, Links, Department Directory and every county PDF tried, including the OSSF brochure. TCEQ's authorized-agent search timed out.
- "Initial submissions will not be accepted via email" covers permit applications only. It neither allows nor forbids emailed maintenance reports.
- The list of authorized agents inside the county comes from TCEQ's 2023 and 2024 permit reports, which only list agents that issued permits that year. Pearland's procedure is undated (around 2018).
- Fees, the county order, the commercial schedule, lab tests, the report form and acknowledgment are unread, not "none".

## Identity

- key: `tx-brazoria-county`, ruleset v1
- state: TX
- authority: Brazoria County Environmental Health Department, On-Site Sewage Facilities (TCEQ authorized agent 620020)
- requirement in effect: unknown (question 5), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Brazoria inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - OSSF Permitting Process: https://www.brazoriacountytx.gov/departments/environmental-health/forms-permit-applications/ossf-permitting-process
  - Forms & Permit Applications: https://www.brazoriacountytx.gov/departments/environmental-health/forms-permit-applications
  - Contact Us (not readable, 403): https://www.brazoriacountytx.gov/departments/environmental-health/contact-us
  - TCEQ 2024 authorized-agent permit report: https://www.tceq.texas.gov/downloads/permitting/ossf/reporting-system/2024-aa-atcs.pdf
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Brazoria County is TCEQ authorized agent 620020. Brookside Village, Manvel and Surfside Beach are separate authorized agents, and Pearland sends OSSF applications to TCEQ Region 12. `assignment: "reviewed"`: the office checks the site's city and confirms with the county.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). See question 6.

## Lab tests

None in the readable sources.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before. See question 4.

## Required inspection fields

None beyond the template's own (which include the chlorine residual).

## Required attachments/photos

None published.

## Required report/form

None found (question 3).

## Submission method

Manual. No confirmed channel (question 2), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None confirmed.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

A maintenance contract comes with the permit application where required. Renewal timing comes from 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand (question 7).

## Exceptions

No permit is needed for a single-family OSSF on a single tract of ten acres or more that meets the setbacks. The homeowner-maintenance training forms are listed but weren't read (question 11). Maintenance providers must be registered with the county (question 9).

## Test fixtures

`apps/api/test/brazoria.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Brazoria site never matched by county alone
- the unconfirmed ehmaintenance address never used as a channel

## Verification

Draft. To verify, follow TEMPLATE.md once the county's pages are read and it names its submission channel.
