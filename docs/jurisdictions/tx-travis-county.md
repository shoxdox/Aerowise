# Travis County TNR, On-Site Sewage Facilities (`tx-travis-county`): draft profile

Status: **draft**. v1 was written 2026-10-06 from Travis County's code and pages. v2 (W12.C3 and C4, same day) adds Chapter 448's report fields, read from the original PDF, and replaces the 1,000-foot Lake Travis claim with LCRA's 2,000-foot zone, from [the 2026-10-06 research packet](research/2026-10-06/authorities/tx-travis-county.md) (findings T1–T3). Travis County publishes no way to submit maintenance reports, so Travis inspection filings are held for review and never sent. Contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Travis County TNR can answer them: 512-854-4215, or its contact form.

1. **Where do maintenance providers send inspection reports and contracts?** No email, portal or mailing address for them is published. This is the blocker: once the county names a channel, a v2 ruleset can send them.
2. **Do the 448.034(e) report fields apply to commercial or multi-unit systems?** 448.034(a) scopes the section to OSSFs serving single-family dwellings, so v2 requires them only at sites recorded as residential (which in Aerowise also covers other residential sites).
3. **Is a typed signature on Aerowise's report, and its layout, acceptable?** And does the county need the provider's physical address when it differs from the business address? Aerowise prints the company's one address.
4. **Is there an acknowledgment?** None is published.

## Identity

- key: `tx-travis-county`, ruleset v2 (v1 kept as published; v2 applies from the same day, 2024-07-16)
- state: TX
- authority: Travis County Transportation and Natural Resources (TNR), On-Site Sewage Facilities
- requirement in effect: Chapter 448 took effect 2015-02-23; the amendments adopted 2023-11-28 took effect 2024-07-16 and are footnoted on the provisions they changed (448.037(a)(2), for one). 448.034, the maintenance section used here, carries no amendment footnote (PDF p. 1 and footnotes). Aerowise applies v1 and v2 from 2024-07-16.
- source links (all read 2026-10-06):
  - Chapter 448: https://www.traviscountytx.gov/images/commissioners_court/Doc/county-code/subtitle19/Ch448_Rules_On-Site_Sewage_Facilities.pdf (448.034 on PDF pp. 12–14, compared with the original text for v2)
  - Non-residential OSSF checklist: https://www.traviscountytx.gov/images/tnr/Docs/Non-residential_Checklist.pdf (PDF p. 4, item 21)
  - LCRA OSSF order and fee schedule: https://www.lcra.org/download/water_ossforderandfee-pdf/?wpdmdl=12215 (Section 6)
  - Affidavit to the public for OSSFs requiring maintenance: https://www.traviscountytx.gov/images/tnr/Docs/SP-04.pdf
  - Permit enforcement page: https://www.traviscountytx.gov/tnr/development-services/permitting-center/permit-enforcement
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Chapter 448.005 covers unincorporated Travis County, plus Webberville, Manor, Mustang Ridge, San Leanna and the part of Leander in Travis County. It excludes areas under another local entity's order and areas the City of Austin annexed for the limited purpose of public health. LCRA regulates OSSFs in its Lake Travis zones: the restricted zone below the 691-foot contour, and the water quality zone within 2,000 horizontal feet of it, inside the drainage area (LCRA order Section 6; the county's non-residential checklist, PDF p. 4, item 21, says the same). TNR's enforcement page says 1,000 feet; v1 repeated that, and v2 drops it. The permit or LCRA's map decides each site, not distance from today's shoreline.

`assignment: "reviewed"`: a Travis site is offered both LCRA and Travis County, and the office picks one with evidence. Check LCRA's map first, then city limits.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). The county adds nothing.

## Lab tests

None published.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

448.034(e) (PDF pp. 13–14), for OSSFs serving single-family dwellings (448.034(a)):
- `dispersal_field`, at every Travis site, as in v1
- at residential sites only (`inspection.scopedRequiredFields`): `unauthorized_alterations` (None found, or Found with a description) and `spray_area` (Acceptable, Needs attention, or Not a spray system, since the code says "if applicable")
- printed on every authority copy already: the Permit to Construct number, the provider's printed name and signature, the OSSF's address, and the provider's address and business phone. The provider's emergency phone is printed when the company has entered one (Settings → Company).

Commercial sites aren't held to the scoped fields (question 2).

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

The owner gives the permitting authority a copy of the signed contract 30 days before the service policy or current contract expires (30 TAC 285.7(d)(2)). Aerowise files it by hand. Chapter 448.034(f) lists what a contract shows. A single-family owner who maintains their own system must produce a contract within ten days of the county's notice (448.034(d)).

## Exceptions

Homeowners who maintain their own system (448.034(b)–(c)) file their own reports.

## Test fixtures

`apps/api/test/travis.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing dispersal-field answer, which keeps the inspection a draft
- v2: alterations and spray area required at a residential site, not at a commercial one
- v2: LCRA's 2,000-foot zone in the assignment text, with no 1,000-foot claim left
- the 6-month schedule with monitoring on record
- a Travis site offered both LCRA and Travis County, never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county names its submission channel.
