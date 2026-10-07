# Fixed staging build — October 6 local / October 7 UTC, 2026

Application source: `5e491a0386fef627ebdaac9d8214c8ae5e7578b1`. PRs #93–96 merged, followed by the worker-story race fix `48b1d89` and technician in-flight sync fix `5e491a0`. Final documentation deployment uses the same application source.

Desktop Chromium: 1440×1000. Technician Chromium: 390×844, service workers enabled, synthetic geolocation and fixture photos. Separate browser contexts are used for public owner, platform admin and private prospect entry. This is not physical-device validation.

Marketing, owner, office, phone and account screenshots were repeated after the two follow-up fixes. Admin creation, conversion, end and ruleset evidence were exercised on the merged build; persistence, private entry, cache cleanup, clean call sheet and runtime were checked on the final source. `09a` records the seed race before its correction. Early phone-count files are kept outside this committed folder; only the successful final exactly-once results are included.

- [Two-reseed comparison](reseed-verification.json): active prospect rows, people, links, sessions and file hashes unchanged; trial retains zero customers/sites/people. Its only first-pass change is the worker's free zero-dollar trial billing period. Second pass has no differences. Background task rows are excluded from hash comparisons because the worker legitimately advances them.
- [Inspection evidence](final-phone-verification.json): +2 inspections, +4 photos, +2 completions and +2 filings; one completing HTTP 200 response deliberately dropped and safely retried.
- [Export evidence](export-verification.json): all 12 CSVs carry the per-row demo notice; all 6 PDFs marked DEMO, with embedded fonts. The raw zip and customer-link PDFs stay outside Git.
- [Account outbox](account-outbox-final.txt): invitation and password reset recorded locally, no delivered email.
- [Runtime/cron](final-runtime.txt), [restore check](backup-restore.log), [Actions restriction](actions-quota.json).
- [Clean printable call sheet](bastrop-call-sheet.pdf), rendered and inspected across four pages. TEST evidence was removed with [this scoped transaction](remove-test-evidence.sql); [both immutability triggers restored](evidence-cleanup.txt).

Entry links and invitation links are redacted in committed screenshots. Admin credentials, session states, reset tokens, raw receipts and active prospect entry links are stored outside Git in protected local files. The retained Example Septic LLC is a fictional test demo, expiring October 20; the empty TEST Fixed Trial Septic is retained as lifecycle evidence.

## Screenshot index

- [01-marketing](01-marketing.png)
- [02-request-form](02-request-form.png)
- [03-request-confirmed](03-request-confirmed.png)
- [04-demo-entry](04-demo-entry.png)
- [05-owner-inbox](05-owner-inbox.png)
- [06-request-admin-outbox](06-request-admin-outbox.png)
- [07-owner-due](07-owner-due.png)
- [08-site-county-honest](08-site-county-honest.png)
- [09-filings-acknowledged](09-filings-acknowledged.png)
- [09a-missing-demo-acknowledgement](09a-missing-demo-acknowledgement.png)
- [10-filing-proof](10-filing-proof.png)
- [11-renewals](11-renewals.png)
- [12-renewal-detail](12-renewal-detail.png)
- [13-invoices](13-invoices.png)
- [14-invoice-detail](14-invoice-detail.png)
- [15-test-billing](15-test-billing.png)
- [16-test-subscription](16-test-subscription.png)
- [17-company-settings](17-company-settings.png)
- [18-real-email-refused](18-real-email-refused.png)
- [19-real-phone-refused](19-real-phone-refused.png)
- [20-office-schedule-before](20-office-schedule-before.png)
- [21-office-scheduled](21-office-scheduled.png)
- [22-import-preview](22-import-preview.png)
- [23-import-done](23-import-done.png)
- [24-onboarding-summary](24-onboarding-summary.png)
- [25-import-undone](25-import-undone.png)
- [26-prospect-create](26-prospect-create.png)
- [27-prospect-created-redacted](27-prospect-created-redacted.png)
- [28-prospect-private-owner](28-prospect-private-owner.png)
- [29-prospect-logo](29-prospect-logo.png)
- [30-phone-route](30-phone-route.png)
- [31-phone-stop-online](31-phone-stop-online.png)
- [32-phone-photo-online](32-phone-photo-online.png)
- [33-phone-completed-online](33-phone-completed-online.png)
- [34-phone-stop-offline](34-phone-stop-offline.png)
- [35-phone-photo-offline](35-phone-photo-offline.png)
- [36-phone-completed-offline](36-phone-completed-offline.png)
- [37-phone-offline-reloaded](37-phone-offline-reloaded.png)
- [38-phone-reconnected](38-phone-reconnected.png)
- [39-invite-outbox](39-invite-outbox.png)
- [40-password-reset-requested](40-password-reset-requested.png)
- [41-draft-authority](41-draft-authority.png)
- [42-test-call-recorded](42-test-call-recorded.png)
- [43-v2-proposal-stays-draft](43-v2-proposal-stays-draft.png)
- [44-call-sheet-browser](44-call-sheet-browser.png)
- [45-trial-source-demo](45-trial-source-demo.png)
- [46-trial-created](46-trial-created.png)
- [47-demo-export-ready](47-demo-export-ready.png)
- [48-public-phone-unsent-before-reset](48-public-phone-unsent-before-reset.png)
- [49-ended-demo-create](49-ended-demo-create.png)
- [50-ended-demo-created-redacted](50-ended-demo-created-redacted.png)
- [51-ended-demo-phone-pending](51-ended-demo-phone-pending.png)
- [52-test-demo-ended](52-test-demo-ended.png)
- [53-ended-offline-kept-until-contact](53-ended-offline-kept-until-contact.png)
- [54-ended-phone-cleared](54-ended-phone-cleared.png)
- [56-reset-public-phone-offline-kept](56-reset-public-phone-offline-kept.png)
- [57-reset-public-phone-cleared](57-reset-public-phone-cleared.png)
- [58-prospect-session-logo-after-two-resets](58-prospect-session-logo-after-two-resets.png)
- [59-prospect-private-tech-after-two-resets](59-prospect-private-tech-after-two-resets.png)
- [60-ended-entry-refused](60-ended-entry-refused.png)
