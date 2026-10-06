# San Jacinto River Authority, Lake Conroe OSSF (`tx-sjra-ossf`): draft profile

Status: **draft**. Written 2026-10-06 from the research packet `/mnt/project-files/Septic/pilot-build/county-research/tx-sjra-ossf.md` (Southeast Texas research thread), with the key quotes re-checked as Justin asked. SJRA permits OSSFs within 2,075 feet of Lake Conroe, outside city limits. Inspection reports and contracts go through SJRA's customer portal. The office enters each one by hand and records it in Aerowise. Nothing is sent on its own.

v2 (W12.C3 and C7, same day) is based on the signed order read as page images (physical PDF pages cited below), reconciled with [the 2026-10-06 research packet](research/2026-10-06/ARCHIVE.md). It requires the Section 7(a)(10)(D) report fields and records the order number and scope as read.

## Questions for Justin

Each of these is open in `profile.unresolved`. SJRA's Lake Conroe Division OSSF program can answer them: 936-588-3111, 1577 Dam Site Road, Conroe, TX 77304.

1. **What is the order's number, when did TCEQ approve it, and has it been amended?** The handwritten number on PDF p. 1 reads "2015-O-04" or "2015-0-04"; the middle character can't be told apart from a zero.
2. **Does SJRA accept the date of the preceding inspection as "none on record" for a site new to the provider?** Section 7(a)(10)(D)(ii) asks for it; Aerowise only knows inspections it recorded.
3. **From what line is the 2,075 feet measured, and is the OSSF Data Viewer the authoritative answer?**
4. **Which counties does the band cover (Montgomery, Walker, San Jacinto), and which areas count as "regulated under any predecessor Rule"?**
5. **Will SJRA accept two inspections a year for systems with electronic monitoring, or is it always every four calendar months?**
6. **Is the portal the only accepted channel? Does a provider need its own portal account, and can it attach its own report PDF?**
7. **Are there current filing or late fees under Section 10, and who is billed?**
8. **What is the renewal deadline for contracts, and what is the procedure behind the $100 transfer fee?**
9. **Are there lab tests beyond TCEQ's, for example for commercial systems?**
10. **Does SJRA acknowledge filings beyond the portal's confirmation, and how does it report a rejected filing?**
11. **Does SJRA accept a typed electronic signature for the required "printed name and signature"?**
12. **Which phone should providers use: 936-588-3111 or the Lake Conroe Division line 936-588-1111?**

## Evidence gaps and conflicts

- **Order number.** "384053.4" on SJRA's PDFs is a repeating document footer, not the order number (Codex checked the originals for Justin; PDF p. 3, read as an image). The signed 2015/01 copy's handwritten number on PDF p. 1 reads "2015-O-04" or "2015-0-04"; the middle character can't be told apart from a zero, so both readings are recorded and neither is chosen. The 2015/03 copy linked elsewhere is unsigned, with blank order-number and signature lines, so it isn't used.
- **Frequency and deadline confirmed.** Codex confirmed against the original text that secondary treatment is inspected "at least once every four calendar months" and the report is filed within fourteen calendar days. The County thread's re-read returned the same four-month sentence.
- **Section 7(a)(10)(D) settled by reading the page.** PDF p. 6 (printed -4-) shows both earlier reads were right: (D) opens with the general sentence and then lists nine items, (i) the inspection date to (ix) the provider's physical address, business address, business phone and emergency phone "if applicable". The list applies to all inspection and maintenance reports, not only single-family systems. (E) lists the contract fields.
- SJRA's web pages were read through a page summarizer; curl to sjra.net is refused by the proxy. The order itself was read as page images for v2.
- The OSSF Data Viewer is a script-rendered map and couldn't be read. TCEQ's authorized-agent search was blocked.
- The fee schedule is dated 08-20-15 and the payments page says rates were adopted 2010-09-01. Both may be stale.

## Identity

- key: `tx-sjra-ossf`, ruleset v2 (`type: "river_authority"`; v1 kept as published; v2 applies from the same day, 2026-10-06)
- state: TX
- authority: San Jacinto River Authority, Lake Conroe Division, On-Site Sewage Facilities
- requirement in effect: the order was passed 2015-12-10 and takes effect "as of and after June 1, 2016, subject only to the prior approval of this Order by the TCEQ". The approval date isn't given (question 1), so `requirementEffective.date` is null. Aerowise applies the ruleset from 2026-10-06. SJRA inspections and contracts dated earlier are held for review.
- source links (all read 2026-10-06):
  - Order, signed copy (2015/01): https://www.sjra.net/wp-content/uploads/2015/01/Order-Adopting-Rules-for-On-Site-Sewage-Facilities-Within-2075-feet-of-Lake-Conroe-Texas_121015.pdf.pdf
  - Maintaining My OSSF: https://www.sjra.net/lakeconroe/maintaining-my-ossf/
  - Portal help, inspection reports (KA-01056): https://customerportal.sjra.net/helpfulresources/article/KA-01056/en-us
  - Portal help, contracts (KA-01057): https://customerportal.sjra.net/helpfulresources/article/KA-01057/en-us
  - Permitting My On Site Septic Facility: https://www.sjra.net/lakeconroe/licensing-permitting/permitting-my-on-site-septic-facility/
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

"The Rules shall apply to all the area lying within 2,075 feet of Lake Conroe", except areas under a predecessor rule or inside a municipality's corporate limits (Order Section 5, PDF p. 4, printed -2-). v2's assignment text says so. The order names no counties. `counties: ["Montgomery"]` only triggers review, and Walker isn't listed until SJRA confirms (question 4). `assignment: "reviewed"`: the office looks the address up on SJRA's OSSF Data Viewer or calls SJRA, and records what it checked. A Montgomery site matched by county alone lists both Montgomery County and SJRA.

## Service frequency

Every four calendar months (Order Section 7(a)(10)(A)), with no electronic-monitoring exception, so there's no 6-month schedule (question 5).

## Lab tests

None published by SJRA (question 9).

## Filing deadline

Fourteen calendar days after the inspection (Order Section 7(a)(10)(A)), warning 5 days before.

## Required inspection fields

Section 7(a)(10)(D) (PDF p. 6, printed -4-), on every report:
- (i) inspection date, (v) permit number, (vi) the provider's TCEQ license number, (vii) the OSSF's address, (viii) printed name and signature: already on every authority copy
- (ii) date of the preceding inspection: printed on every authority copy as "Previous inspection", the site's last completed inspection in Aerowise or "None on record in Aerowise" (question 2)
- (iii) unauthorized alterations: `unauthorized_alterations` required (None found, or Found with a description)
- (iv) spray area condition, if applicable: `spray_area` required (Acceptable, Needs attention with a description, or Not a spray system)
- (ix) the provider's addresses, business phone and emergency phone: the company's address and phone, and its emergency phone when entered (Settings → Company). Aerowise has one company address.

## Required attachments/photos

None published.

## Required report/form

SJRA's portal form ("OSSF Inspection"), with every field marked by a red asterisk. The field list is visible only inside the portal.

## Submission method

`manual_export` with `portalUrl` https://customerportal.sjra.net/. The office enters the report on the portal and records it in Aerowise with **Mark as filed** (`POST /filings/:id/mark-sent`).

## Destination / portal

https://customerportal.sjra.net/ (OSSF Inspection, help article KA-01056). Contracts go in as a case, Case Type "Contract" (KA-01057). No OSSF email is published.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

The portal shows a confirmation and a dashboard after submission. No other acknowledgment is published.

## Contract requirements

An initial two-year contract signed by the installer and the homeowner is needed for a permit. Renewals go on the portal as a "Contract" case. SJRA publishes no renewal timing, so Aerowise uses 30 days before the current contract expires (30 TAC 285.7(d)(2)) and the office uploads them by hand.

## Exceptions

An owner may maintain their own system only for a single-family primary residence and only with a listed qualification (Order Section 7(a)(4)). Such owners must still submit every report and test to SJRA (Section 7(a)(10)(B)).

## Test fixtures

`apps/api/test/sjra.test.ts` covers these cases:
- a valid inspection: due 14 days later, next visit in 4 months, ready for the office to enter on the portal (never mailed), then marked as filed
- a missing chlorine residual, which keeps the inspection a draft
- 4 months between visits even with monitoring on record
- a Montgomery site matched by county alone, which lists both authorities
- v2: alterations and spray area required, with details when something is found
- v2: the authority copy's previous-inspection date, alterations answer and emergency phone, none of which the customer copy carries

## Verification

Draft. To verify, follow TEMPLATE.md once SJRA confirms the order number, its acceptance of Aerowise's report for the Section 7(a)(10)(D) fields, and the portal as its channel.
