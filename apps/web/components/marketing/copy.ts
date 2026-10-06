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
  empty: "Coverage is being added. Ask us about your county.",
};

export const PRICING = {
  title: "Design-partner pricing",
};

export const RESPONSIBILITY =
  "Aerowise prepares and tracks filings. The licensed maintenance provider reviews and is responsible for every report sent to an authority.";

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
  draftNote: "Draft: this page is a placeholder. The final statement is still being written.",
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
      body: "Contact details will be listed here.",
    },
  ],
};
