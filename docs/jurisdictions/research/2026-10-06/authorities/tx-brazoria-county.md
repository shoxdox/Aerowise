# Brazoria County research review

Research date: October 6, 2026. Public evidence review; authority confirmation and production acceptance remain pending. PDF page references below are physical pages in the saved file, not embedded court-record pagination.

## B1: Maintenance report and contract email destination is explicit

Disposition: **public_evidence**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The live Environmental Health Contact Us page expressly directs maintenance contracts and reports to ehmaintenance@brazoriacountytx.gov. The email link itself is malformed (mailto: with no address), but the rendered address is visible and explicit. Phone is 979-864-1600.

Proposed action: Replace the no-published-channel claim with this public destination evidence. Report format, signature acceptance and an accepted receipt still require a reviewed sample/confirmation before production dispatch.

- [Brazoria explicit filing instructions (browser excerpt)](../sources/brazoria-contact-browser-excerpt.txt) — OSSF Maintenance section; [official source](https://www.brazoriacountytx.gov/departments/environmental-health/contact-us)

## B2: Approved county order and scope recovered

Disposition: **public_evidence**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The order linked by the live regulations page includes county adoption June 10, 2010 and final TCEQ approval June 30, 2010. Section 6 excludes incorporated cities and areas regulated under an existing rule. Sections 8–9 adopt TCEQ rules and future amendments.

Proposed action: Remove the unreadable-order/unknown-date blocker. Confirm later amendments and actual permit authority for pilot sites; a historical statewide permit-count report is not a current city coverage list.

- [Brazoria OSSF Regulations (current county link)](../sources/brazoria-order.pdf) — PDF pp. 1–2, 6, 12; [official source](https://www.brazoriacountytx.gov/home/showpublisheddocument/1190/635938334219200000)

## B3: County provider registration is required and free in the order

Disposition: **implementation_gap**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

Section 10(b) requires TCEQ credentials plus registration with the county Environmental Health Department before installer/provider activity. The order prescribes an in-person standard form with evidence of current credentials, no registration fee, current registration information, and restrictions when suspended/revoked. Homeowners are exempt from this registration requirement, not from all maintenance conditions.

Proposed action: Track county registration/good standing. Confirm whether an online/email process now replaces the printed in-person procedure. Do not ask whether registration exists as if wholly unknown.

- [Brazoria OSSF Regulations (current county link)](../sources/brazoria-order.pdf) — PDF p. 7, §10(b); [official source](https://www.brazoriacountytx.gov/home/showpublisheddocument/1190/635938334219200000)

## B4: Homeowner qualifications and repair response are documented

Disposition: **public_evidence**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

Section 10(g) requires qualifying homeowner training or specified licensing/manufacturer certification, with historical exceptions and loss conditions. It also requires an owner to initiate malfunction repair within ten days after Designated Representative notification. Section 10(f) concerns the recorded affidavit.

Proposed action: Do not encode a blanket homeowner exemption or confuse repair initiation with report submission timing. County report format, commercial lab details, filing fees and acknowledgments remain separate questions.

- [Brazoria OSSF Regulations (current county link)](../sources/brazoria-order.pdf) — PDF p. 10, §10(f)–(g); [official source](https://www.brazoriacountytx.gov/home/showpublisheddocument/1190/635938334219200000)

## B5: Fee evidence has limits

Disposition: **partial**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The linked fee schedule lists OSSF permit/reinspection charges, and the order has a general collection clause covering multiple fee types. No routine maintenance report/contract filing amount was identified in the retrieved schedule. This does not prove no maintenance-related fee can apply.

Proposed action: Ask a specific fee/late-fee question rather than setting a zero charge on absence alone.

- [Brazoria fee schedule (current county link)](../sources/brazoria-fees.doc) — derived text, OSSF section; [official source](https://www.brazoriacountytx.gov/home/showpublisheddocument/13662/637686168999830000)
- [Brazoria OSSF Regulations (current county link)](../sources/brazoria-order.pdf) — PDF p. 11, §12; [official source](https://www.brazoriacountytx.gov/home/showpublisheddocument/1190/635938334219200000)

## Baseline unresolved items reassessed

Numbers below refer to `profile.unresolved` array order in baseline.json; they are not the document’s separately numbered questions.

1. **public_evidence** — County expressly publishes email for maintenance contracts and reports. (Evidence: B1)
   Baseline: Brazoria County publishes no confirmed way to submit maintenance inspection reports or contracts. An ehmaintenance@brazoriacountytx.gov address is reported elsewhere but was not read on any official page (the Contact Us page returned 403), so it is not used: inspection filings are held for review and contracts are filed by hand.

2. **partial** — Approved local order and fee schedule recovered; exact report/lab practices and fee triggers remain open. (Evidence: B2)
   Baseline: The county's regulations, fee schedule, contact page and OSSF brochure returned 403. Any county-specific frequency, deadline, report contents, lab tests, fees and dates are unknown; Aerowise follows TCEQ's 30 TAC 285.7.

3. **implementation_gap** — County registration process and no registration fee are documented; current operational procedure still needs confirmation. (Evidence: B3)
   Baseline: Maintenance providers 'must be registered with the County'; what registration involves is not published, and Aerowise does not track it.

4. **partial** — Order supplies city exclusion; actual authority assignment still needs site permit/evidence. (Evidence: B2)
   Baseline: Brookside Village, Manvel and Surfside Beach are separate TCEQ authorized agents, and Pearland's procedure points to TCEQ Region 12. Other cities and ETJs are not published. Every site needs a reviewed assignment.

5. **public_evidence** — Official contact page establishes Environmental Health phone 979-864-1600. (Evidence: B1)
   Baseline: No phone number for Brazoria County Environmental Health was read.

6. **not_resolved** — County acknowledgment/accepted receipt not established. (Evidence: B1)
   Baseline: Brazoria County publishes no acknowledgment of a received report or contract.
