# Hays County Development Services, OSSF (`tx-hays-county`): draft profile

Status: **draft**. v1 was written 2026-10-06 from Hays County's regulations, affidavit and pages. v2 (W12.C2, same day) was written from the original regulations PDF and the 2026 fee schedule in [the 2026-10-06 research packet](research/2026-10-06/authorities/tx-hays-county.md) (findings H1–H6). Hays County publishes no way to submit maintenance reports, so Hays inspection filings are held for review and never sent. Contracts are filed by hand.

## Questions for Justin

Each of these is open in `profile.unresolved`. Hays County Development Services can answer them: 512-393-2150 option 0, or ossfmaintenance@hayscountytx.gov, which the county lists for maintenance inquiries.

1. **Where do maintenance providers send inspection reports and contracts?** No filing channel is published. The inquiry address above and MyGovernmentOnline (which the fee schedule names for applications and documents) are not said to take recurring reports. This is the blocker: once the county names a channel, a new ruleset version can send them.
2. **Which cities run their own OSSF program?** The order covers all of Hays County except areas under another entity's order, and names none. Until the county lists them, every Hays site needs a person to check it.
3. **Does "within 14 days of the end of the contract period" mean the 14 days before the end?** Aerowise reads it that way. Also: can one visit be both the last of a contract and the first of its renewal?
4. **Is each visit's report due by that visit's due date?** The order says report due dates are "determined from the start date of the contract". Aerowise makes a contract visit's report due by the visit's due date when that comes before 14 days after the inspection.
5. **What starts the 10-day corrective clock, and what is the "required chlorine residual"?** Aerowise counts from the date the report was sent (or the report's own date until it is sent), and flags a zero reading, a chlorine device needing service or any failed item.
6. **Section 10.V.6 holds a same-provider renewal until every report from the previous period is in, but the renewal is due before the last report can exist.** Aerowise counts only the reports due by the day of filing. Is that what the county does?
7. **When does the $50 maintenance contract late fee apply?** The 2026 fee schedule lists it without a trigger, so Aerowise charges nothing.
8. **How do providers register with the county each year (10.V.3)?** It is free and ends December 31, but the form is not published.

## Identity

- key: `tx-hays-county`, ruleset v2 (v1 kept as published; v2 applies from the same day, 2026-10-06)
- state: TX
- authority: Hays County Development Services, On-Site Sewage Facilities
- requirement in effect: 2014-02-18, the TCEQ Executive Director's approval (PDF pp. 1–2 of the county's copy, read directly). Section 17: in force from its approval and the TCEQ's. The county adopted it 2013-06-04. Later amendments were not checked. Aerowise applies the ruleset from 2026-10-06; nothing earlier is backdated.
- source links (all read 2026-10-06):
  - Hays County OSSF Regulations, with the TCEQ approval order: https://www.hayscountytx.gov/DocumentCenter/View/1893/Hays-County-On-Site-Sewage-Facility-Regulations-PDF (original PDF, 22 pages, sha256 `dc45dc3b…94fe`; Section 10.V on PDF pp. 19–20, checked by eye)
  - OSSF Maintenance Affidavit (undated): https://www.hayscountytx.gov/DocumentCenter/View/1896/On-Site-Sewage-Facility-OSSF-Maintenance-Affidavit-PDF
  - 2026 Development Services Fee Schedule: https://www.hayscountytx.gov/DocumentCenter/View/4797 (PDF p. 1)
  - Contact Us: https://www.hayscountytx.gov/863/Contact-Us (browser excerpt in the research packet)
  - Septic Permits page: https://www.hayscountytx.gov/496/Septic-Permits
  - FAQ: https://www.hayscountytx.gov/m/faq?cat=51
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

All of Hays County except areas under another order, ordinance or resolution; the permits page covers unincorporated Hays County. `assignment: "reviewed"`: the office checks the address is outside any city with its own OSSF program and records what it checked (question 2).

## Service frequency

Section 10.V.2 (PDF p. 19): tested and reported "every four (4) months unless otherwise specified on the permit". The first test and report of each contract period are due "within fourteen (14) days of the start date of the contract"; later due dates "shall be determined from the start date of the contract"; the last test and report are "within 14 days of the end of the contract period".

v2 sets `service.contractVisits`, so a Hays contract's visits count from its start, not split evenly:

| Contract | Visits | Due |
|---|---|---|
| 12 months from 2026-10-06 | 4 | 2026-10-20, 2027-02-06, 2027-06-06, and 2027-09-21 to 2027-10-05 |
| 24 months | 7 | first within 14 days, then every 4 months from the start, last in the final 14 days |

A 12-month plan of 3 visits needs 4, and the office is asked before the fourth is added. v1's six-month schedule for monitored systems is gone: the order says four months unless the permit says otherwise, and does not mention monitoring. A permit with another interval needs the office to adjust the contract.

## Corrective reports

Section 10.V.4: a report showing "less than the required chlorine residual, or ... in any other way not functioning properly" needs a fix, a retest and "another report ... within ten (10) days of the previous report". "Such extra reports shall not alter or postpone the regular maintenance schedule."

v2 sets `service.correctiveReport`. A Hays report with a zero chlorine reading, a chlorine device needing service or any failed item puts "Fix, retest and report again" in the inbox, due 10 days after the report was sent (or after the report's own date while it is unsent). The office books the retest from the inbox as an extra visit. It uses none of the contract's visits, so the regular schedule stays where it was. Its report keeps the usual 14-day deadline. The item clears once a later inspection of the site is completed. See question 5.

## Lab tests

None published. Non-residential systems need flow meters (10.W.6), which Aerowise does not record.

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before. For a contract visit, the report is due by that visit's due date if that is sooner (question 4). The first visit of a contract starting 2026-10-06, inspected 2026-10-07, has its report due 2026-10-20, not 2026-10-21.

## Required inspection fields

The order lists no report contents beyond 30 TAC 285.91(12), so Hays adds none to the template's own required fields (which include the chlorine residual).

## Required attachments/photos

None beyond the template's.

## Required report/form

No county form is published.

## Submission method

Manual. No channel is published (question 1), and `inspectionReports.submission` is `unknown`. ossfmaintenance@hayscountytx.gov is recorded as an inquiry contact only and is never used for filing.

## Destination / portal

None published.

## Customer copy requirement

Required (order Section 10.V.4; 30 TAC 285.7(e)).

## Confirmation / proof

None published.

## Contract requirements

- A new contract at least 30 days before service ceases, and on a transfer a signed contract to Development Services within 30 days (the affidavit). `contracts.submission` is `unknown`, so Aerowise holds contract filings and the office files them by hand.
- Section 10.V.6: a renewal with the same provider is not accepted until every report from the previous contract period has been submitted. v2 sets `contracts.renewalNeedsPriorReports`: a renewal's filing is held while any visit of the previous contract that was due by now has no sent report (question 6).
- Section 10.V.2: a renewal started with a different provider runs at least a year with four inspections, counting the first. v2 sets `contracts.newProviderMinimum`. A contract recorded as a renewal or replacement with no earlier contract in Aerowise may follow another provider's, so a shorter one is held with that reason.
- Section 10.K.3 lists what every contract must show: permit number, provider license, printed names and signatures, start and end dates, the system's address and phone, and the provider's physical address, business address, business phone and emergency phone.
- Fees: the 2026 schedule lists a $50 "On-Site Sewage Facility Maintenance Contract Late Fee" with no trigger (question 7), so none is set. Its $600/$900 "On-Site Sewage Facility Renewal Fee" is a permit renewal, not a maintenance contract.

Credentials: maintenance by a TCEQ-licensed maintenance provider (10.V.1); systems other than single-family homes only by licensed providers (the affidavit). Section 10.V.3: providers register with Development Services every year (valid to December 31, renewals accepted from December 1, free), and contracts are accepted only from registered providers in good standing. v2 records this as `provider.countyRegistration`. Aerowise does not yet record a company's registration, so the office checks it (question 8).

## Exceptions

An owner may maintain their own system only after passing the TCEQ Basic Maintenance Provider course or another approved course (10.V.1).

## Test fixtures

`apps/api/test/hays.test.ts` covers these cases:
- v2 reads as written and replaces v1 from 2026-10-06; v1 is unchanged
- a 12-month plan of 3 visits asks for a fourth, saying why
- first visit within 14 days of the start, later ones every 4 months from it, last in the final 14 days
- a 24-month contract counted from its own start
- the first visit's report due by that visit's due date, held for review and never sent
- 4 months between visits even with monitoring on record
- a missing chlorine residual, which keeps the inspection a draft
- a zero chlorine reading: inbox item due 10 days after the report, a retest booked as an extra visit, the contract's visits unchanged, the item cleared by the retest
- no corrective item when everything works
- a same-provider renewal held while a report from the previous contract is unsent
- a short contract that may follow another provider's, held with the year-and-four-inspections reason
- a Hays site never matched by county alone

`packages/domain/src/schedule.test.ts` covers the visit windows on their own.

## Verification

Draft. To verify, follow TEMPLATE.md once the county names its submission channel and answers questions 3 to 8.
