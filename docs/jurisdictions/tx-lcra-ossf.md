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

Contracts are filed with the cover sheet. Timing, 30 TAC 285.7(d)(2) (TCEQ's 2022 adoption, 47 TexReg 8898, read through a summarizer; also quoted by Fort Bend County): the signed contract goes to the permitting authority 30 days before the initial two-year service policy expires, and each later contract at least 30 days before the current one expires. Aerowise sets the deadline only when it knows the end of the contract being replaced; otherwise the filing says why there is no date. Exception: a single-family owner who maintains the system personally (285.7(d)(4)), which never applies to a provider's contract; not for commercial, speculative residential or multifamily property. Confirm against the official Texas Administrative Code text before enforcing.

## Confirmation / proof

LCRA publishes no acknowledgment process. "Sent" means the mail provider accepted the message. An acknowledgment is recorded only by hand, with what showed it (an email reply, a letter, a call).

## Open questions

See `profile.unresolved` in the ruleset.
