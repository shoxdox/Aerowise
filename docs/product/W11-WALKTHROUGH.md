# W11 walkthrough: issues found and fixed

Walked on 2026-10-06 against main `3929897` (re-checked against `58cde2e`, which only adds docs), run locally with the existing demo seed (`pnpm db:seed`, `DEMO_MODE=true`, production web build). Browser clock in America/Chicago unless noted. Every nav page was opened as owner, office and technician at desktop (1366×860) and phone (Pixel 7, 412 wide) sizes: 84 page views, each with a screenshot, console and HTTP errors, an axe-core WCAG 2.1 AA scan, sideways-scroll and tap-target checks. Then, by hand: the technician's offline inspection (start, close and reopen with no signal, finish, reconnect), a site's report PDFs, a filing, the marketing page, keyboard focus, and form dates at 8:30 PM Central.

Before and after screenshots of the fixed items are in [`w11/`](w11/). The full set (every page, role and size) is in the project's shared folder under `Septic/next-phases/w11-screens/`; only the ones cited below are committed.

**Status:** B1, B2 and C1 to C6 are fixed in W11.2 (PR for W11.1 to W11.3), each with an e2e check in `apps/web/e2e/polish.spec.ts` (C5 and C6 by review). K1 to K3 are fixed as a side effect; K4 is open. The second walk, after W10, is [at the end](#second-walk-after-w10).

## Broken

**B1. A technician's Filings and Invoices links open an error.** The office header shows a technician Filings and Invoices, but the technician role has no permission for either, so each page shows only "Your role does not allow this action" over an empty table (HTTP 403 in the console).
Steps: sign in as tech@example.com, open `/inbox` (lands on `/tech`), go to `/schedule`, click Filings or Invoices.
Screens: [before](w11/b1-technician-filings.jpg), [after](w11/after-b1-technician-nav.jpg).
Fixed: each header link shows only to roles whose permissions open its page (`roleHasPermission`, the same map the API uses).

**B2. After 7 PM Central, "today" in forms is tomorrow.** Default dates are taken from the UTC date. At 8:30 PM CDT on Oct 6, a new contract's start date defaults to 10/07/2026. The same code fills a payment's "received on" date (invoice page) and decides when a license shows "Expired" on Licenses and registrations, so an expiry flips a day early in the evening.
Steps: with the computer's clock after 7 PM Central (00:00 UTC), open any site, New contract.
Screen: [before](w11/b2-late-evening-contract-start.jpg) (browser clock fixed at 2026-10-06 20:30 CDT). After: e2e "B2" fixes the browser clock at 8:30 PM Central and expects today's date.
Fixed: these defaults use today's date in the company's time zone.

## Confusing

**C1. The office can open the Export page and is offered a button it can't use.** Export is owner-only and not in the office nav, but `/settings/export` opens for the office with an empty "Recent exports" (the list fails with a 403 that is never shown), and "Prepare an export" then answers "Your role does not allow this action". The Subscription page already says "Only the owner can see…"; Export should too.
Screens: [before](w11/c1-office-export-direct.jpg), [after](w11/after-c1-office-export.jpg). Fixed: the office reads "Only the owner can export the company's data."

**C2. On a phone, table pages scroll sideways as a whole.** Due, Plans, Users, Renewals and Licenses pages are 416–545 px wide on a 412 px phone, so the header and banner stop short and the page drifts sideways under a thumb.
Screens: [before](w11/c2-phone-plans-overflow.jpg), [after](w11/after-c2-phone-plans.jpg). Fixed: on a phone a wide table scrolls inside its own box.

**C3. On a phone, the office menu fills the first screen.** Up to 17 links wrap to five rows plus the user line, so the page title starts about 280 px down on every page.
Screens: [before](w11/c3-phone-nav.jpg), [after, menu open](w11/after-c3-phone-menu-open.jpg). Fixed: on a phone the header shows the page name and a Menu button; the links, name and Sign out open beneath it.

**C4. The schedule's date picker has no label** (axe "label", critical; it is announced only as "date"). Every role, every size.
Screen: [before](w11/c4-schedule-date-unlabeled.jpg). Fixed: the picker is named "Day"; axe no longer reports it.

**C5. Times show in the browser's time zone, dates in Central.** Due dates and "today" come from the company's time zone (America/Chicago), but timestamps (inspected at, sent at, compliance history, the support banner's end time, "route updated", "on the way since", the Filings list date) use whatever zone the device is in. A laptop set to another zone shows a filing as inspected at a different hour, and near midnight on a different day, from the PDF.
Fixed: every timestamp is formatted in the company's time zone (`apps/web/lib/format.ts`), set from the session on the office screens and the technician app.

**C6. The marketing page promises more than exists.** "Prepares the report in the authority's own format" and "so nothing is filed late": only LCRA has an official form that Aerowise fills; every other authority gets Aerowise's own layout, whose acceptance no authority has confirmed. County coverage itself is honest: all 21 real authorities show "In progress" and none shows as verified.
Fixed: the hero now says Aerowise keeps each report and its deadline in view until the authority acknowledges it, and "File on time" says reports carry the fields each authority's rules ask for, with the official form filled where one exists (LCRA's cover sheet so far).

## Cosmetic

- **K1.** (unchanged on desktop) Desktop header wraps to three rows for the owner at 1366 px (17 links plus name), two rows for the office. `k1-owner-desktop-nav-wrap.png`.
- **K2.** Small tap targets on phone: "Sign out" (58×23), inline text links in the inbox checklist and tables (about 19 px tall), "Retire" (41×23), "← Filings" (64×19). Below the 24 px WCAG 2.2 minimum. The phone header's Menu and Sign out are now 44 px tall; inline links in text are unchanged.
- **K3.** Keyboard focus was the browser's default 1 px outline, faint on the green buttons. Fixed: a 2 px accent ring on every control.
- **K4.** A system's "Installed" date shows as `2012-04-17` while every other date reads "Oct 6, 2026".

## For other threads (not fixed here)

- **Demo (W10.3): the five-minute path can't reach a filing.** 32 of the 55 seeded sites are in "Sample County", which no ruleset covers, including the technician's whole route today. A finished inspection's filing says "No reporting authority matches this site" (`d1-filing-no-authority.png`). The demo company also has no MP license on record and no MP named on contracts, so even an Example County report "cannot be signed" (`d2-site-no-mp.png`), and the first-run checklist shows 2 of 6 done on every office inbox.
- **Demo / County: report contradicts the site record.** On Carlos Gonzales's report, the site section says "Chlorination: none" while the inspection records "Chlorine device: Working, 1.5 ppm" (`ok-authority-report-pdf.png`). The seed gives that system no chlorinator but the template still asks for one.
- **County (inspection form, per the coordinator's note):** a negative chlorine level (-3) is accepted while typing and only refused at "Finish inspection" ("Chlorine level must be between 0 and 20 ppm"). Fine as is; noted only.

## Checked and working

- Offline inspection: started with no signal, closed and reopened mid-inspection with every answer kept, "No signal. 1 change saved on this phone" shown throughout, finish refused with reasons, sent once on reconnect, "All changes sent" (`ok-offline-*.png`).
- Report PDFs: customer and authority copies render cleanly with signed links (`ok-authority-report-pdf.png`).
- Money: every amount goes through one formatter ($275.00, $1.50, $99.00).
- Role access on the API side: no page leaked data to the wrong role; the only problems are the links above.
- axe-core WCAG 2.1 AA: no colour-contrast, landmark or name violations on any of the 84 page views; the only finding is C4.
- Marketing coverage: drafts read "In progress", the fictional demo authority isn't listed, and the page explains what "Verified" would mean.

## Measurements (W11.3)

Before the fixes, on main `3929897`. Local production build, Pixel 7 emulation, 4× CPU slowdown, cache off. These are lab numbers on localhost, so network time is near zero; read them as relative, not as a pilot-readiness score.

| Page | First paint | Largest paint | Layout shift | JS (KB) | Requests |
| --- | --- | --- | --- | --- | --- |
| `/` marketing | 468 ms | 468 ms | 0.035 | 139 | 14 |
| `/login` | 432 ms | 1192 ms | 0.044 | 132 | 11 |
| `/inbox` | 440 ms | 2052 ms | **0.253** | 279 | 64 |
| `/due` | 416 ms | 2028 ms | 0.005 | 275 | 67 |
| `/schedule` | 460 ms | 2044 ms | 0.005 | 275 | 64 |
| `/customers` | 420 ms | 2020 ms | 0.006 | 275 | 68 |
| `/tech` | 436 ms | 2088 ms | 0.052 | 244 | 17 |

- The inbox's layout shift (0.25, "poor") was material: the setup checklist arrived after the counts and pushed them down. Fixed: the inbox waits for both, and measures 0.005 after the fix.
- After the fix, with the phone menu folded, two shifts that used to happen below the first screen are now visible: `/schedule` 0.30 (its route columns and map load one after another) and `/due` 0.08 (the summary line appears above the table). Left for a follow-up; neither moves a button under a tap in testing.
- Folding the phone menu also cut office page requests from about 65 to about 30, since hidden links aren't prefetched.
- New on phone after C2: axe "scrollable-region-focusable" on the Plans, Users and Licenses tables (a scrolling table has no focusable cell). Keyboard use on a phone is rare; left open.
- Office pages make about 65 requests, mostly link prefetches for every header link. Not material at this size.

## Second walk, after W10

Walked on 2026-10-06 against main `94e6ee7` (all of W10 merged), run locally with `pnpm db:seed` (which now plays the five-minute demo story) and `DEMO_MODE=true`, production web build. Every nav page again as owner, office and technician at desktop and phone sizes, twice: signed in with the seeded logins, and in a visitor's own demo from "Try the demo" switching with "View as". Then the five-minute path by hand on both sizes: marketing page, sign-in, "Try the demo", inbox, the confirmed and the waiting filing, the site, a renewal, an invoice, and the technician's route and first stop.

No console errors and no HTTP errors on any linked page. The round-one fixes held: no technician link opens a 403 (a technician typing an office URL still gets "Your role does not allow this action", which is right), dates and times read in Central, and the phone menu and table scrolling work for the visitor demo too.

### Broken or confusing, fixed here

**R1. A demo filing says it "cannot be filed" while showing Confirmed.** The demo story files under the fictional Example County, whose rules don't hold a filing for the maintenance provider's signature, so both filings went out unsigned. The signature panel still said "Report version 1 is not signed yet, so it cannot be filed, and the customer's copy is held until it is", next to a Confirmed badge and a county reference. A prospect reads that as the product contradicting itself.
Steps: Try the demo, Filings, All, open either filing.
Fix: the signing state now says whether this inspection's filing waits for the signature (`required`, from the same rule the filing uses). When it doesn't, the panel says the demo's example county rules don't hold the filing or the customer's copy for a signature, that a real report must be signed under 30 TAC 285.7(b)(3) before it is filed or sent, and that signing can still be tried. Real authorities are unchanged: the API test checks `required: true` under LCRA and the demo test checks the story's filings are `false`.
Screens: [before](w11/r2-before-demo-signature-desktop.jpg), [after](w11/r2-after-demo-signature-desktop.jpg).

**R2. On a phone, a filing page scrolls sideways.** The 64-character manifest SHA-256 under each submission doesn't wrap, so the page is 525 px wide on a 412 px phone.
Fix: the hash wraps anywhere. Screen: [before](w11/r2-before-phone-filing-overflow.jpg).

**R3 (W11.3). The schedule jumps on a phone.** Layout shift 0.30: the day's route columns drew first and the 30-day unscheduled list then arrived above them and pushed them off the screen. Fix: the page waits for the first answer of each list (technicians, unscheduled, the week, routes) before drawing. Now 0.01.

### W11.4: "Try the demo" on the marketing page

The hero has a "Try the demo" button next to "Ask for a demo", linking to `/demo`. It shows only when the API says this is the demo deployment (`/api/app-info` `demo: true`), the only place `/demo` answers; elsewhere it isn't drawn. A header link was tried and dropped: on a phone it wrapped the header to two rows and shifted the page (0.40). E2e covers both cases in `try-demo.spec.ts`. Screen: [phone](w11/r2-phone-marketing-try-demo.jpg).

### Left open (cosmetic)

- **K4** still: a system's "Installed" date and a few sentences built by the API ("ends 2026-10-26", "performed on 2026-10-05" in the signature statement) print ISO dates. The signature statement is the signed text, so it stays as is.
- On the demo deployment, the demo banner appears above the marketing page after `/api/app-info` answers and moves it down 50 px on a first visit (layout shift 0.06; remembered on the device after that). Not on a real deployment.
- Phone tables that scroll inside their box still have axe "scrollable-region-focusable".
- A fourth "Try the demo" from the same address within an hour gets the demo page's own "too many demos" message, which reads fine.

### Measurements after the second round

Same method as above, on this branch.

| Page | First paint | Largest paint | Layout shift | JS (KB) | Requests |
| --- | --- | --- | --- | --- | --- |
| `/` marketing | 468 ms | 468 ms | 0.059 | 247 | 16 |
| `/login` | 440 ms | 1868 ms | 0.059 | 240 | 12 |
| `/inbox` | 448 ms | 2352 ms | 0.01 | 267 | 36 |
| `/due` | 416 ms | 1868 ms | 0.086 | 246 | 29 |
| `/schedule` | 420 ms | 1968 ms | **0.01** (was 0.30) | 249 | 26 |
| `/customers` | 424 ms | 1884 ms | 0.014 | 246 | 30 |
| `/tech` | 440 ms | 2160 ms | 0.076 | 251 | 16 |

JS is larger than in the first round on every page (about 250 KB against 140 to 280 KB) because W10's demo banner, intros and county panel ship with the shared layout. Every page is now under 0.1 layout shift ("good").
