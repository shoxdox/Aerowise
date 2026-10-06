# Hays County research review

Research date: October 6, 2026. Public evidence review; authority confirmation and production acceptance remain pending. PDF page references below are physical pages in the saved file, not embedded court-record pagination.

## H1: Approval date is present in the original

Disposition: **public_evidence**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The official regulations include final TCEQ approval issued February 18, 2014; county adoption was June 4, 2013.

Proposed action: Replace the missing-effective-date research claim, while preserving a distinct application activation date and checking for later amendments.

- [Hays OSSF regulations](../sources/hays-regulations.pdf) — PDF pp. 1–2; [official source](https://www.hayscountytx.gov/DocumentCenter/View/1893/Hays-County-On-Site-Sewage-Facility-Regulations-PDF)

## H2: Contract-based timing needs implementation

Disposition: **implementation_gap**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

Section 10.V.2 requires tests/reports every four months unless the permit specifies otherwise. First testing and report submittal are within 14 days of contract start, later dates derive from that start, and the last testing/reporting is within 14 days of contract end. Changing providers requires a renewal term of at least one year and four inspections including the initial inspection.

Proposed action: Do not model Hays as only last-visit-plus-four-months. Review first/last windows, provider changes and permit overrides. Disable an unconditional six-month assumption in a proposed new version until its permit/local basis is established.

- [Hays OSSF regulations](../sources/hays-regulations.pdf) — PDF p. 19, §10.V.2; [official source](https://www.hayscountytx.gov/DocumentCenter/View/1893/Hays-County-On-Site-Sewage-Facility-Regulations-PDF)

## H3: Provider registration and renewal prerequisites are documented

Disposition: **implementation_gap**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

Section 10.V.3 makes county provider registration annual, expiring December 31, with next-year renewals accepted no earlier than December 1 and no registration fee. Contracts are accepted only from current providers in good standing. Section 10.V.6 prevents same-provider renewal acceptance until all prior-period reports have been submitted.

Proposed action: Track county registration separately from state credentials, and flag prior report completeness before renewal. Do not imply a TCEQ license alone satisfies this county prerequisite.

- [Hays OSSF regulations](../sources/hays-regulations.pdf) — PDF pp. 19–20, §10.V.3 and V.6; [official source](https://www.hayscountytx.gov/DocumentCenter/View/1893/Hays-County-On-Site-Sewage-Facility-Regulations-PDF)

## H4: Corrective reports have their own clock

Disposition: **implementation_gap**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

Section 10.V.4 requires correction, retesting and another report to the owner and county within ten days of the previous report when chlorine is inadequate or the system is malfunctioning. Extra reports must not postpone the regular maintenance schedule.

Proposed action: Represent a corrective retest/report separately from normal scheduling. Preserve the source wording previous report; do not silently anchor it to a visit or reset the ordinary due date.

- [Hays OSSF regulations](../sources/hays-regulations.pdf) — PDF p. 19, §10.V.4; [official source](https://www.hayscountytx.gov/DocumentCenter/View/1893/Hays-County-On-Site-Sewage-Facility-Regulations-PDF)

## H5: Maintenance contact found; channel acceptance still needs confirmation

Disposition: **partial**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The live Development Services contact page publishes ossfmaintenance@hayscountytx.gov for OSSF maintenance inquiries, phone 512-393-2150 option 0. The 2026 fee schedule says applications/documents are handled online through MGO. Neither establishes that all recurring reports/contracts may be emailed.

Proposed action: Use the dedicated inquiry contact to confirm report/contract destinations, approved format and receipt. Do not enable email dispatch from an inquiry label.

- [Hays maintenance inquiry contact (browser excerpt)](../sources/hays-contact-browser-excerpt.txt) — Permit Administration; [official source](https://www.hayscountytx.gov/863/Contact-Us)
- [2026 Development Services Fee Schedule](../sources/hays-fees.pdf) — PDF p. 1, heading; [official source](https://www.hayscountytx.gov/DocumentCenter/View/4797)

## H6: A maintenance-contract late fee is published

Disposition: **public_evidence**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The January 1, 2026 fee schedule lists a $50 OSSF maintenance contract late fee. It separately lists $600/$900 OSSF renewal with a designer no-change letter; that entry must not be treated as a routine maintenance-contract renewal charge. The exact late-fee trigger was not established.

Proposed action: Add the late-fee source to the research draft and confirm its trigger. Keep permit fees separate. Commercial/institutional/non-residential systems also require a flow meter under §10.W.6.

- [2026 Development Services Fee Schedule](../sources/hays-fees.pdf) — PDF p. 1; [official source](https://www.hayscountytx.gov/DocumentCenter/View/4797)
- [Hays OSSF regulations](../sources/hays-regulations.pdf) — PDF p. 20, §10.W.6; [official source](https://www.hayscountytx.gov/DocumentCenter/View/1893/Hays-County-On-Site-Sewage-Facility-Regulations-PDF)

## Baseline unresolved items reassessed

Numbers below refer to `profile.unresolved` array order in baseline.json; they are not the document’s separately numbered questions.

1. **partial** — Dedicated maintenance inquiry address found; explicit report/contract filing authorization still needed. (Evidence: H5)
   Baseline: Hays County publishes no way to submit maintenance inspection reports or contracts (no email, portal or mailing address for them), so inspection filings are held for review and contracts are filed by hand.

2. **not_resolved** — Actual address/city authority still requires permit and assignment evidence. (Evidence: H1)
   Baseline: Which addresses Hays County covers is set by other entities' orders, ordinances or resolutions, which the county does not list; every site needs a reviewed assignment.

3. **implementation_gap** — Contract-start timing is documented; existing generic scheduling needs review. (Evidence: H2)
   Baseline: Hays County counts report due dates from the contract's start (first report within 14 days of it) and allows a permit to set another schedule. Aerowise counts 4 months from the last visit and 14 days from the inspection.

4. **implementation_gap** — Ten-day corrective report/retest obligation read, separate from the regular schedule. (Evidence: H4)
   Baseline: A report showing low chlorine needs a re-test and a new report within ten days. Aerowise does not schedule that re-test; the office books it.

5. **partial** — Local text says four months unless permit specifies otherwise; blanket six-month fallback is unsupported. (Evidence: H2)
   Baseline: Hays County's order does not say whether electronic monitoring allows six months between visits; Aerowise follows TCEQ's 30 TAC 285.7(e).

6. **public_evidence** — Final TCEQ approval recovered. (Evidence: H1)
   Baseline: The order's approval and effective dates were read through a summarizer and are not confirmed.

7. **partial** — 2026 schedule confirms a $50 maintenance-contract late fee; exact trigger, report format and receipt remain open. (Evidence: H6)
   Baseline: Hays County publishes no list of what a maintenance report must contain beyond 30 TAC 285.91(12), no acknowledgment of a received report, and no report or contract filing fee here (the fee schedule was not read).

8. **implementation_gap** — Commercial flow-meter obligation documented; lab/permit conditions remain a separate review. (Evidence: H6)
   Baseline: No lab testing (BOD, TSS) is published, so none is required here. Commercial systems need flow meters, which Aerowise does not record.
