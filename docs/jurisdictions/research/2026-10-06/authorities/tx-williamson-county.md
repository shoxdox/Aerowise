# Williamson County research review

Research date: October 6, 2026. Public evidence review; authority confirmation and production acceptance remain pending. PDF page references below are physical pages in the saved file, not embedded court-record pagination.

## W1: The approved order is available

Disposition: **public_evidence**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The current county copy includes final TCEQ approval issued May 7, 2021 and the adopted order. County adoption was January 12, 2021. The earlier agenda PDF omitted the approval pages.

Proposed action: Replace the missing-approval research claim. Distinguish the order effective date from when a new Aerowise ruleset is activated; do not backdate records automatically.

- [Williamson County Order 2021](../sources/williamson-order.pdf) — PDF pp. 1–2, 13; [official source](https://www.wilcotx.gov/DocumentCenter/View/3109/Williamson-County-Order-2021-PDF)

## W2: Sludge and spray-area reporting are already required

Disposition: **implementation_gap**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

Section 10.E.7 requires pump-tank sludge levels and the condition of the spray area on each required testing report. The homeowner form also supplies a sludge measurement in inches and a surface-application chlorine test.

Proposed action: Treat sludge capture/reporting as a documented implementation gap. Keep units and system applicability explicit; notes are an interim manual workaround, not proof the generated template meets the requirement.

- [Williamson County Order 2021](../sources/williamson-order.pdf) — PDF p. 10, §10.E.7; [official source](https://www.wilcotx.gov/DocumentCenter/View/3109/Williamson-County-Order-2021-PDF)
- [Homeowner Self-Maintenance Packet](../sources/williamson-homeowner.pdf) — PDF p. 4; [official source](https://www.wilcotx.gov/DocumentCenter/View/21756/Homeowner-Self-Maintenance-Packet-PDF)

## W3: Current homeowner filing instructions differ from the draft

Disposition: **partial**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The homeowner self-maintenance packet linked by the live site, updated August 21, 2026, directs reports to ossfcontracts@wilcotx.gov. It retains ossf@wilcotx.gov in the header/footer. This is specifically a homeowner packet, not express provider submission guidance.

Proposed action: Refresh the source reference. Ask whether providers use the dedicated inbox for reports and contracts; do not infer provider authorization solely from the homeowner form.

- [Homeowner Self-Maintenance Packet](../sources/williamson-homeowner.pdf) — PDF pp. 4–5; [official source](https://www.wilcotx.gov/DocumentCenter/View/21756/Homeowner-Self-Maintenance-Packet-PDF)

## W4: Deadline conflict and a future-dated footer remain

Disposition: **conflict**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The linked affidavit says reports within 10 days of testing; the homeowner packet says within 14 days of the due date. The affidavit visibly prints Updated 9/9/2028, later than this research date. Its body also says contracts 30 days before expiration or within 30 days after transfer.

Proposed action: Preserve both scoped deadlines and the date anomaly. Keeping an earlier internal target is reasonable but does not settle the legal anchor. Ask the county for current provider timing and a corrected/current affidavit.

- [Aerobic Affidavit and Recording Instructions](../sources/williamson-affidavit.pdf) — PDF pp. 1–2; [official source](https://www.wilcotx.gov/DocumentCenter/View/21923/Aerobic-Affidavit-and-Recording-Instructions-PDF)
- [Homeowner Self-Maintenance Packet](../sources/williamson-homeowner.pdf) — PDF p. 4; [official source](https://www.wilcotx.gov/DocumentCenter/View/21756/Homeowner-Self-Maintenance-Packet-PDF)
- [OSSF Care Brochure](../sources/williamson-care.pdf) — brochure contract timing; [official source](https://www.wilcotx.gov/DocumentCenter/View/3094/OSSF-Care-Brochure-PDF)

## W5: License fee is distinct from report filing

Disposition: **public_evidence**. Confidence in source reading: high. Actual authority acceptance: unconfirmed.

The posted fee schedule lists $60 for aerobic license renewal or transfer. The affidavit describes a two-year operating license and current report/contract requirements on transfer. Absence of a report fee on this schedule does not establish universal free filing.

Proposed action: Keep owner operating-license renewal, maintenance-contract renewal, and report submission as separate events. Confirm any filing fee and receipt practice for the pilot.

- [OSSF Fees](../sources/williamson-fees.pdf) — PDF p. 1; [official source](https://www.wilcotx.gov/DocumentCenter/View/16737/OSSF-Fees-PDF)
- [Aerobic Affidavit and Recording Instructions](../sources/williamson-affidavit.pdf) — PDF p. 2; [official source](https://www.wilcotx.gov/DocumentCenter/View/21923/Aerobic-Affidavit-and-Recording-Instructions-PDF)

## Baseline unresolved items reassessed

Numbers below refer to `profile.unresolved` array order in baseline.json; they are not the document’s separately numbered questions.

1. **partial** — Current dedicated inbox found in homeowner packet; provider channel still unconfirmed. (Evidence: W3)
   Baseline: The county publishes a reporting address (ossf@wilcotx.gov) only in its packet for homeowners who maintain their own system. Whether maintenance providers send reports to the same address, or through MyGovernment Online, is not stated.

2. **conflict** — Both different anchors remain; current affidavit also has a future-dated footer. (Evidence: W4)
   Baseline: Report deadline: the 2026 affidavit says within 10 days of testing; the homeowner packet says within 14 days of the due date; TCEQ says 14 days after the test. Aerowise uses 10 days, the strictest.

3. **conflict** — Affidavit supports pre-expiration target; brochure wording does not resolve all timing. (Evidence: W4)
   Baseline: Contract timing: the affidavit says 30 days before the previous contract expires; the care brochure says 'within 30 days of expiration'. Aerowise uses 30 days before.

4. **implementation_gap** — Already required by the approved order; adding the field is a product task. (Evidence: W2)
   Baseline: The order requires sludge levels in the pump tank on each report (Section 10.E.7). Aerowise's built-in inspection form has no sludge-level field, so this is not checked; record it in the notes until the form has one.

5. **implementation_gap** — Current form confirms surface-application applicability and sludge units. (Evidence: W2)
   Baseline: The county's form asks for a chlorine grab sample for surface application systems. Aerowise does not record whether a system disperses on the surface, so the chlorine reading is not required here.

6. **partial** — Order establishes exclusions, but actual Austin/site assignment still needs permit evidence. (Evidence: W1)
   Baseline: Which addresses inside Williamson County fall under the City of Austin (and so not this office) is not published as a list; every site needs a reviewed assignment.

7. **public_evidence** — Final TCEQ approval recovered; prior scan/summarizer barrier removed. (Evidence: W1)
   Baseline: The order's effective date (its TCEQ approval) is not shown on the copy read, which was also read through a page summarizer; Williamson inspections and contracts dated before 2026-10-06 are held for review.

8. **not_resolved** — Commercial lab/schedule applicability still requires state/permit-specific review. (Evidence: W2)
   Baseline: No lab testing (BOD, TSS) or commercial-specific schedule is published, so none is required here.

9. **not_resolved** — A received/accepted report acknowledgment was not established. (Evidence: W5)
   Baseline: Williamson County publishes no acknowledgment of a received report or contract.
