# Cold-call script: owner of an aerobic maintenance company

Written October 12, 2026. A draft for Justin; nothing here has been said to anyone. About two minutes if the owner answers the three questions; longer only if they ask for it. Read it once, then put it down and talk.

## Before dialing

- Have their county's one-pager ([filing-one-pager.md](filing-one-pager.md)) open, and know which county their customers are mostly in.
- Know what their website showed about software (the prospects list says what was seen).
- Call between 8 and 10 in the morning or after 3; techs are on the road in between and the owner is often one of them.
- If a dispatcher answers: "Is the owner around? I'm not selling anything today, I'm trying to learn how maintenance companies handle the county reports. Ten minutes some time this week is plenty." Take a time; do not pitch the dispatcher.

## Open (fifteen seconds)

> Hi, this is Justin. I'm not in the septic business. I've spent the last few months building software for aerobic maintenance companies in Central Texas, and before I show it to anyone I'm calling owners to find out how the county reporting actually works day to day. Have you got five minutes? I have three questions and then I'll get out of your way.

If no: "When's better, early morning or late afternoon?" Write it down and call back then. Do not pitch.

## The three questions (get all three before any pitch)

Ask them in this order and write the answers down word for word. Let silence do the work; owners fill it.

**1. What do you use today?**

> How do you keep track of your contracts and the four-month visits right now? Spreadsheet, QuickBooks, Jobber, something built for septic?

Follow-ups if short: "And the tech in the field, does he fill out paper, or is it on his phone?" "Who turns that into the county's report, and when?"

**2. What do you hate about filing?**

> When the report has to go to the county, what's the part that eats your time or goes wrong?

Follow-ups: "Which county is the worst?" "Has one ever bounced a report back, and what for?" "How do you know a report actually got there?" "What happens the week a contract renews?"

**3. What would make you switch?**

> If you were going to change how you do this, what would it have to do for you that today's setup doesn't? And what would stop you, even if it did?

Follow-ups: "Is it the price, the data move, or the techs learning something new?" "Who would have to say yes besides you?"

If the three answers are "spreadsheet, nothing really, nothing", thank them, ask if there's a company they know that is drowning in it, and end the call. That is a useful call.

## The offer (only if question 3 left a door open)

> Here's what I'm doing with the first few companies, and I'll be straight about where it stands. No maintenance company has used it yet; you'd be the first or one of the first five. So I'm not selling it. The deal is:
>
> - Ninety days free, no card.
> - You send me the spreadsheet you have, however messy, and I put it in for you. You don't type anything.
> - For your county, I prepare one real four-month report with your licence number on it, we look at it together against what the county accepted last time, and if the county will take it we send it. If they won't, you've lost nothing and I've learned something.
>
> What I need back is about an hour a week of one technician's time using the phone app on real stops, and once, an hour of yours or your licensed provider's reading our inspection form, the report that goes to the county, and the contract wording, and telling me what's wrong. You know this work and I don't.

Then stop talking.

If yes or maybe: "Can I send you a link to a demo you can poke at on your phone, and a one-page note on how your county's filing would work? Then we pick a day for the spreadsheet." Get the email. Confirm the county. That is the whole close.

## Objections, with answers that do not oversell

**"We use Jobber (or Housecall Pro, or ServiceTitan)."**
> Keep it. Jobber is good at scheduling and invoicing and I'm not asking you to rip it out. What it doesn't know is that Hays wants a report within fourteen days of a visit, or that a renewal has to be in before the old contract ends. For ninety days you'd run the contracts and the county reports in mine alongside Jobber and see if it earns its keep. If it doesn't, you export everything and I'm gone.

(Do not promise a Jobber integration. There is none.)

**"The county takes our PDF just fine."**
> Then that part isn't your problem, and I'd rather know that than pretend. Where I'd still want to look is the tracking: which of your four hundred sites is due this month, which report never got sent, which contract lapses in thirty days. If you already have that under control, you don't need me, and I'll say so.

**"What happens to my data?"**
> It's yours. It sits in a database in a Texas-registered company's account, one company's data is never visible to another, and you can download all of it, customers, sites, contracts, reports and photos, any time, including the day you leave. I'm one person with a product no provider has used; if that worries you, run it alongside what you have and don't turn the old thing off. There's a plain-English page on this at the bottom of the site.

(This is true: every export exists, and the data-handling page is at `/data-handling`. Do not claim SOC 2 or any certification.)

**"Who are you?"**
> I'm Justin, I'm in [city], and I'm not from the industry. I started this because the Texas rules for aerobic maintenance are specific enough that general software doesn't handle them, and small enough that the big companies won't bother. I've built the product with county rules from public sources; what I haven't done is work a day in your business, which is why I'm calling instead of emailing you a brochure.

**"What does it cost after the ninety days?"**
> [Say the number you decided in the pricing memo, per contract per month, and the minimum.] For the first five companies I'm setting a founder rate that stays for as long as you're a customer. I'll put it in writing before the ninety days are up, and you decide then, not now.

(Do not quote a number until the pricing decision is made. If asked before then: "I'm settling that with the first companies; I'll tell you before you'd ever pay anything.")

**"Does it file with the county for me?"**
> For some counties it emails the report; for others, including [theirs, check the one-pager], the county hasn't published where providers send reports, so it prepares the report and you send it the way you do today, and it records that you did. I won't tell you a county accepts it until that county has told me so.

**"My techs won't use an app."**
> Fair. It works with no signal, it's a web page added to the home screen, not an app store download, and a stop is about the same taps as the paper form. The hour a week I'm asking for is exactly to find out whether your tech agrees with me.

**"Call me in a few months."**
> Will do. Can I ask one more thing: is there anything about the four-month cycle that's about to bite you in the next few months, a renewal wave, a new county rule? If I send you one email and the demo link, will that be a bother?

## After the call, within ten minutes

Write down, in [prospects.md](prospects.md) next to their row: the three answers verbatim, the county, the software, the objection you heard, and the next step with a date. If they said yes to the email, send the first email from [cold-email.md](cold-email.md) adjusted with one line from the call. Nothing else.
