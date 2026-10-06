# Comal County Engineer's Office, Environmental Health (`tx-comal-county`): draft profile

Status: **draft**. v1 was written 2026-10-06 from Comal County's pages and TCEQ's rules. v2 (W12.C4 and C6, same day) adds the county's 2013 rules, read from OCR of the scan, and its five published city agreements, from [the 2026-10-06 research packet](research/2026-10-06/authorities/tx-comal-county.md) (findings C1 to C4). Comal County takes maintenance reports on an upload portal. The office downloads each report, uploads it there and records it as sent; nothing goes out on its own.

## Questions for Justin

Each of these is open in `profile.unresolved`. The Comal County Engineer's Office can answer them: 830-608-2090.

1. **Are the agreements with Bulverde, Fair Oaks Ranch, Garden Ridge, Schertz and Spring Branch all still in force, and which other cities run their own OSSF program?**
2. **Does the reports portal want a particular file name, format or signature?** It asks for the provider's name, email and TCEQ license number, and says nothing else.
3. **Is there an acknowledgment of an upload?** None is published.
4. **Do homeowners who maintain their own single-family system submit reports?** v1 read the FAQ as saying no; the current page doesn't say so.
5. **Does the county want the spray area's condition on reports for systems without spray?**

## Identity

- key: `tx-comal-county`, ruleset v2 (v1 kept as published; v2 applies from the same day, 2026-10-06)
- state: TX
- authority: Comal County Engineer's Office, Environmental Health
- requirement in effect (the legal date): 2013-11-26, the TCEQ's approval of the county's rules, adopted 2013-10-24 (13-page scan, PDF pp. 6-7, 10-13). Later amendments were not checked.
- rule activation in Aerowise (a different thing): `effectiveFrom` 2026-10-06. Nothing earlier is backdated, and existing contracts and filings are not rewritten.
- source links (all read 2026-10-06):
  - Environmental Health page: https://www.comalcounty.gov/274/Environmental-Health
  - OSSF Information: https://www.comalcounty.gov/276/OSSF-Information
  - Rules for OSSF (scan, read from OCR): https://www.comalcounty.gov/documentcenter/view/2141
  - City agreements: Bulverde https://www.comalcounty.gov/DocumentCenter/View/2136, Fair Oaks Ranch …/2137, Garden Ridge …/2138, Schertz …/2139, Spring Branch …/2140 (full links in the ruleset)
  - Environmental Health fees, effective 2019-01-01: https://www.comalcounty.gov/DocumentCenter/View/2142/
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Comal County's Engineer's Office permits OSSFs in Comal County, including inside Bulverde, Fair Oaks Ranch, Garden Ridge, Schertz and Spring Branch under published agreements (only the Comal County part of cities in more than one county). An agreement can be ended or replaced, and other cities may run their own programs (question 1). `assignment: "reviewed"`: the office checks the site's permit and records what it checked; a city name alone never assigns a site.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). Sections 8-9 of the county's rules adopt the TCEQ's rules; section 10's local additions are about construction and siting.

## Lab tests

None in the county's rules or pages.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

The spray area's condition (`spray_area`, form v2), from section 10.9 (PDF p. 12), which keeps picnic tables, play equipment, barbecue pits and the like out of a surface application spray area. The technician can answer "Not a spray system" (question 5). Plus the template's own required fields, including the chlorine residual.

## Required attachments/photos

None beyond the template's.

## Required report/form

No county form is published.

## Submission method

Filed by hand on the county's portal: `manual_export` with the portal link on the filing. The office uploads the report and records it as sent.

## Destination / portal

- Reports: https://comalcountyengineersoffice.files.com/u/maintenance-reports
- Contracts: https://comalcountyengineersoffice.files.com/u/maintenance-contracts

Both sign in with the provider's name, email and TCEQ license number. A published portal is not the county's acceptance of Aerowise's report layout or signatures (question 2).

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published. The office records the upload as the proof.

## Contract requirements

Uploaded to the contracts portal 30 days before the service policy or current contract expires (30 TAC 285.7(d)(2)). The 2019 fee schedule has no fee for reports or contracts, so no fees are set.

## Exceptions

Only owners of single-family homes may maintain their own aerobic system; everyone else uses a licensed maintenance provider. Whether a self-maintaining owner reports is open (question 4).

## Test fixtures

`apps/api/test/comal.test.ts` covers these cases:
- v2 reads as written (rules dates, five agreements, spray area required) and replaces v1 from 2026-10-06; v1 is unchanged
- a valid inspection: due 14 days later, next visit in 4 months, held until the provider's credentials and signature are in place, then ready to file by hand with the portal link, and recorded as sent; nothing is mailed
- a missing chlorine residual, and a missing spray-area condition, each keep the inspection a draft
- the 6-month schedule with monitoring on record
- a Comal site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county answers questions 1 to 3.
