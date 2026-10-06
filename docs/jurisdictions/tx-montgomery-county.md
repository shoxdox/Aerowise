# Montgomery County Environmental Health Services, OSSF (`tx-montgomery-county`): draft profile

Status: **draft**. v1 was written 2026-10-06 from county PDFs on its file host, because mctx.org could not be read then. v2 (W12.C5, same day) adds the county's approved order, its live OSSF and forms pages, its two current initial contract forms and its fee schedule, from [the 2026-10-06 research packet](research/2026-10-06/authorities/tx-montgomery-county.md) (findings M1 to M6). Montgomery inspection filings are held for review and never sent, and contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. The county's OSSF supervisor, Keith Miles (keith.miles@mctx.org, 936-539-7839), can answer them. For lake parcels, call SJRA at 936-588-3111.

1. **Where should providers send the 4-month aerobic reports and renewal contracts?** No channel is published. mc.maint@mctx.org is for open records requests and HealthComplaints@mctx.org for complaints; neither is used. This is the blocker for sending.
2. **Does the food establishment initial contract (revised 2009-11-25, still linked) still control, so food establishments get a visit every month for the first two years?**
3. **What interval applies after the initial two years, for food establishments and everyone else, and does electronic monitoring allow longer?**
4. **For commercial and multifamily systems, what BOD and TSS limits apply, when is the annual sample due, and with which report does it go?**
5. **Which cities have their own program or an intergovernmental contract with the county (order section 6)? How is SJRA's 2,075 feet measured?**
6. **Can the $200 septic non-compliance administrative fee apply to a late report or contract?**
7. **Does the county acknowledge reports or contracts?**

## Identity

- key: `tx-montgomery-county`, ruleset v2 (v1 kept as published; v2 applies from the same day, 2026-10-06)
- state: TX
- authority: Montgomery County Environmental Health Services, On-Site Sewage Facilities
- requirement in effect (the legal date): 2021-03-04, the TCEQ's final approval of the county's order, adopted 2020-12-08 (order packet PDF pp. 1-2). Later amendments were not checked.
- rule activation in Aerowise (a different thing): `effectiveFrom` 2026-10-06. It decides which ruleset new contracts and filings use; nothing earlier is backdated, and existing contracts and filings are not rewritten.
- source links (all read 2026-10-06):
  - Local order packet: https://cms1files.revize.com/montgomerycountytx/620145.pdf?t=20250424152017615 (11 pages, mostly scans read from OCR; 620145 is a file number, not the order's number)
  - OSSF page: https://www.mctx.org/departments/departments_d_-_f/environmental_health/on-site_sewer_facility.php
  - Forms page: https://www.mctx.org/departments/departments_d_-_f/environmental_health/permitting/all_forms.php
  - Current general initial contract: https://www.mctx.org/Two%20Year%20Maintenance.pdf?t=20240419143456737
  - Food establishment initial contract: https://www.mctx.org/Two%20Year%20Maintenance-food.pdf?t=20240419143407309
  - Fee schedule (2025-06-02): https://www.mctx.org/PERMITTING%20FEE%20SCHEDULE%2006.02.2025.pdf?t=20260811114110063
  - v1's sources (the older initial contract form, the permit packet, How to Obtain a Septic, SJRA's order, 30 TAC 285.7, TCEQ's maintenance page) are kept.

## Applicability

Section 6 of the order: all of Montgomery County except areas under earlier rules, incorporated cities, and cities that sign an intergovernmental contract with the county. None are named (question 5). SJRA's rules cover the area within 2,075 feet of Lake Conroe outside cities. `assignment: "reviewed"`: the office checks the site's permit and records what it checked.

## What the system serves

v2's rules differ by use, so a site records what its system serves: single-family home, multifamily, commercial or food establishment (`sites.use_category`, migration 0043). Nobody's use is guessed from the residential or commercial setting. Until a Montgomery site's use is recorded, the site page and the contract preview say so, and its filings are held with that reason.

## Service frequency

Every 4 months: "a minimum of three (3) inspections, one every four (4) months", on both the older and the current general initial contract. Neither mentions monitoring, so there's no 6-month schedule (question 3).

**Food establishments.** The county still links a separate initial contract for food establishments (revised 2009-11-25): "at least twelve inspections per year, one every month" for the first two years. v2 records it as `service.categoryTerms` (initial term 24 months, every month; renewal interval null), but never applies it by itself, because the county hasn't said whether that form still controls (question 2):

- A food establishment site with no interval recorded keeps the general 4 months. The site page, the contract preview and each filing's review reason say: "…asks for an inspection every month during the first 24 months for a food establishment. Montgomery County has not said whether that form still controls, or what applies after the first two years. Record this site's interval from its current contract or permit…". Its filings stay held until the interval is recorded.
- Once the office records the interval from the site's own current contract or permit, with where it says so (the same two site fields Hays uses), that interval sets the schedule. A monthly contract makes a 12-month plan of 3 visits need 12, and the office is asked before they are added.
- Other uses ignore a recorded interval in Montgomery County.

## Lab tests

Order 10(j): annual BOD and TSS for all commercial and multifamily OSSFs, with no limits or lab format. v2 sets `labTests.useCategories` to multifamily, commercial and food establishment (Aerowise counts a food establishment as commercial). A site with no recorded use falls back to the commercial setting, as in v1 (question 4).

## Filing deadline

"within 14 days after the date the test is performed" (both general forms and the food form, matching 30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual).

## Required attachments/photos

None published.

## Required report/form

None found (question 1).

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`.

## Destination / portal

None published. mc.maint@mctx.org (open records requests) and HealthComplaints@mctx.org (complaints) are not used.

## Customer copy requirement

Required: "submitted to the permitting authority and the owner".

## Confirmation / proof

None published (question 7).

## Contract requirements

The two-year initial contract, signed by owner and installer, is part of the permit packet "BEFORE FINAL INSPECTION". No form sets later terms. Renewal timing comes from 30 TAC 285.7(d)(2): 30 days before the current contract expires. Aerowise files them by hand.

Fees: the 2025 fee schedule lists a $200 septic non-compliance administrative fee per incident and no maintenance filing fee, so `fees` is not set (question 6).

## Exceptions

Order 10(a)(1): aerobic maintenance only by a Certified Maintenance Provider (TCEQ and county status).

## Test fixtures

`apps/api/test/montgomery.test.ts` covers these cases:
- v2 reads as written and replaces v1 from 2026-10-06; v1 is unchanged
- a valid inspection: due 14 days later, next visit in 4 months, held for review and never sent
- a missing chlorine residual, which keeps the inspection a draft
- 4 months between visits even with monitoring on record
- a Montgomery site never matched by county alone
- a food establishment with no recorded interval: 3 visits, 4 months, the reason on the preview, the site and the held filing
- a food establishment with a recorded monthly interval: 12 visits after the office agrees, next visit a month out
- no recorded use: the site and preview ask for it; a single-family site ignores a recorded interval
- annual BOD and TSS for multifamily, commercial and food establishment sites, by recorded use

`packages/domain/src/filings.test.ts` covers `categoryTermFor`, `siteScheduleProblem` and `labTestRequirement` by use.

## Verification

Draft. To verify, follow TEMPLATE.md once the county names its submission channel and answers questions 2 to 4.
