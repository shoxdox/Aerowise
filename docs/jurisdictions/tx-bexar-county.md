# Bexar County, On-Site Sewage Facilities (`tx-bexar-county`): draft profile

Status: **draft**. Written 2026-10-06 from Bexar County's OSSF page and TCEQ's rules. Bexar County publishes no way to submit maintenance reports, so Bexar inspection filings are held for review and never sent. Contracts are filed by hand. Its OSSF court order could not be read (the PDF is a scan with no text).

## Questions for Justin

Each of these is open in `profile.unresolved`. Bexar County can answer them: 210-335-6700.

1. **Where do maintenance providers send inspection reports and contracts?** The county says reports go to its "Designated Representative" and names no one, and publishes no email, portal or address. This is the blocker: once the county names a channel, a v2 ruleset can send them.
2. **Quarterly or every 4 months?** Bexar County's page says quarterly; TCEQ says every 4 months. Aerowise schedules every 3 months, the stricter.
3. **Does electronic monitoring allow fewer visits in Bexar?** Nothing says so, so Aerowise keeps the quarterly schedule.
4. **What does the county's court order add?** It is an unreadable scan. A readable copy settles the report contents, deadline, coverage area and dates. Until then the deadline is TCEQ's 14 days.
5. **Is the $30.00 renewal fee charged when a contract is filed?** The page doesn't say, so no filing fee is set.

## Identity

- key: `tx-bexar-county`, ruleset v1
- state: TX
- authority: Bexar County, On-Site Sewage Facilities
- requirement in effect: unknown (question 4), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Bexar inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - On-Site Sewage Facilities page: https://www.bexar.org/3218/On-Site-Sewage-Facilities
  - OSSF court order (scanned, not readable): https://www.bexar.org/DocumentCenter/View/30421/OSSF
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

"Bexar County requires that all on-site sewage facilities within Bexar County have to be permitted." Which areas it regulates directly is not published in a readable source. `assignment: "reviewed"`: the office finds the site's permit on the county's permit map (https://map.govpilot.com/map/TX/bexarcountytx) or calls, and records what it checked.

## Service frequency

Quarterly (every 3 months), from the county page (question 2). No longer schedule with electronic monitoring (question 3).

## Lab tests

None in the readable sources.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual), since the court order could not be read.

## Required attachments/photos

None beyond the template's.

## Required report/form

No county form is published.

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None published.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

After the 2-year initial permit, the homeowner keeps a service contract and submits it to Bexar County (the county page). Timing from 30 TAC 285.7(d)(2): 30 days before the service policy or current contract expires. Aerowise files it by hand. No filing fee is set (question 5).

## Exceptions

None published beyond TCEQ's: a single-family owner may maintain their own system.

## Test fixtures

`apps/api/test/bexar.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 3 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the quarterly schedule kept with monitoring on record
- a Bexar site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county names its submission channel and its order is read.
