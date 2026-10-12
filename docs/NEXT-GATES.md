# The gates outside the code, in order

Written October 9, 2026, after the review's P1, P2 and P3 lists were fixed on `main`. Each gate below is something only Justin can do or decide. The order is the order they unblock each other: nothing after the first two is worth doing on a staging that still runs `a444be2` without checks.

## 1. Redeploy staging from `main` (an hour) — done October 12: CI deploys `main` to staging on every green run; `aee751a` is live

Staging runs `a444be2`, migration `0060`. `main` carries migrations 0061 to 0064, the P1, P2 and P3 fixes, the LCRA demo history and the grouped navigation. Nothing on this list can be shown to anyone until it is live.

1. Push `main`, then from your machine with SSH access as `deploy`:
   ```bash
   VPS_SSH=deploy@<server> ./scripts/deploy-vps.sh staging <commit on main>
   ```
   It builds, runs the settings check and migrations, swaps containers and waits for health; a failure stops before anything is replaced ([DEPLOY.md](engineering/DEPLOY.md), "Deploying").
2. Before the deploy, note two things that change on this release: links sent before it stop working (pay and renewal links are now signed, not stored; staging reseeds nightly and no real customer has one), and the deploy runs four migrations, the heaviest adding two nullable columns.
3. After the deploy, walk the demo once: a Lake Travis site's compliance history, a Blanco filing, the technician route, a renewal link from the office, and `/admin` (the erase form now asks for your password). Ten minutes.
4. Compare the nightly reseed time; the brief says about 25 seconds.

## 2. Restore continuous integration (an afternoon) — done October 12: the repository is public and run 38301484907 was green

GitHub Actions has not run since early October: the private repository is out of minutes, every run fails in three seconds, and every "tests pass" since is an agent's local run written into a document.

Two ways, pick one:

- **Make the repository public.** Public repositories get unlimited Actions minutes, so `ci.yml` runs again unchanged (check, docker, e2e, then `deploy-staging`). Before flipping it: search the history for secrets (`git log -p | grep -i -E "sk_live|whsec_|password=" ` and the `.env` files), confirm `deploy/vps/env.example` and `setup.sh` hold placeholders only, and accept that the county research, the decisions log and the pricing discussion become public. The code was written to be read; the risk is in documents, not code.
- **Add a self-hosted runner on the staging server.** Keeps the repository private. Install the runner as its own user on the VPS, change `runs-on: ubuntu-latest` to `runs-on: [self-hosted, linux]` in the four jobs of `ci.yml`, and give it Docker access for the `docker` and `e2e` jobs. The e2e job needs Postgres and ports 3000 and 4000, which the staging containers also use, so the runner must use its own ports or its own Compose project. Count on an afternoon of fiddling and a slower e2e job; the VPS is shared with staging.

Either way: merge nothing further without a green run, and move the local-run notes in the brief to "superseded by CI" once the first run is green.

## 3. A physical-phone test (half a day, two phones) — done October 12, see [PHONE-TEST-2026-10-12.md](engineering/PHONE-TEST-2026-10-12.md)

No real phone has run the technician app. Do this on staging after gate 1, with an iPhone (Safari, added to the home screen) and a cheap Android (Chrome), as `tech@example.com` in the demo.

For each phone, in this order, writing down what happened:

1. Open the route, open a stop, start the inspection. Note whether the phone asked for location and what the form said if you declined (it should say location is off for the app, and the office's filing page later says the same).
2. Take four photos with the camera (not the gallery). Lock the phone between the second and third. Reopen: all four should still be there.
3. Turn on airplane mode. Fill the rest of the form, draw a signature, finish. The stop should say done, not sent.
4. Turn airplane mode off. The banner should reach "All changes sent" within a minute. Check the inspection in the office.
5. Start a second inspection, take two photos, then kill the app (swipe it away) mid-form. Reopen: the photos and answers should be there.
6. Start a third inspection on one phone, then from the office give the visit to the other technician and open it on the second phone: it should offer "Continue inspection" with the first phone's answers.
7. Let the first phone's battery die, or simulate it by force-stopping the browser, while it has unsent changes; charge, reopen, confirm they send.
8. Look at a photo of a landscape subject in the office: is it rotated correctly? This is the one item on the list no test can answer.

Anything that fails here is a P1 by definition, ahead of any feature.

## 4. Pick the first provider (two weeks of calls) — prepared October 12 in [pilot/](pilot/)

The review's method stands: county environmental-health pages publish registered maintenance providers, and TCEQ's licence search lists every licensed maintenance provider by county. Call providers with 200 to 1,000 contracts in the counties where the rules are deepest (Hays, Williamson, LCRA's lake area), and ask three questions before any demo: what software they use today, what they hate about filing, and what would make them switch. The [pilot worksheet](PILOT-CALL-SHEET.md) lists what to collect from the provider before any authority is contacted.

Offer the first five: ninety days free, their spreadsheet imported for them, and their county's filing proved on one real report with their licence number on it. In return: an hour a week of a technician's time on the phone app, and a licensed provider reading the inspection form, the authority PDF and the contract text once and marking what is wrong. That reading is the single review no agent can do and should come before anyone relies on the form.

What to have ready for that call, all of it on staging after gate 1: the demo, a prospect demo in their county (`/admin`, prospect demos), and a one-page answer to "how do I file in my county with this" for their county.

## 5. Decide pricing (a decision, then ten minutes of configuration) — memo in [pilot/pricing-memo.md](pilot/pricing-memo.md)

Fieldbase On-Site, the direct competitor, is $50 a month for up to 100 contracts (Solo) and $50 plus $0.50 per active contract (Teams). Aerowise's page says $1.50 per contract with a $99 minimum: three times the incumbent for a product no provider has used.

The price is configuration, not code: `AEROWISE_PRICE_PER_CONTRACT_CENTS` and `AEROWISE_MONTHLY_MINIMUM_CENTS` in the deployment's environment, with defaults of 150 and 9900 in `packages/domain/src/subscription.ts`, a per-company founder price in `/admin`, and the marketing copy in `apps/web/app/page.tsx`. Three choices, in order of how defensible they are on a first call:

- **Match, then earn the difference.** $0.50 per contract with a $50 minimum, the founder price for the first five at $0.25, and charge later for what Fieldbase does not have: the homeowner portal with online payment, estimates and deposits, pumping and disposal records, QuickBooks sync. This is the one to lead with; it removes price from the first conversation entirely.
- **Base plus per-contract, slightly above.** $75 plus $0.75 per contract, argued on filing coverage and the portal. Only defensible once one authority has accepted a report filed through the product; today that argument is a promise.
- **Keep $1.50 and sell the whole workflow.** Right only if the first providers are the pumping-and-service companies for which contracts are a minority of revenue. Nothing known yet says they are.

Whatever the number, the marketing page should show it beside the founder offer, and the review's observation holds: at $1.50 the Texas ceiling is low single-digit millions a year; the business is a niche one unless it grows to pumping-heavy work or other states.

## After the gates

With a provider on staging, the next engineering work is whatever the phone test and the provider's first week turn up, then the Fort Bend bulk-upload adapter (its 27-column schema is documented) and the row-lock and ruleset-retirement items the P3 follow-up left. Not before.
