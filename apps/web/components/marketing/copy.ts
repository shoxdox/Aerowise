// PLACEHOLDER COPY for the public marketing page. Justin edits the words here; the page
// layout, the county list and the prices come from elsewhere (the rulesets and the
// subscription config), so editing this file never changes what is true about coverage
// or price.

export const HERO = {
  eyebrow: "For Texas aerobic maintenance companies",
  title: "Every four-month visit and every county report, on time.",
  body: "Aerowise keeps each maintenance contract's visits on the county's schedule, puts the inspection on your technician's phone (no signal needed), and prepares the report with your licence on it. You read it and press Send.",
  /** Three plain facts under the buttons. Each must stay true; the first is counted from the rulesets. */
  facts: ["Texas authorities' rules built in", "Works with no signal on the phone", "Free for 90 days, no card"],
};

export const PROBLEM = {
  title: "What changes",
  todayLabel: "Today",
  afterLabel: "With Aerowise",
  pairs: [
    {
      today: "Which sites are due this month lives in a spreadsheet and in someone's head.",
      after: "The due list comes from the contracts: every visit, every report deadline and every renewal, by county.",
    },
    {
      today: "The technician fills in a paper form; the office retypes it into the county's report.",
      after: "The technician answers the form on the phone, photos included, and the report writes itself with your licence number on it.",
    },
    {
      today: "Every county and river authority wants a different form, deadline and inbox.",
      after: "Each authority's rules are built in from its published order. Where one publishes an inbox, Aerowise emails the report when you press Send.",
    },
  ],
};

export const STEPS = {
  title: "How it works",
  items: [
    { title: "Bring your customers", body: "Send your spreadsheet, however messy. Aerowise works out which column is which and who is due when; for the first companies, we import it for you." },
    { title: "Run the route", body: "Technicians get the day's stops on their phone and fill in each inspection where they stand, offline if they need to. Photos and GPS come with it." },
    { title: "File on time", body: "The report is prepared with the fields the authority asks for and the official form where there is one. Your licensed provider reviews it; nothing goes to a county on its own." },
    { title: "Get paid and renew", body: "Invoices, renewals signed on the homeowner's phone, and a customer portal follow from the same records." },
  ],
};

export const COVERAGE = {
  title: "County coverage",
  intro: "Each authority's rules are built from its own published order and marked in progress until that authority has confirmed them. Where one publishes an inbox, Aerowise emails the report when you press Send; everywhere else it prepares the report for you to send as you do today, and keeps the record.",
  draftLabel: "In progress",
  draftNote: "Built from public sources; being confirmed with the authority.",
  confirmedLabel: "Confirmed with the authority so far",
  empty: "Coverage is being added. Ask us about your county.",
  notYours: "Your county not here? Say which one in the demo request and it goes next.",
};

export const PRICING = {
  title: "Pricing",
  perContract: "per active contract per month",
  minimum: "monthly minimum",
  /** Shown beside the configured price. The founder rate is set per company in /admin when it starts paying. */
  founderLabel: "Founder offer",
  founder: "The first five companies pay $0.25 per active contract per month, same minimum, for as long as they stay.",
  note: "No card to start. Your data is yours to download at any time, including the day you leave.",
};

export const ABOUT = {
  title: "Who's behind this",
  body: "I'm Justin. I build software, I'm in Texas, and I'm not from the septic industry. I built Aerowise because the rules for aerobic maintenance here are specific enough that general scheduling software doesn't handle them, and the companies that live by them are small enough that the big vendors won't bother. No maintenance company has used it yet; the first few will shape it, and I do the setup for them. Call or write any time.",
  phone: "(504) 435-6246",
  phoneHref: "tel:+15044356246",
  email: "justin@deshain.com",
};

export const RESPONSIBILITY =
  "Aerowise prepares and tracks filings. The licensed maintenance provider reviews and is responsible for every report sent to an authority.";

/** "Try the demo": shown only on the demo deployment, where /demo answers (W11.4). */
export const TRY_DEMO = {
  button: "Try the demo",
};

export const DEMO = {
  title: "Ask for a demo",
  intro: "Tell me about your company and I'll set up a walkthrough with your own counties, or call the number above.",
  button: "Ask for a demo",
  thanks: "Thanks. We got your request and will be in touch soon.",
  tooMany: "We already have a few requests from you. We will be in touch soon.",
  failed: "Could not send your request. Please try again.",
};

/**
 * The public data-handling page. Placeholder wording that describes what the software does
 * today; Justin supplies the statement itself (W5.6, "Needs from Justin").
 */
export const DATA_HANDLING = {
  title: "How Aerowise handles your data",
  sections: [
    {
      id: "what",
      title: "What we keep",
      body: "The records your company enters or imports: customers, sites, systems, contracts, visits, inspections, reports, invoices and payments, plus the files that go with them. Each company's records are kept apart from every other company's.",
    },
    {
      id: "export",
      title: "Taking your data with you",
      body: "The owner of a company can download everything at any time from Settings, Export: a zip of spreadsheet files and every report and invoice PDF. This works even when the account is read-only.",
    },
    {
      id: "delete",
      title: "Deleting your data",
      body: "Ask us and we delete your company's records and files. We keep only a note that the deletion happened, who asked, and when. Please download an export first: deletion cannot be undone.",
    },
    {
      id: "contact",
      title: "Questions",
      body: "Justin, (504) 435-6246, justin@deshain.com. Questions about your data, an export or a deletion go to that address.",
    },
  ],
};
