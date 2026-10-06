# Montgomery County Environmental Health Services, OSSF (`tx-montgomery-county`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-montgomery-county.md` (Southeast Texas research thread). The county's OSSF web pages on mctx.org could not be read, so this profile comes from county PDFs on its file host. Montgomery inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Montgomery County Environmental Health Services can answer them: (936) 539-7839. The Permit Department is (936) 539-7836. For lake parcels, call SJRA at 936-588-3111.

1. **Where should providers send the 4-month aerobic reports (email, portal, mail to 501 N. Thompson, fax), and is there a county report form?** This is the blocker for sending.
2. **Where and when are renewal contracts filed after the initial two years, and is anything required on a property transfer?**
3. **Has the county adopted an OSSF order? What are its number, adoption date and TCEQ approval date?**
4. **Does electronic monitoring allow 6 months between visits, or must there always be three a year?**
5. **For commercial systems, what BOD and TSS limits apply, and with which report does the annual result go?**
6. **Are there fees or late fees for reports or contracts?**
7. **Does the county acknowledge reports or contracts?**
8. **Who permits inside city limits (Conroe, Willis, Magnolia, Montgomery, Oak Ridge North, Shenandoah, Splendora), including inside city limits near Lake Conroe, where SJRA's order doesn't apply?**
9. **How is SJRA's 2,075 feet measured, and is there a parcel lookup for the line between the county and SJRA?**
10. **May homeowners maintain their own systems after two years, and is training required?**
11. **Must the report include anything beyond the contract form's items, such as chlorine residual, sludge depth or the provider's license number?**

## Evidence gaps and conflicts

- Every mctx.org page, including the OSSF page and OSSF forms page that probably state the channel, returned "disallowed by robots.txt". curl got a proxy 403 and the Wayback copy is blocked. TCEQ's authorized-agent lookup timed out.
- Every county PDF was read through a page summarizer. The County thread re-read the Two Year Initial Maintenance Contract on 2026-10-06, and the frequency, 14-day and BOD/TSS sentences came back with the same wording. Nobody has compared them with the PDF in a browser yet.
- The three-a-year rule is on the *initial* two-year contract form. Whether it also applies after the first two years is part of question 4.
- The research packet gives SJRA's order number as "384053.4". Codex checked the original PDFs for Justin on 2026-10-06: that is a repeating document footer, not the order number. The copy cited here (2015/03) is unsigned with a blank order number. SJRA's own profile will cite the signed copy. Montgomery's profile uses the order only for the 2,075-foot boundary.
- There are two suites and phones: the Permit Department is Suite 100, (936) 539-7836, and Environmental Health Services is Suite 101, 936-539-7839. Which one receives maintenance filings is unknown.

## Identity

- key: `tx-montgomery-county`, ruleset v1
- state: TX
- authority: Montgomery County Environmental Health Services, On-Site Sewage Facilities
- requirement in effect: unknown (question 3), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. Montgomery inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - Two Year Initial Maintenance Contract: https://cms1files.revize.com/montgomerycountytx/document_center/1%20Environmental%20Health/Initial%202%20yr%20Maintenance%20maintenance.pdf
  - Residential New Septic System packet (rev. April 19, 2024): https://cms1files.revize.com/montgomerycountytx/PACKET-RESIDENTIAL%20NEW%20SEPTIC%20SYSTEM.pdf
  - How to Obtain a Septic, with fees (rev. March 22, 2023): https://cms1files.revize.com/montgomerycountytx/document_center/1%20Environmental%20Health/How%20to%20Obtain%20a%20Septic.pdf
  - SJRA Lake Conroe OSSF order (unsigned 2015/03 copy): https://www.sjra.net/wp-content/uploads/2015/03/Order-Adopting-Rules-for-On-Site-Sewage-Facilities-Within-2075-Feet-of-Lake-Conroe-Texas-2015.pdf
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

The county permits OSSFs in unincorporated Montgomery County. This is inferred from the permit packets, since the coverage statement on mctx.org couldn't be read. SJRA's rules cover "all the area lying within 2,075 feet of Lake Conroe" outside city limits. City programs aren't published (question 8). `assignment: "reviewed"`: the office checks with the county, and with SJRA for lake parcels, and records what it checked.

## Service frequency

Every 4 months: "a minimum of three (3) inspections, one every four (4) months" (county contract form). The form doesn't mention monitoring, so there's no 6-month schedule (question 4).

## Lab tests

Commercial: "Non-single family residences, commercial, require one BOD and TSS grab sample per year." `labTests` is BOD and TSS every 12 months for commercial systems, with no limits (question 5).

## Filing deadline

"within 14 days after the date the test is performed" (county form, matching 30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual). The county form lists a visual effluent check (color, turbidity, sludge build-up, scum overflow, odor) and the aerator, air filter and alarm panel. See question 11.

## Required attachments/photos

None published.

## Required report/form

None found (question 1).

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None published. HealthComplaints@mctx.org is for complaints only.

## Customer copy requirement

Required: "submitted to the permitting authority and the owner".

## Confirmation / proof

None published.

## Contract requirements

The two-year initial contract, signed by owner and installer, is part of the permit packet "BEFORE FINAL INSPECTION". Renewal timing comes from 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand (question 2).

## Exceptions

None published locally (question 10). The owner or occupant maintains the disinfection unit.

## Test fixtures

`apps/api/test/montgomery.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- 4 months between visits even with monitoring on record
- a Montgomery site never matched by county alone
- annual BOD and TSS for commercial systems, with no limits

## Verification

Draft. To verify, follow TEMPLATE.md once the county's OSSF pages are read and it names its submission channel.
