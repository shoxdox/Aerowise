# Hays County Development Services, OSSF (`tx-hays-county`): draft profile

Status: **draft**. Written 2026-10-06 from Hays County's regulations, affidavit and pages. Hays County publishes no way to submit maintenance reports, so Hays inspection filings are held for review and never sent. Contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Hays County Development Services can answer them: 512-393-2150, or MyGovernmentOnline.

1. **Where do maintenance providers send inspection reports and contracts?** No email, portal or mailing address for them is published. This is the blocker: once the county names a channel, a v2 ruleset can send them.
2. **Which cities run their own OSSF program?** The order covers all of Hays County except areas under another entity's order, and names none. Until the county lists them, every Hays site needs a person to check it.
3. **Should report due dates count from the contract's start?** Hays County wants the first report within 14 days of the contract's start and later ones on a schedule from that date. Aerowise counts 4 months from the last visit and 14 days from the inspection, as TCEQ does.
4. **Does electronic monitoring allow six months between visits in Hays?** The order is silent; Aerowise follows TCEQ's six months.
5. **Should Aerowise book the 10-day chlorine re-test?** A report showing low chlorine needs a re-test and a new report within ten days. Today the office books it by hand.
6. **What was the order's effective date?** A summarizer reported approval on 2013-06-04 and TCEQ approval on 2014-02-18, unconfirmed, so Aerowise applies the ruleset from 2026-10-06.

## Identity

- key: `tx-hays-county`, ruleset v1
- state: TX
- authority: Hays County Development Services, On-Site Sewage Facilities
- requirement in effect: the order takes effect on its approval and TCEQ's (question 6), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Hays inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - Hays County OSSF Regulations: https://www.hayscountytx.gov/DocumentCenter/View/1893/Hays-County-On-Site-Sewage-Facility-Regulations-PDF (read through a page summarizer)
  - OSSF Maintenance Affidavit (undated): https://www.hayscountytx.gov/DocumentCenter/View/1896/On-Site-Sewage-Facility-OSSF-Maintenance-Affidavit-PDF
  - Septic Permits page: https://www.hayscountytx.gov/496/Septic-Permits
  - FAQ: https://www.hayscountytx.gov/m/faq?cat=51
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

All of Hays County except areas under another order, ordinance or resolution; the permits page covers unincorporated Hays County. `assignment: "reviewed"`: the office checks the address is outside any city with its own OSSF program and records what it checked (question 2).

## Service frequency

Every 4 months "unless otherwise specified on the permit" (order Section V.2). Every 6 months with electronic monitoring on record, from TCEQ (question 4).

## Lab tests

None published. Commercial systems need flow meters, which Aerowise does not record.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before. See question 3 for Hays County's own schedule.

## Required inspection fields

The order lists no report contents beyond 30 TAC 285.91(12), so Hays adds none to the template's own required fields (which include the chlorine residual). A low chlorine residual needs a re-test within ten days (question 5).

## Required attachments/photos

None beyond the template's.

## Required report/form

No county form is published.

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None published.

## Customer copy requirement

Required (order Section V; 30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

A new contract at least 30 days before service ceases, and on a transfer a signed contract to Development Services within 30 days (the affidavit). Aerowise files it by hand. The 2026 fee schedule was not read, so no fees are set.

Credentials: maintenance by a TCEQ-licensed maintenance provider (order Section V.1); systems other than single-family homes only by licensed providers (the affidavit).

## Exceptions

Single-family homeowners who maintain their own system file their own reports.

## Test fixtures

`apps/api/test/hays.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Hays site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county names its submission channel.
