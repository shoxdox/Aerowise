# Catalog staging evidence — October 8, 2026

Application c004148e9b23f3c2d01cbc9f79f7a57c7827c303. DEMO_MODE=true; work_orders,service_items enabled; no live overrides, Twilio or Resend. Only fictional records used.

- [Claude overview](claude-workers-running.png): four Working, zero Waiting on you, 10:03 local snapshot. Their old thread titles persist; current assignments cover integration, estimate corrections/deposits and plan follow-ups.
- [Catalog](catalog.png): three seeded items plus TEST hourly labor, $100/hour.
- [Completed work](work-completed.png): synthetic 1.5-hour repair, $150, office completion reason.
- [Edited invoice after reload](fractional-invoice.png): 1.5 hours at $110, $165; saved TEST memo.
- [Voided issued invoice](invoice-void.png): INV-1004, $165, TEST reason, not emailed.
- [Replacement draft](replacement-draft.png): 1.5 hours at original work price $100, $150.

Read-only database verification: work remains completed; its void invoice has total 16500 / quantity_milli 1500 / line amount 16500; its sole live draft has total 15000 / quantity_milli 1500 / line amount 15000.

Final scratch restore: db-20261008T150217Z.dump, 79 tables / 3,283 rows / 22 organizations, migration 0052_service_items.sql, 71 files read back. All table counts matched. Backups local only; no live restore.

This is a bounded catalog release check. The full Fieldbase expansion, final combined walkthrough, physical-phone capture, live browser QuickBooks mapping and real-provider validation are not complete.
