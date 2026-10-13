# Technician outreach cleanup evidence

Scope: findings 12, 21, 23, 24 and 25. Implementation branch `codex/aerowise-outreach-readiness`; no deployment, real provider, real filing, or physical-device action is included in these checks.

## Baseline and result

### 12 — Truthful technician help

The reviewed help promised prior findings, but `Stop` and stop detail only expose access, system, permit, scheduling/office notes and the current inspection pointer. A prior-visit history service is not part of this payload. The Office/demo owner changed `Intro.tsx` to describe visible functionality; no history or offline-history claim was invented. Status: implemented; inspect the integrated Intro rendering during the final browser walk. Dependency: no external service required.

### 21 — Starting and draft reuse

`start` and `startWork` awaited GPS while leaving their buttons available and only checked a React state snapshot. The implementation now immediately displays Starting, disables the action, and guards each job with a synchronous ref. Tenant-bound store methods atomically recheck the job in the same IndexedDB transaction that creates and queues a draft. A draft saved during GPS acquisition wins; it is never replaced with empty answers. Start/adoption checks the active tenant and that the same stop is still open before changing the view, and local inspection edits bind to their mounted tenant's store. GPS denial/unavailability retains the existing location-status behavior. `/tech?jobId=` opens only a stop already in the authorized tenant route, without starting or assigning it.

Status: implemented; atomic race and delayed/denied-GPS UI regression is in `outreach-technician.spec.ts`, pending final integrated browser evidence. Dependency: physical-device recheck below.

### 23 — Photo review and immutable recap

Previously inspection/work photo controls displayed a count, discarded local full-size blobs once uploaded, and provided no retake/remove controls. Completed inspection stop details only showed Done.

Draft photos now have small cached thumbnails, a full image link when available, and keyboard buttons for add, replace/retake, and remove. A replacement gets a new client UUID. The local transaction saves the changed photo list and removal IDs, removes obsolete queued photo operations and local blobs, and queues the new bytes/current sync together. The API accepts optional explicit removal IDs on authorized mutable records, scoped to the correct record and tenant. Old phones that omit removal IDs keep their existing behavior. Required-photo validation runs after removal, so removing a required image prevents completion until a replacement is uploaded. Completed, locked, held and resolved records retain their existing immutable gates. Optional photo GPS runs after durable capture and does not block the next photo.

Inspection recaps show the recorded readings, saved photos, issues/access note, completion time, and either waiting-to-send or sent-to-office status. They explicitly separate delivery from provider report review/signature and authority acceptance. An authorized stop snapshot kept with new local records also permits read-only review after that stop leaves today's route. Older local records without thumbnail/snapshot say what is unavailable rather than manufacturing history; completed server records can be downloaded through the existing authorized job-inspection read.

Removed uploaded draft attachment records are audited and excluded from the active report/export. Their raw object bytes remain under the organization's storage prefix until the existing organization-storage purge; this change does not claim immediate object or backup erasure. No new deletion service or retention period was invented.

Status: implemented; API regression verified, browser/offline recap regression pending final integrated run. Dependency: physical-device recheck; deploy API and web together before relying on draft photo removals. No schema migration is needed.

### 24 — Durable local status, freshness and progress

The existing form debounced writes without telling the technician when the latest edit committed. Outbox status alone could be read as a local-save guarantee. The form now displays Saving locally immediately, Saved on this phone only after its IndexedDB transaction commits, or Latest edits are not saved with an explicit local Retry. Attempt/version guards prevent an older successful write from claiming a newer unsaved edit is durable. Existing pagehide, visibility-change and unmount flushes remain. Photo previews do not appear before their durable save. Full storage preserves older committed records and queued operations; the global banner distinguishes previously sent work from latest unsaved edits.

Offline status is explicit even when the outbox is empty. Route last downloaded includes date and time in the company timezone, and a different cached route date is flagged. Daily stop totals include same-day inspections and work visits; differently dated cached work visits display their dates and a separate warning. Direct forms now include section anchors, required-answer/photo counts and a visible link to Finish/review. The count is labeled entered; the actual finish validation still checks correctness and conditional requirements. Held records remain read-only and retain office/recovery status.

Status: implemented; web typecheck/lint verified, quota/retry/dated-cache and mixed-day browser assertions pending final integrated run. Dependency: physical-device recheck.

### 25 — Keyboard, consent and errors

The old Add photo label was not a keyboard control and work sign-off offered only a pointer canvas. Native file picking is now invoked by a semantic button, and photo replacement/removal are buttons with record-specific accessible labels. Work sign-off can adopt the typed signer name using the existing `{ kind: "typed" }` domain model. Both drawn and typed paths retain the same consent text, exact work-summary hash, requirement key, immutable signature ID and completion transaction. The intentional maintenance-provider inspection signature in the office is unchanged.

Template inputs/choice groups associate their error text through `aria-invalid` and `aria-describedby`. Validation focuses an alert summary, section anchors focus their target, and the work sign-off section receives focus after Review. Phone targets and wrapping use a small scoped technician stylesheet.

Status: implemented; typed-signature API binding and existing final/signature-mismatch tests verified; browser keyboard flow pending final integrated run. Dependency: real assistive-device/screen-reader and physical-phone checks are not claimed.

## Checks performed on this branch

- `TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_tech_test pnpm --filter @aerowise/api exec vitest run test/inspections.test.ts test/work-sync.test.ts test/inspections-held.test.ts` — **46 tests passed**. The two new API regressions prove explicit draft removal/replacement, required-photo revalidation, tenant/technician scope, typed summary-hash binding and final replay immutability. Existing held/assigned, replay and signature mismatch checks also passed.
- `pnpm --filter @aerowise/api typecheck` — passed.
- `pnpm --filter @aerowise/web typecheck` — passed after technician edits and current parallel edits resolved.
- `pnpm exec eslint apps/web/app/tech apps/web/components/tech apps/web/components/forms/TemplateFields.tsx apps/web/lib/offline/{db,data,work,sync}.ts apps/web/e2e/outreach-technician.spec.ts apps/api/src/routes/{inspections,work-sync}.ts apps/api/test/{inspections,work-sync}.test.ts packages/domain/src/{inspections,work-sync}.ts` — passed.

The first coordinated focused browser batch exposed three test/interaction issues: the GPS-denied assertion expected “turned off” while the existing copy says “Location is off”; an early `.all()` enumerated Pass controls before the form loaded and omitted required Air pressure; direct file-input test events arrived before the previous durable capture. The denial/template/readiness assertions were corrected. Photo capture was improved to a serial per-form queue so a second native/programmatic file event is retained, while Finish stays blocked until all selected photos have committed. The quota/retry/date-cache browser regression passed in that batch. The final rebuilt browser result is recorded by the parent, rather than treating those failed initial tests as passes.

The parent coordinates the production build and combined browser/integrated workflow once all role changes are committed. Required browser files are `outreach-technician.spec.ts`, `offline-sync.spec.ts`, `sw12-mixed-offline.spec.ts`, `phone-storage.spec.ts`, `sync-banner.spec.ts`, `revoked-tech-cache.spec.ts`, plus the existing sign-in/hold/recovery paths. Do not treat a compiled UI or these prepared tests as a browser pass; attach exact results/tested commit to the final acceptance report.

The initial broad worktree typecheck briefly reported missing Office/demo exports and a PublicHomepage selection narrowing issue during simultaneous edits. Those were outside technician ownership and resolved by their owners; the later web typecheck passed. No hosted CI result is claimed here.

## Physical-phone recheck for this release

Current historical evidence is `PHONE-TEST-2026-10-12.md`: Justin previously tested an iPhone home-screen Safari app and Android home-screen Chrome app on staging `31d0310`, including denied GPS, camera photos, airplane-mode finish, close/reopen and reassignment holds. That is history, not a test of this implementation. No physical device is available to this agent.

On the approved candidate staging release, use only a new isolated fictional visitor company. Record device, OS/browser, installed build SHA, timezone and video/screenshots/results. Keep outside services simulated and do not use real customer/site information or binding signatures.

1. iPhone Safari home-screen and Android Chrome home-screen: deny location, tap Arrive repeatedly during the wait, and confirm one inspection/work record and immediate Starting feedback. Resume an existing draft; verify its readings and IDs remain.
2. Capture a blurry overview, inspect its thumbnail, retake it, remove another photo and capture a replacement. Check required counts. Lock the phone/camera switch between captures. Confirm sent draft replacement disappears from the current office record and only retained photos count at completion.
3. Go offline. Type a distinctive reading/note and wait for Saved on this phone. Close/swipe away and reopen offline. Confirm answers, thumbnails, replacement/removal state and waiting status remain. Finish offline and read the immutable recap. Return signal; confirm exactly one completion and the retained photo count in the office.
4. With a disposable browser storage/quota stand-in, fail the latest local edit. Confirm no saved guarantee, preserve already committed data, remove the stand-in, Retry local save, and then close/reopen. Never deliberately fill a real technician's phone.
5. Keep yesterday's downloaded route offline until the next company-local day. Confirm the cached route date and download date/time are visible, then refresh with signal. For a mixed inspection/work day, reconcile total and finished counts to office assignments.
6. Complete a synthetic work sign-off with the keyboard/assistive device typed option. Read the consent/summary, sign, and confirm recorded `signature_kind=typed`, consent text and `content_sha256=summary_sha256`; confirm completed record has no edit controls. Do not add a technician inspection signature.
7. Reassign an offline draft to another synthetic technician; send the old copy and confirm held status, read-only form and preserved photos. Repeat close/reopen, sign-in-expiry and Android back/forward recovery. Confirm no other tenant's route/content becomes visible.
8. Traverse required fields, errors, photo actions and section links with keyboard and VoiceOver/TalkBack. Confirm error associations/status announcements and focus on validation/sign-off. Capture 375px and wider-phone screenshots with readable wrapping.

Until this candidate passes the device recheck, status is implemented with automated evidence and **physical-device verification pending**, never externally/physically verified.


## Independent review fix — late callbacks after confirmed access end

The independent review found that the same-tenant check occurred only after `ensureInspection`/`ensureWork`. A delayed GPS result could therefore reopen a deleted database after confirmed demo end, even though the UI correctly refused to show it. Bound photo/flush callbacks shared that lifecycle gap.

Both technician start paths now recheck the active tenant before the post-await write. The inspection and work transaction wrappers reject writes when that tenant's phone registration was removed, both before opening IndexedDB and after its asynchronous open completes. This also blocks late photo-upload marks, camera processing, local-save and flush callbacks from recreating an ended demo's data. Existing read/recovery behavior remains available; switching away from a still-registered account does not delete its pending work.

`TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_tech_test pnpm --filter @aerowise/api exec vitest run test/tech-tenant-lifecycle.test.ts test/inspections.test.ts test/work-sync.test.ts test/inspections-held.test.ts` passed **49 tests**. The three added tests execute the actual browser wrappers with controlled IndexedDB/registry stand-ins: forgotten inspection/work/photo callbacks never open a database, and forgetting either account while its database opens prevents the write transaction. The test loads browser modules at runtime so browser DOM globals do not alter the Node API typecheck. After fixing that test-runner boundary, the lifecycle file separately passed 3/3, and API/web typecheck and focused lint passed.

`outreach-technician.spec.ts` adds a real-app regression with a new fictional prospect company: hold GPS (freeze only the browser timeout), end that disposable company through the isolated admin fixture, trigger the existing pageshow access recheck, release GPS, and assert both scoped phone databases remain absent and the ended screen remains visible. This new browser case is pending the parent's final rebuilt suite. No shared company or real data is ended or deleted by that case.

## Closing review fix — adopted photo links expire

The closing independent review found that a clean phone adopted server photos using 15-minute signed URLs, then reused those URLs indefinitely when reopening a saved completed inspection. An expired link produced a broken image with no recovery path. Checking the actual signed URL also exposed a missing same-origin `/api` proxy prefix in the shared photo renderer; local thumbnails had hidden this from the earlier capture flow.

The renderer now uses the API proxy for remote files and shows an explicit unavailable-preview status on a rejected/missing file. Local thumbnails continue to work offline. Reopening a previously adopted record with signal refreshes only matching photo links. The completed recap also offers Refresh photo links with a truthful offline/failure response. The refresh transaction rereads the newest local record and updates only ephemeral URL metadata by photo client ID: answers, completion, retained photo IDs, outbox, signatures and server records remain untouched. A retry version handles links minted within the same server second. The forgotten-tenant write guards also cover this new metadata callback.

`pnpm --filter @aerowise/web typecheck` and `pnpm exec eslint apps/web/app/tech/page.tsx apps/web/components/tech/InspectionForm.tsx apps/web/components/tech/InspectionRecap.tsx apps/web/components/tech/PhotoField.tsx apps/web/lib/offline/db.ts apps/web/e2e/outreach-technician.spec.ts apps/api/test/tech-tenant-lifecycle.test.ts` passed. `TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_tech_test pnpm --filter @aerowise/api exec vitest run test/tech-tenant-lifecycle.test.ts` passed 4 tests after extending the metadata/removal and forgotten-account regressions.

The new self-contained browser case creates a separate fictional prospect company, completes an inspection through the real API, opens it on a clean phone under controlled 403 image responses, retries successfully, ages only local links, reloads offline with explicit fallback, and reopens online. It checks decoded images and unchanged server answers/completion/photo IDs/updatedAt. It does not consume the shared route used by the existing offline suites. Its rebuilt browser execution is pending the parent's integrated acceptance run. On physical devices, add the same clean-phone adoption, 15-minute wait, offline recap and online refresh to step 3 above; no physical-device result is claimed.

## Integrated compatibility fix — newer work database stays untouched

The integrated `phone-compat.spec.ts` regression found that a later release's version-2 work database containing only `records`/`outbox` and unknown `estimate-*` operations was raised to version 3. The new demo work stop made `loadWorkRoute` cache fresh route/forms, which called the generic store repair path and added this release's missing `kv`/`blobs` stores. Reconciliation itself remained read-only for that fixture.

The work writer now checks the existing outbox before a missing-store upgrade. Unknown operations make the partial schema incompatible: optional route/form/pumping cache writes skip it, and new field writes report that the app must update. Fresh online route data still displays; the future records, queued operations, store inventory and version stay unchanged. Compatible earlier databases still repair missing stores through the existing path. The generic inspection writer's existing upgrade behavior is unchanged.

`TEST_DATABASE_URL=postgres://aerowise:aerowise@localhost:55433/outreach_tech_test pnpm --filter @aerowise/api exec vitest run test/tech-tenant-lifecycle.test.ts` passed **5 tests**. The new regression runs the actual shared opener/work writer against an incompatible version-2 fixture and proves only read-only outbox transactions occur, no versioned upgrade is requested, optional caching returns safely, and new work saves reject with the update message. Web typecheck and scoped ESLint (`apps/web/lib/offline/{db,work}.ts`, `apps/web/e2e/phone-compat.spec.ts`, `apps/api/test/tech-tenant-lifecycle.test.ts`) passed. The existing real-browser compatibility case now checks the exact two-store inventory and unchanged database contents again after a second startup; rebuilt browser execution is pending the parent's coordinated acceptance run.
