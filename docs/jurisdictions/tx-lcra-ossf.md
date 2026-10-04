# LCRA OSSF Program (`tx-lcra-ossf`): draft profile

Status: **draft**. Written 2026-10-04 from LCRA's public pages. Nothing is sent to LCRA automatically; the office checks each package and presses Send (or files by hand).

## Identity

- key: `tx-lcra-ossf`, ruleset v1
- state: TX
- authority: Lower Colorado River Authority, On-Site Sewage Facility program
- requirement in effect: LCRA's current OSSF order, adopted 2010-01-20, effective 2010-04-05 (`profile.requirementEffective`). Separately, the sources were read on 2026-10-04 (`profile.sourcesCheckedOn`); that is not an effective date.
- source links (read 2026-10-04):
  - FAQs: https://www.lcra.org/water/permits-contracts/on-site-sewage/faqs/ ("complete the maintenance contract and inspection report cover sheet and email it with your contract or report to ossf@lcra.org")
  - Cover sheet: https://www.lcra.org/download/omcoversheet-pdf/?wpdmdl=20783. The link refused this environment; the provider supplied the file (one page, fillable, PDF modified 2019-01-29, SHA-256 `6923d17b…170e`). It is kept at `packages/compliance/forms/tx-lcra-ossf/om-cover-sheet.pdf` and pinned by hash in the ruleset.
  - Jurisdiction map: https://waterquality.lcra.org/ossf/ (red area = LCRA OSSF jurisdiction; unclear cases 512-578-3200 or 800-776-5272)
  - OSSF order and fee schedule: https://www.lcra.org/download/water_ossforderandfee-pdf/?wpdmdl=12215
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

LCRA regulates OSSFs only inside its mapped area around the Highland Lakes. **The county never decides it.** Burnet, Llano and Travis are listed only so sites there are held for review (`assignment: "reviewed"`); the office looks the address up on LCRA's map and records what it checked. Other counties that touch the lakes are not listed: sites there match no authority and also go to review.

## Service frequency and deadline

TCEQ: at least every four months, reported to the permitting authority and the owner within 14 days after the test (30 TAC 285.7, 2022 adoption). Deadline basis on each filing: "14 days after the inspection". **The six-month option for systems with electronic monitoring and automatic notification is not available**: Aerowise does not record whether a system qualifies, so every site is held to four months.

## Required report/form

Cover sheet with every package (inspection report or contract). Aerowise fills **LCRA's own fillable PDF** (fields Textfield…Textfield-4, Start, End, Number of Inspections a Year, Inspection Report Date, mapped in the ruleset), prints dates as MM/DD/YYYY and flattens it. Fields: Date*, Maintenance Provider Name*, TCEQ MP #*, LCRA OSSF Application Number*, Property Owners Name, Property Address, Contract Term Start/End, Number of Inspections a Year, Inspection Report Date (* the form marks MP # and application number REQUIRED; Aerowise also requires Date and Provider Name). If the stored form's hash ever differs from the ruleset, packaging fails instead of sending a different form. Open question: LCRA has not confirmed it accepts the form filled electronically and attached to an email.

The responsible provider must hold an active TCEQ MP license; the inspecting technician must hold an active MP license or maintenance technician registration on the inspection date. The site must have its LCRA OSSF application number (format unpublished, so only presence is checked).

## Submission method

Email to ossf@lcra.org with the cover sheet and the authority report (or signed contract). Fallback: by hand.

## Contract requirements

Contracts are filed with the cover sheet. 30 TAC 285.7 sets a different deadline for each kind of contract. The paragraph text was read on 2026-10-04 from Cornell LII's republished §285.7, through a fetch tool asked for verbatim quotes, and it matches the quote in TCEQ's 2022 adoption cited in review:

| Kind (recorded on the contract) | Deadline | Rule |
|---|---|---|
| Initial two-year service policy | Before the system is approved for use. Aerowise does not know that date, so it sets none. | 285.7(c) |
| First contract after the initial policy | 30 days before the policy expires | 285.7(d)(2) |
| Later contract (renewal) | At least 30 days before the current contract expires. A contract renewed in Aerowise is treated as this automatically. | 285.7(d)(2) |
| Replacement after a contract was discontinued | No later than 30 days after termination | 285.7(d)(3)(C) |

A first contract in Aerowise has no deadline until someone records which kind it is. Aerowise does not guess.

**Ending a contract.** Under 285.7(d)(3)(A) and (B), the maintenance provider notifies the permitting authority and the manufacturer in writing at least 30 days before service stops, and also notifies the owner when the provider ends the contract. Aerowise asks who ended the contract and the last day of service, puts the notice in the inbox, and records it when it is sent. It does not send the notice itself. A future last day keeps the contract and the visits due by then active; it ends the day after.

**Exception.** 285.7(d)(4) covers a single-family owner who maintains the system personally. That is never a provider's contract, and it does not apply to commercial or multifamily property.

## Report signature

Under 285.7(b)(3), the maintenance provider must sign all maintenance reports. An inspection filing waits until someone with their own active MP license, checked against TCEQ's license search, signs the latest authority report version by typing their name. The filing then sends the signed copy. When someone else inspected, the signer attests that the technician is employed by the provider and works under their direct supervision (285.7(b)(1), 285.2). The technician's registration on the inspection date is checked; employment and supervision are only attested. A later report version, whether a correction or one redrawn with complaint responses, needs its own signature. The MP named on the site's contract signs by default; anyone else needs a described delegation. The customer copy is signed in the same step and held until then. Whether LCRA accepts a typed-name signature is unconfirmed and is a pilot blocker.

## Confirmation / proof

LCRA publishes no acknowledgment process. "Sent" means the mail provider accepted the message. An acknowledgment is recorded only by hand, with what showed it (an email reply, a letter, a call).

## Open questions

See `profile.unresolved` in the ruleset.
