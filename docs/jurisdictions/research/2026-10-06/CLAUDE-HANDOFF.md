# Aerowise research handoff for Claude Projects

> Historical pre-build research snapshot at `3929897`. Supported corrections subsequently landed in #84/#87; original findings/dispositions and source bytes remain unchanged. For current status and the pilot confirmation queue, read [the current handoff](../../../DEMO-PILOT-BRIEF.md) and [pilot worksheet](../../../PILOT-CALL-SHEET.md). Earlier proposed coding tasks are superseded.

We did another public-source research pass before starting more implementation. Read this packet alongside the current repo, not as an instruction to overwrite existing rules blindly.

## Baseline

- Repository: `shoxdox/Aerowise`, main baseline `39298979ebd8cc89d9027f78b1f51fc6a313b5c2` (PR #79).
- Current inventory: 22 ruleset files, 21 real draft authorities plus the fictional demo. Refresh the older readiness brief’s counts.
- Research scope: eight authorities; this is not a completed Texas-wide compliance review.
- Existing application/published rules were not edited. No county contact, sample submission or production acceptance occurred.
- Keep source evidence, proposed implementation and authority verification separate. Follow the existing jurisdiction template’s verification requirements; do not mark a profile verified because we downloaded an order.

## Evidence to use

Read [README](README.md), [remaining questions](remaining-questions.md), and the eight `authorities/*.md` files. The [manifest](source-manifest.json) maps official URLs to downloaded originals and hashes. [findings.json](findings.json) records 34 findings with source/page references, proposed actions and explicit unimplemented/unconfirmed flags. [question-dispositions.json](question-dispositions.json) reassesses all 56 baseline unresolved-array items in original order.

Use original PDFs for decisive dates and requirements. OCR/text files aid searching and are not substitutes for checking the relevant image. Do not treat preliminary TCEQ permission-to-proceed letters as final approvals. Do not treat a retrieval date or activation date as a legal effective date. A footer/file ID is not an order number.

## Proposed implementation priorities, subject to repo inspection

1. **Hays scheduling:** implement contract-based first/subsequent/last events, provider-change requirements, separate corrective retests/reports, county provider registration and prior-report completeness. Keep the ordinary schedule unchanged after corrective visits. Source: H2–H4. The local rule is four months unless the permit specifies otherwise; do not auto-allow six months solely on monitoring.
2. **Required report data:** review pump-tank sludge and applicable spray-area condition for Williamson, sludge/pH for Grimes, and unauthorized alterations plus provider emergency contact/addresses for Travis. Some gaps are already documented in v1. Preserve measurement units/applicability; do not invent pH thresholds. Source: W2, G2, T1.
3. **Jurisdiction evidence:** correct the draft’s 1,000-foot Lake Travis claim using the county/LCRA evidence. Keep parcel assignment reviewed. Use actual permit authority and relevant city agreements; city/county names do not prove applicability. Source: T2, C2, B2, M5.
4. **Montgomery categories:** annual commercial/multifamily BOD/TSS has local-order support. The linked commercial-food initial contract requires monthly visits; general initial contracts say every four months. Model use category and initial versus renewal periods separately after confirming the old food form/current permit. Source: M2, M3, M6.
5. **Sources/dates/contacts:** replace claims that Comal/Brazoria/Montgomery orders cannot be read or found. Record the established order approval dates with their sources. Grimes final approval is still missing. Brazoria’s report/contract email is explicit; Hays’s address is only an inquiry contact and Montgomery’s `mc.maint` address is explicitly for record requests in the material read. Source: W1, C1, H1, B1–B3, G1, M1/M4.
6. **Fees and exceptions:** Hays publishes a $50 maintenance-contract late fee. Confirm the trigger. Separate permit/license renewal from maintenance-contract renewal. Do not use absence of a fee in a schedule as proof all filings are free. Keep the Comal homeowner no-report claim unconfirmed until supported by a current source.

Inspect the actual implementation before assigning tickets. These are research-backed priorities, not a complete code audit. Preserve immutable versions/history; prepare new draft versions rather than silently rewriting historical applicability.

## Meaningful validation when implementation is authorized

- Hays: contract begins between ordinary visits; first/last windows; provider change; corrective report within ten days of previous report without postponing routine events; registration expiration; missing prior reports at renewal.
- Required fields: generate the actual report PDF, check required values/units/signatures in the rendered output, and test both applicable and inapplicable surface-dispersal cases.
- Montgomery: food versus general initial contracts; initial versus renewal term; commercial/multifamily annual lab evidence. No blanket six-month override.
- Assignment: a Lake Travis site between the draft’s old and documented boundaries must not be automatically assigned to Travis; city agreements still require permit/address review.
- Filing: distinguish draft/exported/submitted/received/accepted. Email delivery or a portal upload is not county acceptance. Retain the exact submitted document and acknowledgment when obtained.

## What still needs outside evidence

Get actual provider artifacts before making every county call. A current permit, signed contract and previously accepted report may answer several practical questions at once. For the selected pilot county, ask only for the remaining filing/format/signature/receipt questions, scope exceptions and any unresolved amendment/approval dates. The county-specific queue is in [remaining-questions.md](remaining-questions.md).

Denton retrieval was rate-limited/challenged and stopped; do not describe its prior form/order as freshly verified. Williamson’s linked affidavit has a future-dated footer and conflicting deadline anchors; preserve that conflict. Grimes’s 2024 adoption is established, but final TCEQ approval was not recovered.

The right near-term outcome is a correct, reviewed workflow for one provider’s real sites and accepted reporting—not a claim that 21 draft profiles are production-ready because their tests pass.
