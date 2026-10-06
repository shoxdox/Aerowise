# Grimes County research review

Research date: October 6, 2026. Public evidence review; authority confirmation and production acceptance remain pending. PDF page references below are physical pages in the saved file, not embedded court-record pagination.

## G1: A newer adopted local order was recovered

Disposition: **partial**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The official August 21, 2024 court record includes a certified adopted OSSF order and a passed adoption motion. Its effective clause requires TCEQ approval. The July 29, 2024 TCEQ attachment is a notice to proceed on a proposed draft, not final authorization after adoption.

Proposed action: Replace the newspaper-only/2023/order-not-found claim. Request the final TCEQ approval before asserting an effective date or deciding which historical records the 2024 requirements cover.

- [2024 OSSF ORDER](../sources/grimes-2024-order.pdf) — PDF pp. 1, 6–7; [official source](https://grimescountytx.granicus.com/MetaViewer.php?clip_id=272&meta_id=23091&view_id=1)
- [August 21 2024 adoption minutes](../sources/grimes-adoption-minutes.html) — August 21, 2024 adoption motion; [official source](https://grimescountytx.granicus.com/MinutesViewer.php?clip_id=272&doc_id=e49df8a5-649c-11ef-9b71-005056a89546&view_id=1)
- [TCEQ notice to proceed July 29 2024](../sources/grimes-tceq-notice.pdf) — PDF p. 1; [official source](https://grimescountytx.granicus.com/MetaViewer.php?clip_id=272&meta_id=22568&view_id=1)

## G2: The adopted order says four months and adds pH/sludge

Disposition: **implementation_gap**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

Section 9.C.1 requires maintenance/testing/reporting at least every four months, with reports submitted to the Designated Representative, including pump-tank sludge levels and pH and spray-area condition. No six-month monitoring exception appears in this local provision. Final approval/effective-date evidence remains incomplete.

Proposed action: Flag the draft six-month fallback and missing fields for review. Do not auto-pass a six-month schedule based solely on state monitoring guidance. Preserve the effective-date uncertainty; do not invent pH units or pass/fail thresholds.

- [2024 OSSF ORDER](../sources/grimes-2024-order.pdf) — PDF pp. 4–5, §9.C.1; [official source](https://grimescountytx.granicus.com/MetaViewer.php?clip_id=272&meta_id=23091&view_id=1)

## G3: Homeowner qualification is not wholly unknown

Disposition: **partial**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

Section 9.B describes homeowner eligibility through licensing/registration or TEEX training and evidence to the Designated Representative, with loss of eligibility for failures/falsification/violations. This is more specific than the draft claim that no qualification rule was published.

Proposed action: Attach the actual eligibility provision to the draft, subject to the missing final approval and any later amendments. Provider approval/registration workflow still needs clarification.

- [2024 OSSF ORDER](../sources/grimes-2024-order.pdf) — PDF p. 4, §9.B; [official source](https://grimescountytx.granicus.com/MetaViewer.php?clip_id=272&meta_id=23091&view_id=1)

## G4: The affidavit renewal sentence is now complete

Disposition: **partial**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The original 2024 affidavit calls for continuous maintenance and a signed contract submitted within 30 days after property transfer, upon renewal, or upon changing providers. The full sentence is readable; it does not settle how its timing relates to the state pre-expiration requirement.

Proposed action: Remove the summarizer-truncation blocker. Preserve the complete language and confirm renewal/provider-change timing and destination. The Microsoft form found on the county page is for complaints, not recurring maintenance filings.

- [Grimes County: Affidavit to the Public, OSSF (2024)](../sources/tx-grimes-county-source-3.pdf) — PDF p. 1; [official source](https://grimescountytexas.gov/vertical/sites/%7B958238D0-27E6-4F6C-919E-F1D98542C5FD%7D/uploads/OSSF_Affidavit_(2024).pdf)
- [Grimes County: Environmental Permits](../sources/tx-grimes-county-source-1.html) — Environmental Permits page; [official source](https://grimescountytexas.gov/permits)

## Baseline unresolved items reassessed

Numbers below refer to `profile.unresolved` array order in baseline.json; they are not the document’s separately numbered questions.

1. **partial** — County OSSF page now readable, but report/contract destination still not established. (Evidence: G4)
   Baseline: Grimes County publishes no way to submit maintenance inspection reports or contracts in anything readable; its main OSSF page is blocked to automated fetching. Inspection filings are held for review and contracts are filed by hand.

2. **partial** — 2024 adopted order recovered; final TCEQ approval/effective date still missing. (Evidence: G1)
   Baseline: Grimes County's OSSF order was not found. A local newspaper (not an official source) reports an update approved 2023-08-16 that changed aerobic reporting; until the order is read, Aerowise follows TCEQ's 30 TAC 285.7.

3. **partial** — Adopted order supplies qualifications; final approval and approval workflow remain open. (Evidence: G3)
   Baseline: The affidavit requires a contract with 'an approved maintenance company'; whether homeowners may maintain their own systems, and what makes a company approved, is not published.

4. **not_resolved** — Todd Mission/city receiving authority still requires site-specific confirmation. (Evidence: G1)
   Baseline: The City of Todd Mission requires its own septic permit on top of the county's; who receives maintenance reports for Todd Mission sites, and whether other cities run their own program, is not published. Every site needs a reviewed assignment.

5. **public_evidence** — Original affidavit and order read; summarizer truncation/scan barriers removed. (Evidence: G4)
   Baseline: The county pages and PDFs were read through a page summarizer; quotes haven't been compared with the PDFs in a browser.

6. **not_resolved** — Acknowledgment of maintenance filings not established. (Evidence: G4)
   Baseline: Grimes County publishes no acknowledgment of a received report or contract.
