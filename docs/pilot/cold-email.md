# Cold email sequence: two emails, plain text

Written October 12, 2026. Drafts for Justin; nothing sent. Each is under 120 words, written for an owner reading on a phone between stops. Plain text, no images, no signature block beyond a name and phone. Send from your own address, one owner at a time, with their county filled in. Change nothing in square brackets to marketing language.

## Email 1: first touch

Subject: `[County] four-month reports`

```
[First name],

I build software for aerobic maintenance companies in Central Texas. No provider has used it yet, and I'm looking for the first few.

It tracks each contract's four-month visits, the technician does the inspection on a phone with no signal, and it prepares the [County] report with your licence number on it. Where a county publishes an email address it sends the report; where it doesn't, it gives you the PDF and records that you sent it.

Demo, no password: https://staging.deshain.com

If you'd try it, I'll put your spreadsheet in for you and it's free for ninety days. If not, a reply saying what you use today would still help me.

Justin
[phone]
```

(118 words.)

## Email 2: follow-up, one week later

Subject: `Re: [County] four-month reports`

```
[First name],

One follow-up, then I'll leave you alone.

Two things I didn't say last week. After the free ninety days it's $0.50 per contract a month, and the first five companies pay $0.25 for as long as they stay. And the first real [County] report goes out only after you've read it against one the county already accepted. If the county won't take it, you've lost an hour.

What I need back: a technician using the phone app for about an hour a week, and you reading the report and contract wording once.

The demo is still at https://staging.deshain.com if you want to look first.

If this isn't for you, no need to reply.

Justin
[phone]
```

(114 words.)

## Notes

- One-line adjustment after a phone call: replace the first sentence of email 1 with "Good talking to you this morning." and cut the last paragraph.
- Do not attach the one-pager to the first email; offer it in the follow-up only if they replied.
- The $0.25 founder rate is a promise for as long as they stay; it is set per company in `/admin` when they start paying. Ready-to-send versions for the prospects with a published business email are in [cold-emails-ready.md](cold-emails-ready.md).
- The demo link is the staging site, which CI redeploys on every green push to `main` (`aee751a`, with the technician app's sign-in banner fix, went live October 12).
