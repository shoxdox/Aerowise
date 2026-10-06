# Bell County Public Health District, OSSF (`tx-bell-county-phd`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-bell-county.md` (Central Texas research thread). The district's local rules say reports and contracts go to the district, but no way to send them is published. Bell inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. The district's Environmental Health office can answer them: 254-532-9800, 4236 Lowes Dr., Temple, TX 76502.

1. **How should providers submit maintenance reports and contracts?** No channel is published. ossf@bellcountyhealth.org is published only for complaints. This is the blocker for sending.
2. **What is the deadline for each report?** None is published; Aerowise uses TCEQ's 14 days.
3. **How far before expiry must a renewal be filed? Who pays the $20 "Contract Verification" fee per contract year, and how?**
4. **Does the district require residential lab tests, and are there numeric limits for the Rule 8 food-dealer BOD/TSS samples?**
5. **Does electronic monitoring allow 6 months between visits?**
6. **Does the district cover non-member areas (Nolanville, Bell County's part of Bartlett, Fort Cavazos), and does any member city run its own program?**
7. **What are the current rules' order number, adoption date and TCEQ approval date?**
8. **Does the district acknowledge reports or contracts, and is there a report form?**
9. **What is the Rule 10 re-license fee, and is there a late fee?**

## Evidence gaps and conflicts

- curl to the district's hosts is blocked from the research session, so every PDF was read through a page summarizer. The County thread re-read the local rules on 2026-10-06, and Rules 8 and 14 came back with the same wording. Nobody has compared them with the PDF in a browser yet.
- The rules file is named "local order 2018" but says only "ORIGINALLY APPROVED DECEMBER 2006" (Rules 1-13) and September 2007 (homeowner maintenance). It has no order number or TCEQ approval date.
- An older fee sheet (inspectionsandpermits.pdf, $250 to $450) conflicts with the 2024 schedule ($610 and up). It's treated as stale.
- Phone numbers differ across documents: the district now publishes 254-532-9800, older documents list (254) 778-7557, and Harker Heights lists (254) 771-2106.
- No TCEQ authorized-agent list confirming the district's designation was found.

## Identity

- key: `tx-bell-county-phd`, ruleset v1 (`type: "district"`)
- state: TX
- authority: Bell County Public Health District, On-Site Sewage Facilities
- requirement in effect: unknown (question 7), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Bell inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - OSSF page: https://www.bellcountyhealth.org/environmental_health/on-site_sewage_facilities/index.php
  - Additional Rules beyond Chapter 285: https://cms3.revize.com/revize/bellcountyhealthtx/Documents/Environmental%20Health/On%20Site%20Sewage%20Facilities/local%20order%202018.pdf
  - Fee revisions effective 2024-09-01: https://www.bellcountyhealth.org/Documents/Environmental%20Health/On%20Site%20Sewage%20Facilities/OSSF%20Process/Fee%20Revisions%20Sept_1_%202024.pdf
  - Application to construct (2024): https://www.bellcountyhealth.org/Documents/Environmental%20Health/On%20Site%20Sewage%20Facilities/BCPHD_APP_2024_FILLABLE_UPDATED.pdf
  - About Us: https://www.bellcountyhealth.org/about_us/index.php
  - File a Complaint: https://www.bellcountyhealth.org/environmental_health/on-site_sewage_facilities/file_a_complaint.php
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

The district is a joint health district of Bell County, Temple, Killeen, Belton, Harker Heights, Holland, Little River-Academy, Morgan's Point Resort, Rogers, Troy and Salado. Its rules apply to "All secondary treatment systems in Bell County". Coverage of non-member areas is not published (question 6). `assignment: "reviewed"`: the office checks with the district and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). Food-dealer-permit facilities need a visit "a minimum of every three months" (Rule 8). Aerowise can't tell which commercial sites hold a food dealer's permit, so the office schedules those by hand. `commercialIntervalMonths` isn't set, so other commercial sites aren't held to 3 months.

## Lab tests

None for residential systems. Food-dealer-permit facilities need a chlorine or fecal coliform test at each visit where disinfection is required and "One BOD and TSS grab sample test" a year (Rule 8), with no numeric limits published. These aren't in `labTests` for the same reason as the 3-month schedule.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual). Food-dealer sites also report a water meter reading (Rule 8).

## Required attachments/photos

None published.

## Required report/form

None published (question 8).

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

The district (Rule 14(A)). No portal, email, fax or mailing instruction for reports is published.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

Contracts go to the district (Rule 14(A)), and within 30 days after a property transfer (permit application). Renewal timing comes from 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand. The $20 "Maintenance Inspection / Contract Verification (per contract year)" fee isn't recorded on filings until the district says who pays it (question 3).

## Exceptions

Homeowner maintenance only if the owner lives in the single-family home and completes district-approved coursework, which at present is TOWA's Maintenance Technician class (Rule 14(B)). Homeowners who don't submit, or who falsify documents, must contract with a certified provider (Rule 14(D)). Installers delinquent on maintenance reports can't get authorization to construct (Rule 11).

## Test fixtures

`apps/api/test/bell.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Bell site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the district names its submission channel and confirms questions 2 to 7.
