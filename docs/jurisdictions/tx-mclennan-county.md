# McLennan County (Waco-McLennan County Public Health District), OSSF (`tx-mclennan-county`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-mclennan-county.md` (Central Texas research thread). McLennan County is TCEQ's authorized agent, and its order names the Waco-McLennan County Public Health District (a City of Waco department) as the designated representative that runs the program. No way to submit maintenance reports or contracts is published, so McLennan inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. The district's OSSF program can answer them: (254) 299-2473. Environmental Health's main line is (254) 750-5464, envhealth@wacotx.gov.

1. **How must providers submit aerobic inspection reports?** Email (which address), fax (254) 750-6619, mail or a portal? Is OSSF@wacotx.gov accepted for reports, or only for scheduling inspections? This is the blocker for sending.
2. **What is the report deadline, and is there a local report form or extra fields?**
3. **Is the annual aerobic fee now $40 (schedule effective 2026-10-01) rather than $20? Who is billed, when, and how?**
4. **Which cities, if any, are not in the program?** For example Mart, West, Moody, Riesel, Valley Mills, Bruceville-Eddy, Golinda.
5. **Does electronic monitoring allow 6 months between visits?**
6. **How and when are later renewals and new-owner contracts filed, and on what form?**
7. **Is the 2009 order (rev. 08/09) still in effect, and what are its adoption date, order number and TCEQ approval date?**
8. **Does the district acknowledge reports or contracts?**

## Evidence gaps and conflicts

- curl to the county and city hosts is blocked from the research session, so every PDF was read through a page summarizer. The County thread re-read the order and the OSSF page on 2026-10-06 and got the same coverage and designated-representative wording. Nobody has compared them with the PDFs in a browser yet. The summarizer described the permit application pages as "appear to be scans" but returned text.
- Fees conflict. The district's web schedule (effective 2026-10-01) lists a $40 annual aerobic fee and a $30 provider penalty. The permit application (fee page updated 1/27/2026) lists $20 and $25. Neither is recorded on filings.
- Coverage conflicts. The order covers unincorporated McLennan County plus member cities, while the district's page says "the cities in McLennan County". No member list is published. TCEQ's 2024 authorized-agent report lists no separate city agent in McLennan County.
- Phone numbers differ: (254) 299-2473 (OSSF page), (254) 299-2489 (servicer list), 254-750-8008 (permit application), (254) 750-5464 (Environmental Health).
- The district's 2025 annual report mentions a database upgrade planned for 2026, so a submission portal may be coming. That's unconfirmed.

## Identity

- key: `tx-mclennan-county`, ruleset v1
- state: TX
- authority: McLennan County (Waco-McLennan County Public Health District), On-Site Sewage Facilities
- requirement in effect: unknown (question 7), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. McLennan inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - 2009 OSSF Order: https://www.mclennan.gov/DocumentCenter/View/591/2009-OSSF-Order-PDF
  - OSSF program page: https://waco-texas.com/Departments/Health-District/Environmental-Health/On-Site-Sewage-Facilities-Program
  - OSSF permit application: https://www.waco-texas.com/files/sharedassets/public/v/7/departments/health-district/documents/enviro-health/ossf-permit-app.pdf
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

"The Rules shall apply to all the unincorporated areas of McLennan County, Texas" and to cities that are members of the health district (Order Sec. 6). `assignment: "reviewed"`: the office checks with the district and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e), which the order adopts by reference). See question 5.

## Lab tests

None published locally.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before. A provider penalty fee applies to reports not submitted "in a timely manner" (question 2).

## Required inspection fields

None beyond the template's own (which include the chlorine residual).

## Required attachments/photos

None published.

## Required report/form

None published (question 2).

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None published.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

A two-year contract comes with the permit application. The next one is due "at least 30 days prior to the expiration of the initial two-year service policy". Later renewals follow 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand.

## Exceptions

A homeowner may maintain their own unit only if they hold a TCEQ maintenance license or registration, received on-site training for their unit, hold a Class D or higher wastewater license, or completed TCEQ's basic maintenance provider class (Order Sec. 10(B)). They lose that option after two or more failures to report, falsified documents or confirmed nuisance complaints within twelve months.

## Test fixtures

`apps/api/test/mclennan.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a McLennan site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the district names its submission channel and settles the fee conflict.
