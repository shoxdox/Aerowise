# Aerowise — pilot worksheet and acceptance questions

Current at the October 6, 2026 post-build handoff. Prepared only; no call/email sent. Pilot provider and authority: **not selected**. This worksheet supersedes the pre-build research queue for next actions; the original queue remains a dated source record.

## Justin's three answers

1. Provider/design partner and contact who can supply samples: __________
2. Actual permitting authority shown on the sample permits: __________
3. Desired date for a controlled demo review: __________

If the authority is unknown, start with the permits rather than guessing from the county name. First scope: one provider, one office user, one technician, roughly 10–20 sites, in parallel with the current process.

## Obtain from the provider before contacting the authority

For two or three representative sites initially, request a current permit, system/dispersal type and special conditions; signed maintenance contract with start/end dates and any interval; a previously accepted report and acknowledgment; state licenses and county registration/good-standing evidence. Include a commercial or food site only if it is genuinely in the first pilot. Later, obtain a redacted customer/site export and last-inspection dates for the small trial.

Redact unnecessary homeowner/contact/payment data. A provider document can establish its own permit, contract, past workflow and credentials. A previously accepted report supports comparison; it does not prove blanket acceptance of a new Aerowise format or electronic signature.

AI can check the files, extract/OCR scans, identify the authority, compare schedule/fields, assemble one sample PDF and draft a short question. Justin/provider approves any disclosure of real records and any contact.

## Shared authority acceptance question

After the sample has been reviewed: "For these permit types, may our licensed provider submit the attached sample instead of your form? Are the signature method and fields acceptable? Where do inspection reports and renewal/provider-change contracts each go? What naming/attachments are required, and what receipt or acknowledgment should we retain?"

Capture the contact identity, role, date, exact question/answer, channel and evidence. Separate report destination, contract destination, format, signature and acknowledgment. A published email destination is evidence for that destination; it does not settle all five questions. A verbal answer must be recorded with its scope, and written confirmation is preferable where a conflict matters.

## Authority-specific unresolved questions — ask only if in pilot scope

- **Williamson:** conflicting report deadline anchors and future-dated affidavit; provider use of the dedicated contract inbox/MGO; permit-specific commercial conditions. Sludge reporting itself is already source-backed and implemented.
- **Hays:** recurring report/contract destinations; practical contract-end window and any permit interval exception; $50 late-fee trigger and current registration procedure. Contract-based timing is implemented; county registration is not fully tracked per company.
- **Travis/LCRA:** actual parcel authority, residential versus commercial scope, accepted PDF/e-signature and destinations/receipt. LCRA's documented restricted zone is implemented; electronically filled/emailed LCRA form acceptance remains open.
- **Brazoria:** acceptance of our sample/signature/attachments and receipt; current provider-registration process/amendments and permit-specific lab conditions. The published maintenance inbox is already recorded; do not re-ask whether one exists.
- **Grimes:** final TCEQ approval/effective date for the adopted 2024 order, current destination/receipt and permit exceptions; measurement expectations without inventing pH thresholds.
- **Montgomery/SJRA:** exact site authority; report/contract destinations and acceptance; whether the old food-site initial form is current and post-initial/renewal interval; BOD/TSS timing/attachments and provider standing. Monthly food timing needs the site's own recorded contract/permit interval; the handwritten SJRA order identifier remains bounded by the original page evidence.
- **Comal:** accepted PDF/signature and portal receipt; city-agreement applicability to actual permits; current source for any homeowner-maintenance exception if relevant.
- **Denton:** current form/order amendments and contract destination separately from the saved report form; acceptance of our layout. The saved original was reconciled in #87; failed fresh retrieval does not mean the original was unreadable.
- **Harris:** its unpublished recurring report submission process and v2 requirements/acceptance, if a pilot permit falls under Harris OCE. No invented automated filing channel.

Use the [current jurisdiction reviews](jurisdictions/) and [dated primary-source packet](jurisdictions/research/2026-10-06/ARCHIVE.md) for citations and known conflicts. Contact details in the dated packet must be checked before use.

## What happens after an answer

Enter dated evidence in `/admin/rulesets/<key>` with the correct field and evidence type. Saving it changes no rules and verifies no authority. "Prepare next version" produces a proposal/diff; review applicability and conflicts, then publish a new immutable version through a reviewed PR. Full verification still requires the existing complete authority-confirmation record and Justin's approval.

Until the pilot establishes correct output and accepted filing, keep the provider's existing reporting/payment process. Prove the small workflow first; expand coverage/features only from what the pilot exposes.
