# Collin County Development Services, OSSF (`tx-collin-county`): draft profile

Status: **draft**. Written 2026-10-06 from Collin County's OSSF page, its aerobic systems information sheet and TCEQ's rules. Collin County takes maintenance reports and contracts through its OSSF Report Portal. The office downloads each report, submits it there and records it as sent; nothing goes out on its own. Collin County's Rules and Regulations (Court Order 2008-187-03-11) could not be read: the PDF is a scan with no text.

## Questions for Justin

Each of these is open in `profile.unresolved`. Collin County Development Services can answer them: (972) 548-5585, developmentservices@collincountytx.gov.

1. **What is the report deadline?** The information sheet gives none, and the rules are unreadable. Aerowise uses TCEQ's 14 days after the inspection.
2. **Does electronic monitoring allow 6 months between visits in Collin?** The sheet says "3 times a year minimum" at 4-month intervals, so Aerowise allows no 6-month schedule.
3. **What does the report portal ask for?** It is a web form Aerowise cannot fill. Does it accept the Aerowise PDF as an upload?
4. **Does the county reply to a submission?** None is published.

## Identity

- key: `tx-collin-county`, ruleset v1
- state: TX
- authority: Collin County Development Services (Engineering), On-Site Sewage Facilities
- requirement in effect: Court Order 2008-187-03-11; its effective date could not be read, so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Collin inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - On-Site Sewage Facilities page: https://www.collincountytx.gov/Services/Engineering/Development-Services/on-site-sewage-facilities
  - Aerobic Systems Information Sheet (undated): https://www.collincountytx.gov/docs/default-source/development-services/documents/aerobic-systems-information-sheet.pdf
  - Rules and Regulations, CO No. 2008-187-03-11 (scanned, not readable): https://www.collincountytx.gov/docs/default-source/development-services/documents/on-site-sewage-facilities-rules-and-regulations-co-no-2008-187-03-11.pdf
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Outside city limits, Collin County permits OSSFs. Inside city limits, TCEQ's list says whether the city or Collin County does (the OSSF page). `assignment: "reviewed"`: the office checks and records what it checked.

## Service frequency

"Maintenance companies shall inspect a system 3 times a year minimum. This shall be done at 4-month intervals." (information sheet). No 6-month schedule with monitoring (question 2).

## Lab tests

None in the readable sources.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before. See question 1.

## Required inspection fields

None beyond the template's own. The sheet says chlorine must be maintained in surface irrigation systems at all times; the template already requires the chlorine residual.

## Required attachments/photos

None beyond the template's.

## Required report/form

No county form is published; reports go through the portal (question 3).

## Submission method

Filed by hand through the county's portal: `manual_export` with the portal link on the filing. The office submits the report and records it as sent.

## Destination / portal

OSSF Report Portal: https://apps.collincountytx.gov/Forms/DS-AerobicPermit-Prod (reports, new contracts and change-of-ownership forms).

## Customer copy requirement

Required: "Copies of the report shall be sent to our Department and to the homeowner." (information sheet).

## Confirmation / proof

None published. The office records the submission as the proof.

## Contract requirements

"Renewals must be submitted to our department 30 days prior to the expiration of the contract." (information sheet), through the same portal. A new owner files a Change of Ownership form within 15 days of closing; Aerowise does not track it. No fees are published.

## Exceptions

None published beyond TCEQ's: a single-family owner may maintain their own system.

## Test fixtures

`apps/api/test/collin.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held until the provider's credentials and signature are in place, then ready to file by hand with the portal link, and recorded as sent; nothing is mailed
- a missing chlorine residual, which keeps the inspection a draft
- the 4-month schedule kept with monitoring on record
- a Collin site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county answers the questions above.
