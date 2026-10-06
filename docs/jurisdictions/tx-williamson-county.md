# Williamson County Engineer's Office, OSSF (`tx-williamson-county`): draft profile

Status: **draft**. Written 2026-10-06 from Williamson County's public pages and documents. Nothing goes to the county automatically. The office checks each filing and presses Send, or files by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. The county is the one to answer them: OSSF office, 512-943-3330, ossf@wilcotx.gov.

1. **Where do maintenance providers send inspection reports?** The only published address is in the packet for homeowners who maintain their own system: ossf@wilcotx.gov (or mail to 3151 SE Inner Loop, Ste. B, Georgetown, TX 78626, or fax 512.943.3335). Aerowise uses that email. Should providers use MyGovernment Online instead?
2. **What is the report deadline: 10 or 14 days?** The 2026 affidavit says within 10 days of testing. The homeowner packet says within 14 days of the due date, and TCEQ says 14 days after the test. Aerowise uses 10, the strictest.
3. **When is a renewed contract due?** The affidavit says 30 days before the previous contract expires; the care brochure says "within 30 days of expiration". Aerowise uses 30 days before.
4. **Does the county want a sludge level on every report?** Its order (Section 10.E.7) says reports include sludge levels in the pump tank. Aerowise's inspection form has no sludge field yet. Should one be added?
5. **May sites be assigned to Williamson by county?** Williamson regulates the whole county except the City of Austin. Right now every Williamson site needs a person to confirm it is outside Austin. If most customers are clearly outside Austin, a city check could replace the review.
6. **Is there a commercial schedule or any lab testing?** None is published, so none is required here.

## Identity

- key: `tx-williamson-county`, ruleset v1
- state: TX
- authority: Williamson County Engineer's Office, On-Site Sewage Facilities (some newer documents say "Department of Infrastructure")
- requirement in effect: the county's OSSF order takes effect on TCEQ approval (Section 17). The copy read was attached to the Commissioners Court agenda of 2021-01-12, and its approval date is blank, so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06, the day it was written. Williamson inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - OSSF page: https://www.wilcotx.gov/644/On-Site-Sewage-Facilities-OSSF
  - OSSF order: https://public.destinyhosted.com/wilcodocs/2021/COM/20210112_1578/25845_Williamson_County_Order_(Final_Revision)_.pdf (read through a page summarizer)
  - Routine Maintenance Affidavit to the Public (updated 6/26/2026): https://www.wilcotx.gov/DocumentCenter/View/20281
  - Homeowner Maintenance Packet (updated 9/25/25): https://www.wilcotx.gov/DocumentCenter/View/16756/Homeowner-Maintenance-Packet-PDF
  - OSSF fees (updated 9/12/25): https://www.wilcotx.gov/DocumentCenter/View/16737
  - OSSF Guide (updated 9/26/2025) and care brochure: https://www.wilcotx.gov/DocumentCenter/View/3058/OSSF-Guide-PDF, https://www.wilcotx.gov/DocumentCenter/View/3094/OSSF-Care-Brochure-PDF
  - TCEQ maintenance page (last modified 2026-03-03): https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html

## Applicability

The order covers all of Williamson County except areas under another order, ordinance or resolution (Section 6). The OSSF page names one exception: the City of Austin. `assignment: "reviewed"`: the office checks that the address is outside Austin's city limits and records what it checked.

## Service frequency

Every 4 months. Every 6 months for a system with electronic monitoring on record (order Section 10.D.4; the affidavit). TCEQ requires the monitor to notify the provider of failures and to monitor disinfection.

## Lab tests

None published.

## Filing deadline

10 days after the inspection (the affidavit), warning 3 days before. See question 2.

## Required inspection fields

- Condition of the spray area (`dispersal_field`), from order Section 10.E.7.
- Not checked: sludge level in the pump tank (no field yet, question 4), and the chlorine grab sample the county's form asks for on surface application systems (Aerowise does not record the dispersal type).

## Required attachments/photos

None beyond the template's.

## Required report/form

No county form for maintenance providers is published. The homeowner packet has a county inspection form, so Aerowise sends its own report.

## Submission method

Email, sent by the office.

## Destination / portal

ossf@wilcotx.gov. See question 1.

## Customer copy requirement

Required (TCEQ: reports go to the permitting authority and the owner).

## Confirmation / proof

None published.

## Contract requirements

Filed with the county 30 days before the previous contract expires, or within 30 days after the property is transferred (the affidavit). Sent by email to the same address. The owner's $60 license renewal every two years is not a filing fee, so no fees are set.

Credentials: the responsible maintenance provider must hold a TCEQ MP license (order Section 10.E.6: maintenance by TCEQ-registered companies), and the technician must hold an MP license or technician registration (TCEQ).

## Exceptions

Homeowners who maintain their own system file their own reports. Aerowise does not handle that case.

## Test fixtures

`apps/api/test/williamson.test.ts` covers these cases:
- a valid inspection: due 10 days later, next visit in 4 months, held until the provider's credentials and signature are in place, then ready and sent by the office to ossf@wilcotx.gov, never on its own
- a missing spray-area answer, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a site not matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md: Justin confirms the answers above with the county and records the confirmation in a v2 ruleset.
