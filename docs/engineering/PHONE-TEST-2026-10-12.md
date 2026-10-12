# Physical-phone test, October 12, 2026

The first time real phones ran the technician app. Justin, on staging at `31d0310`, in a prospect demo company ("Phone test (Justin)", Example County, auto-filing), with an iPhone (Safari, added to the home screen) as Tess Tech and an Android (Chrome, added to the home screen) first as Tess and then as an invited second technician, "Andy Android". Claude watched the office side through the browser. The script is gate 3 of [NEXT-GATES.md](../NEXT-GATES.md).

## Results

| Step | What was done | Result |
| --- | --- | --- |
| 1 | Start an inspection, decline location | Pass. The form says location is off for the app; the office filing page says "Not recorded: location is turned off for Aerowise on the technician's phone". |
| 2 | Four camera photos, phone locked between the second and third | Pass. All four kept. |
| 3 | Airplane mode on, finish the inspection | Pass. The stop reads "Done · not sent yet". (Inspections ask for no signature; that is by design, the provider signs the report in the office.) |
| 4 | Airplane mode off | Pass. "Done" and "All changes sent" within seconds. |
| 5 | Two photos, then swipe the app away mid-form | Pass. Answers and photos were there on reopening. |
| 6 | Start on the iPhone, the office gives the stop to Andy, continue on the Android | Pass. The Android showed "Continue inspection" with the iPhone's answers and finished it. The iPhone's later sync was held: the stop read "Held for the office", the form said the visit was given to another technician, and the inbox showed "Tess Tech's inspection is held" with its photos. |
| 7 | Force-stop the browser with unsent changes | Pass. The changes were still waiting on reopening and sent after sign-in. |
| 8 | Portrait and landscape photos on each phone, read in the office | Pass on both phones: all four photos upright in the customer report PDF. |

Timing: a visitor demo starts in about 50 seconds on the staging server (the proxy timeout fix of October 10 was needed for this); an inspection synced within seconds of signal returning.

## Findings

1. **Android: a stale "Sign in again to send your changes" banner.** After opening the original demo link while signed in as Andy (which signed the device in as Tess again), signing out and back in as Andy, swiping back to the sign-in page and forward again, the technician app showed the banner with Andy's name in the corner. "Try now" did nothing. Signing in again cleared it and the change (aerator set to fail) had been kept. Nothing was lost; the state is wrong. Needs a reproduction on the back/forward cache path and a fix. Priority: before a provider's technician sees it.
2. **The inbox offers "Accept as the inspection" on a held copy whose visit is already completed.** The API refuses it (a visit completed with another technician's inspection can only be set aside); the button should not show. Small.
3. **The office has no photo view outside the report PDF.** To see a visit's photos the office opens the customer or authority PDF from the site's history. Fine for a filing; a dispatcher checking "did the tech photograph the chlorinator" wants them on the site page. Backlog, with the provider's opinion first.
4. **Two seeded customers share a name** (Lupe Dorsey twice), which made the office hunt for the right site. The demo seed should not repeat names.
5. **Credentials gate works as intended but surprised the tester:** Andy's inspection cannot be signed or filed until he has a TCEQ registration on record, and the inbox says so. Correct behaviour; the invite flow could ask for the licence number up front.

Not tested: battery death (force-stop stood in for it), a real county, a real technician.
