# Pricing decision memo

Written October 12, 2026, for Justin. Nothing in the code or the environment has been changed; the last section says exactly what changes once you choose.

## The numbers on the table

- **Fieldbase On-Site** (direct competitor, same customer, same thesis): Solo $50/month up to 100 contracts; Teams $50/month plus $0.50 per active contract.
- **Aerowise today** (`DEFAULT_SUBSCRIPTION_CONFIG` in `packages/domain/src/subscription.ts`): $1.50 per active contract per month with a $99 monthly minimum, after 90 free days. The charge is `max(contracts × price, minimum)`: the minimum is a floor, not a base fee added on top.
- A homeowner's annual maintenance contract runs roughly $200 to $500. Fieldbase takes about $6 a year per contract plus $600; Aerowise at $1.50 takes $18 a year per contract, 4 to 9 percent of the homeowner's price.
- Aerowise already has a second revenue line Fieldbase's public page does not show: a platform fee on homeowner payments taken through the portal (Stripe Connect), set per company in `/admin` from 0 to 10 percent. It is 0 until you set it.

## What each option means per month and per year

Two reference providers: 300 active contracts (an owner with one or two techs) and 1,000 (a dispatcher and three or four techs).

| Option | 300 contracts | 1,000 contracts | Fieldbase Teams, same size |
|---|---|---|---|
| **A. Match:** $0.50/contract, $50 minimum | $150/mo · $1,800/yr | $500/mo · $6,000/yr | $200/mo · $2,400/yr; $550/mo · $6,600/yr |
| **B. Slightly above:** $0.75/contract, $75 minimum | $225/mo · $2,700/yr | $750/mo · $9,000/yr | as above |
| **C. Keep:** $1.50/contract, $99 minimum | $450/mo · $5,400/yr | $1,500/mo · $18,000/yr | as above |

As a share of the provider's contract revenue (300 contracts at $200–500 each is $60k–150k a year): A is 1.2–3%, B 1.8–4.5%, C 3.6–9%.

Note on A and B: because Aerowise charges a floor rather than a base fee, "match" at $0.50 with a $50 floor comes in $50 a month *under* Fieldbase Teams at every size above 100 contracts. Fieldbase's exact shape ($50 base plus per-contract) would need a base-fee line in `monthlyCharge` and on the Stripe invoice, a half-day change with tests. The floor is simpler and cheaper for the customer; I would not add a base fee to copy them.

## What each option needs to be true

**A. Match, then charge for what Fieldbase doesn't have.**
Price is removed from the first conversation: nobody chooses Fieldbase over Aerowise on cost, and the call is about filing and the phone app. Revenue comes later from the portal's payment fee (a provider collecting $100k a year through the portal at a 2% fee is $2,000 a year, more than the subscription at 300 contracts), and from charging for estimates, deposits, pumping records and QuickBooks sync once a provider is using them. Needs to be true: that a provider actually turns on online payments (the portal exists; nobody has used it), and that you are content with a small per-seat number for the first year while you learn whether the product earns more. Risk: it anchors low, and raising a list price on early customers is a conversation; founder prices are forever by promise, so the raise would apply only to new customers.

**B. Base plus per-contract, slightly above.**
Argued on filing coverage (21 county profiles, five with email filing) and the portal. Needs to be true: at least one authority has accepted a report prepared by the product, so "we file in your county" is a fact and not a promise. Today it is a promise. Until then the extra $75 a month at 300 contracts buys the owner nothing they can see on the call, and the Fieldbase comparison costs you the deal before the demo. Right after the first accepted filing, this becomes the natural list price.

**C. Keep $1.50 and sell the whole workflow.**
Right only for companies where maintenance contracts are a minority of revenue (pumping, repairs, installs) and the subscription is noise against work-order margins; for them $450 a month for scheduling, estimates, deposits, disposal records and invoicing is a reasonable ask against ServiceTitan-class pricing. Needs to be true: that the first five providers are those companies. Nothing known says so, and the counties where our rules are deepest (Hays, Williamson, LCRA) are residential-aerobic territory, where contracts are the business. At $1.50 the review's arithmetic also caps Texas at low single-digit millions a year, so the price does not even buy a big outcome.

## Recommendation

Choose **A** now and write it on the page: $0.50 per active contract per month with a $50 minimum, free for 90 days, and a founder rate of $0.25 per contract (same $50 minimum) for the first five companies, fixed for as long as they stay. It makes the first calls about the work, not the price; it is honest about a product no provider has used; it leaves the portal fee and the add-on features as the way to earn more once someone is using them; and it costs almost nothing in revenue in year one, when the number of customers is five. Revisit the list price (toward B) the week the first county accepts a filed report, and only for companies that sign after that day.

## What changes when you decide (do none of it until you say which)

1. **The configured price.** In the deployment settings files on the server, `/etc/aerowise/staging.env` and later `/etc/aerowise/production.env` (see `docs/engineering/DEPLOY.md`), set:
   - Option A: `AEROWISE_PRICE_PER_CONTRACT_CENTS=50` and `AEROWISE_MONTHLY_MINIMUM_CENTS=5000`
   - Option B: `AEROWISE_PRICE_PER_CONTRACT_CENTS=75` and `AEROWISE_MONTHLY_MINIMUM_CENTS=7500`
   - Option C: leave both unset (defaults 150 and 9900), or set them explicitly.
   
   The API reads them at start (`subscriptionConfigFromEnv`), so a container restart or the next deploy applies them. The settings check refuses anything that is not a whole number of cents. The defaults in `DEFAULT_SUBSCRIPTION_CONFIG` can stay as they are, or be changed to the chosen option in the same commit so a fresh install matches; either is one line each.

2. **The founder price per company.** In `/admin`, each organization's plan form has "Founder price per active contract ($/month)" and a founder monthly minimum. Blank means the configured price. For the first five under option A, enter 0.25 and leave the minimum blank (so $50 applies), when you move each from `design_partner` to `active` at the end of their 90 days. The change is written to the platform audit log.

3. **The marketing copy** in `apps/web/app/page.tsx` (around line 96) and `apps/web/components/marketing/copy.ts` (`PRICING.title`, "Design-partner pricing"). The per-contract figure and the minimum are already read from the API (`data.pricing`), so they update by themselves when the environment changes. What the page does not say yet, and should, is the founder offer beside the list price: one sentence such as "The first five companies pay $0.25 per contract for as long as they stay." That is a copy edit and a test update, not a feature. Note that `e2e/marketing.spec.ts` (line 26) asserts the literal "$1.50 per active contract per month, with a $99.00 monthly minimum.", so changing the defaults in `DEFAULT_SUBSCRIPTION_CONFIG` means changing that line; changing only the server's environment does not.

4. **The two drafts that quote a number.** `call-script.md` and `cold-email.md` in this folder say "[the number]" and "founder price that doesn't go up"; fill them in the same day.

5. **A dated entry in `docs/DECISIONS.md`** saying which option, the founder number, and that it applies to list price for companies signing after the date.

Nothing here touches Stripe: monthly invoices are built from the configured or founder price at billing time, and no company is `active` yet.
