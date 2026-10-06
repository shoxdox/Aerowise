# Comal County Engineer's Office, Environmental Health (`tx-comal-county`): draft profile

Status: **draft**. Written 2026-10-06 from Comal County's pages and TCEQ's rules. Comal County takes maintenance reports on an upload portal. The office downloads each report, uploads it there and records it as sent; nothing goes out on its own. Comal County's own OSSF rules could not be read (the PDF is a scan with no text), so the schedule and deadline are TCEQ's.

## Questions for Justin

Each of these is open in `profile.unresolved`. The Comal County Engineer's Office can answer them: 830-608-2090.

1. **Do Comal County's own rules change the schedule, the deadline or what a report must show?** Their PDF is a scan Aerowise could not read. A readable copy, or the county's answer, settles it. Until then Aerowise follows TCEQ: every 4 months, reports within 14 days.
2. **Which cities run their own OSSF program?** None is named in a readable source, so every Comal site needs a person to check it (the county's septic records search helps).
3. **Does the reports portal want a particular file name or format?** It asks for the provider's name, email and TCEQ license number, and says nothing else.
4. **Is there an acknowledgment of an upload?** None is published.

## Identity

- key: `tx-comal-county`, ruleset v1
- state: TX
- authority: Comal County Engineer's Office, Environmental Health
- requirement in effect: unknown (question 1), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Comal inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - Environmental Health page: https://www.comalcounty.gov/274/Environmental-Health
  - OSSF Information (homeowner maintenance FAQ): https://www.comalcounty.gov/276/OSSF-Information
  - Rules for OSSF (scanned, not readable): https://www.comalcounty.gov/DocumentCenter/View/2141/
  - Environmental Health fees, effective 2019-01-01: https://www.comalcounty.gov/DocumentCenter/View/2142/
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Comal County's Engineer's Office permits OSSFs in Comal County. Which cities are excluded is not published in a readable source (question 2). `assignment: "reviewed"`: the office checks the county holds the site's permit and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)).

## Lab tests

None in the readable sources.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual), since the county's rules could not be read.

## Required attachments/photos

None beyond the template's.

## Required report/form

No county form is published.

## Submission method

Filed by hand on the county's portal: `manual_export` with the portal link on the filing. The office uploads the report and records it as sent.

## Destination / portal

- Reports: https://comalcountyengineersoffice.files.com/u/maintenance-reports
- Contracts: https://comalcountyengineersoffice.files.com/u/maintenance-contracts

Both sign in with the provider's name, email and TCEQ license number.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published. The office records the upload as the proof.

## Contract requirements

Uploaded to the contracts portal 30 days before the service policy or current contract expires (30 TAC 285.7(d)(2)). The 2019 fee schedule has no fee for reports or contracts, so no fees are set.

## Exceptions

Owners of single-family homes may maintain their own aerobic system and submit no reports to Comal County (the FAQ). Everyone else uses a licensed maintenance provider.

## Test fixtures

`apps/api/test/comal.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held until the provider's credentials and signature are in place, then ready to file by hand with the portal link, and recorded as sent; nothing is mailed
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Comal site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county's rules are read.
