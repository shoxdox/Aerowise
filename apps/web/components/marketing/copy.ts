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
  /** The office's Due list, captured from the demo company. */
  shot: { src: "/marketing/office-due.png", alt: "The office's Due page: 32 open visits, five overdue, each with its window and access notes", caption: "The office's Due list, captured from the demo company." },
};

/** The inspection form and a county's rules, live on the page (components/marketing/TryIt.tsx). */
export const TRY_IT = {
  title: "Try it here",
  intro: "Pick a county and fill in the inspection the way a technician would. This is the same form the phone runs and the same rules the office applies; nothing is sent anywhere.",
  pick: "Your county",
  authority: "Authority",
  visits: "Visits",
  report: "Report due",
  goes: "Where it goes",
  extra: "This county also wants",
  renewal: "Renewal due",
  corrective: "After a failed item",
  formLabel: "The inspection form, as on the technician's phone",
  needs: (n: number, county: string) => `${n} ${n === 1 ? "thing" : "things"} still needed before the ${county} report can be prepared`,
  ready: (county: string) => `Ready: the ${county} report can be prepared.`,
  readyNote: "On the phone it would now carry the photos, the GPS fix and your licence, and go to the office to read and send.",
  note: "Photos and the GPS fix are taken on the phone, so they are left out here.",
  reset: "Start over",
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
  intro: "Each authority's rules are built from its own published order, and marked in progress until that authority has confirmed them. What happens to a finished report depends on what the authority publishes:",
  groups: {
    email: { label: "Emailed when you press Send", note: "The authority publishes an inbox for reports." },
    portal: { label: "You upload it on the authority's page", note: "Aerowise prepares the file and records the upload." },
    prepared: { label: "Prepared for you to send as you do today", note: "No provider channel is published; Aerowise keeps the record." },
  },
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

/** Who to call. Shown with the demo form and in the footer, not as a section of its own. */
export const CONTACT = {
  line: "Or call Justin, who built it:",
  footer: "Built in Texas by Justin. No maintenance company has used it yet; the first few will shape it.",
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
  intro: "Tell me about your company and I'll set up a walkthrough with your own counties.",
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
