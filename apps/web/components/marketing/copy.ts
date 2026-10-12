// PLACEHOLDER COPY for the public marketing page. Justin edits the words here; the page
// layout, the county list and the prices come from elsewhere (the rulesets and the
// subscription config), so editing this file never changes what is true about coverage
// or price.

export const HERO = {
  title: "Aerobic septic maintenance, run in one place.",
  body: "Aerowise schedules your Texas aerobic maintenance visits, walks technicians through each inspection on their phone, and keeps each county report and its deadline in view until the authority acknowledges it.",
};

export const PROBLEM = {
  title: "The problem",
  points: [
    "Every county and river authority wants a different form, deadline and way of sending it.",
    "Visits, contracts and reports live in paper, spreadsheets and inboxes, so a missed visit or late report is easy to miss too.",
    "Renewals and invoices are chased by hand, one customer at a time.",
  ],
};

export const STEPS = {
  title: "How it works",
  items: [
    { title: "Bring your customers", body: "Import your spreadsheet of customers, sites and contracts. Aerowise works out who is due and when." },
    { title: "Run the route", body: "Technicians get the day's stops on their phone and fill in each inspection, offline if they need to." },
    { title: "File on time", body: "Aerowise prepares each report with the fields the authority's rules ask for, and fills in the official form where an authority has one (LCRA's cover sheet so far). Your licensed maintenance provider reviews and signs every report before it is sent." },
    { title: "Get paid and renew", body: "Invoices, renewals and a customer portal follow from the same records." },
  ],
};

export const COVERAGE = {
  title: "County coverage",
  intro: "Each authority's rules are built from its own published sources. Verified means we confirmed them with the authority directly.",
  draftLabel: "In progress",
  draftNote: "Built from public sources; being confirmed with the authority.",
  confirmedLabel: "Confirmed with the authority so far",
  empty: "Coverage is being added. Ask us about your county.",
};

export const PRICING = {
  title: "Pricing",
  /** Shown beside the configured price. The founder rate is set per company in /admin when it starts paying. */
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
  intro: "Tell us about your company and we will set up a walkthrough with your own counties.",
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
