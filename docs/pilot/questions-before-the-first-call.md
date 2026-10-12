# Questions to answer before the first call, with recommended answers

Written October 12, 2026; answers recommended the same evening after Justin's first pass ("flexible on the customer, will do anything by hand, work from home, don't want to drive, don't know the price, a county saying no isn't the point"). Each question has a recommended answer and why. Change any of them; the point is that there is a written answer before the first call, not that these are right.

The situation they are written for: one person, not from the industry, who builds software and wants this to become side income. That shapes everything below. A company with a sales team would answer differently.

## 1. Who is the first customer, really?

**Recommended:** an owner-operated aerobic maintenance company with roughly 200 to 600 contracts, one or two technicians (often the owner is one), and one person in the office (often a spouse or one admin) who runs a spreadsheet, in Hays or Williamson County.

**Why not "all of them":** the product can serve a 1,000-contract shop with a dispatcher. The *pitch* cannot serve both at once. The small owner decides on the phone and feels the spreadsheet pain personally; the 1,000-contract shop has a dispatcher who has to be sold, a process that already works, and more to lose from a product nobody has used. For the first five, the small owner is cheaper to win, cheaper to support, and the test of the product is the same. Go bigger after one of them has been through ninety days. In the prospect list this means rows 1, 2, 3, 11, 14, 18, 21 before rows 5 and 6.

## 2. What am I willing to do by hand for the first five?

**Recommended:** everything that touches data, and nothing that touches a county.

Yes: import the spreadsheet and clean it (fix addresses, chase missing permit numbers from their files), set each site's county, set up their plans and contract terms, sit on a screen share for their first week, prepare their first report with them, build their renewal letters, answer the phone when a sync looks wrong. This is the whole reason a one-person company can win against Housecall Pro: you are the onboarding team they don't get elsewhere, and every hour you spend is research you can't buy.

No: submitting a report or contract to a county in the provider's name, or contacting a county on their behalf. The licensed provider is responsible for every report (it says so on the site), and a county hearing from a software vendor instead of the licensee is a bad first impression. You prepare; they send; you record it.

Write this exact sentence on the call: "I'll put your spreadsheet in and set up your counties for you, and I'll be on the phone your first week. You still press send to the county."

## 3. How far will I drive?

**Recommended:** you are right that the work is online. Make one exception: offer a single in-person half-day to the first provider only, if they are within two hours, and ride along with the technician for a morning.

**Why the exception:** every part of the product has been tested by agents, by you on two phones, and by nobody who does the job. Thirty minutes watching a technician work a stop with the phone in his hand will find more than a month of remote support (what he does with a wet hand, where he puts the phone while opening the tank, whether the form's order matches his order). After the first provider, screen shares are enough. If you are not within two hours of anyone on the list, ask the first technician to film a stop on his phone and send it; that is the fallback.

## 4. What is the number after ninety days?

**Recommended:** $0.50 per active contract per month with a $50 minimum (option A in [pricing-memo.md](pricing-memo.md)), and $0.25 per contract, same minimum, for the first five companies for as long as they stay. Decide this before the first call; the script needs it.

**What it means for side income, honestly:** five founder customers at 300 contracts each is $375 a month. That is not the side income; that is the entry fee. The side income is twenty to thirty providers at list price, which is $4,000 to $6,000 a month and a year or more of calls. The homeowner-payment fee through the portal (set per company in `/admin`, 0 to 10 percent) is the second line, and it only starts when a provider turns online payments on. Pricing low now does not cost you that; losing the first five calls on price would.

## 5. What do I do if the county says no to the sample report?

**Recommended:** your reading is right, with one refinement. The product does not need a county's blessing to be useful: it prepares the report and the provider submits it the way they do today, by hand or on the county's upload page, and it records that they did. A county that will only take its own form is a backlog item (add the form) and a "manual" filing in the meantime, not a stopper.

The refinement: where Aerowise *emails* the report itself (Williamson, LCRA, Brazoria, Denton, Harris), the first one sent for a real provider should be one they have read next to a report the county already accepted, and it goes only when they press Send. That is already how the product works. If that county writes back "use our form", you switch that county to prepare-and-record and keep going. Nothing about the pilot depends on a county saying yes.

## 6. How many hours a week can I give one provider for ninety days?

**Recommended:** as many as needed for the first one; take a second only once the first is through their first month; never more than three at once until one has finished ninety days.

**Why the cap even though you have the time:** the first provider's week one will produce a list of fixes. If three providers start the same week, you get three overlapping lists and no time to fix any of them before all three form an opinion. Sequence them.

## 7. Will I put my name and phone number on the website?

**Recommended:** yes, and this week. A "Who's behind this" paragraph on the homepage (your name, that you're a software builder in Texas and not from the industry, your phone and email), the same contact in the "Questions" section of the data-handling page, and the "Draft: placeholder" note on that page removed once the contact is in. An owner who takes your call will look you up; today they find a form.

Give Claude the name, phone and email to show, and it is an hour of copy work in `apps/web/components/marketing/copy.ts` plus the homepage and a spec update.

## 8. What is the one thing I want to learn from the first provider that no agent can tell me?

**Recommended:** two things, in this order.

1. **Does the technician keep using the phone app in week two without being asked?** Week one is novelty. If in week two he's back on paper, the product has failed at the thing it is for, and no amount of county coverage saves it. Measure it by looking at the inspections synced per week, not by asking.
2. **Does the office person stop opening the spreadsheet?** If they keep both, the import or the due-list is missing something they rely on. Ask them, once a week, "what did you open the spreadsheet for this week?"

Whether the county accepts the report is third. It matters, but it is a one-time fact per county, and the product is useful either way (question 5).

## 9. What would make me stop?

**Recommended:** a number, so you don't rationalize past it. Twenty conversations with an owner (not voicemails; actual conversations with the three questions answered) and not one "yes, send me the link" means the pitch or the target is wrong, and you stop calling and rethink, with the twenty answers in front of you. That is a pause to change the approach, not a quit.

A county refusing a report is never a stop (question 5). A provider quitting after a month is one data point; two quitting for the same reason is a product problem to fix before the next call.

## 10. Who is the licensed provider who reads the form, the PDF and the contract text once?

**Recommended:** the first customer's own licensed provider, as part of the ninety-day deal; it is already in the script. It costs them an hour and they are the person who will sign those reports, so their reading is the one that matters.

Backup, if the first customer is slow to start: pay an owner-operator who is too small to be a pilot (the "set aside" rows in the prospect list, such as a one-person Dripping Springs installer) $150 for an hour on a video call to go through the inspection form, one authority PDF and the contract wording. That is not a competitor relationship; it is a consultant hour.

One more for you, not for them: TCEQ approves a basic maintenance course that homeowners take to maintain their own aerobic system (Hays County's order mentions it). Check whether an approved provider offers it online; a day in that course would give you the vocabulary for every call on the list, and it's the cheapest way for someone outside the industry to stop sounding like it.

## The order to do these in

1. Decide question 4 (the price); tell Claude the option.
2. Answer question 7 (name, phone, email to show); Claude does the page in the same change.
3. Push, let CI deploy, open the homepage on your phone once.
4. Write the twenty-conversation number from question 9 at the top of the prospect list.
5. Call rows 1, 11 and 18.
