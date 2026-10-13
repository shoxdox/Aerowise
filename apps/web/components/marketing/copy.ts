// Homepage words. Rates and the list of authorities come from the API (/public/overview).
export const PUBLIC_DEMO_URL = "https://staging.deshain.com/demo";
export const PUBLIC_HOME_URL = "https://staging.deshain.com";

export const CONTACT = { email: "justin@deshain.com", phone: "(504) 435-6246", phoneHref: "tel:+15044356246" };

export const HERO = {
  eyebrow: "For Texas aerobic maintenance providers",
  title: "Never miss a four\u2011month visit or a county report deadline.",
  body: "Aerowise schedules every maintenance contract, puts the inspection on your technician's phone and prepares the report for your county, ready for you to sign and send.",
  primary: "Try the demo",
  secondary: "Book a walkthrough",
  note: "No sign-up. Opens a sample company with a year of visits and reports already in it.",
  office: { src: "/marketing/due-list.jpg", width: 2400, height: 1400, alt: "The Due inspections list: overdue and upcoming visits with gate, dog and call-ahead notes" },
  phone: { src: "/marketing/tech-route.jpg", width: 1170, height: 2400, alt: "A technician's route for the day on a phone" },
};

export const FEATURES = [
  {
    key: "office",
    label: "Office",
    title: "See what's due before it's overdue.",
    body: "Each contract's visits are scheduled from its start date and your county's interval. Overdue visits, report deadlines and contracts coming up for renewal are in one list every morning.",
    points: ["Visit windows follow each authority's rules", "Gate codes, dogs and access notes on every stop", "Renewals sent to the homeowner to sign online"],
  },
  {
    key: "field",
    label: "Field",
    title: "Inspections on the phone, with or without signal.",
    body: "Technicians open the day's route, tap through the inspection and add photos. Everything saves on the phone and sends itself once they're back in range.",
    points: ["iPhone and Android, nothing to install from an app store", "Your county's required answers checked before the visit is finished", "Photos and location attached to every visit"],
  },
  {
    key: "reports",
    label: "Reports",
    title: "Reports ready for your county.",
    body: "The report is filled in from the inspection, with your TCEQ license and your technician's registration on it. You read it and sign it. Where the authority takes reports by email, Aerowise sends it when you approve it; everywhere else you get the PDF and a record of when it went in.",
    points: ["LCRA's cover sheet filled in for you", "Every authority's report deadline tracked", "Proof of each submission kept with the site"],
  },
] as const;

export const SHOTS = {
  inspection: { src: "/marketing/tech-inspection.jpg", width: 1170, height: 2400, alt: "The inspection form on a phone: Pass and Fail buttons for the aerator, air filter and diffuser" },
  report: { src: "/marketing/report.jpg", width: 1020, height: 900, alt: "A sample aerobic maintenance inspection report with the provider's TCEQ license number" },
  cover: { src: "/marketing/lcra-cover-sheet.jpg", width: 992, height: 760, alt: "LCRA's maintenance contract and inspection report cover sheet, filled in" },
  inspectionCaption: "What the technician fills in",
  reportCaption: "The report, with LCRA's cover sheet filled in",
};

export const COUNTIES = {
  title: "Set up for the authorities you report to",
  intro: (n: number) => `Visit intervals, report deadlines and filing methods are built in for ${n} Texas authorities.`,
  emailed: "Report emailed for you",
  prepared: "Report prepared for you to submit",
  note: "Rules are compiled from each authority's published requirements, and we confirm yours with you during setup.",
  missing: "Work somewhere else?",
  ask: "Tell us which county",
};

export const PRICING = {
  title: "One price per contract",
  unit: "per active contract, per month",
  minimum: (amount: string) => `${amount} monthly minimum`,
  points: (days: number) => [`First ${days} days free`, "We import your customers, sites and contracts", "No per-user fees: add every office user and technician", "Office, phone app, reports and homeowner portal included"],
  calc: "Your active contracts",
  perMonth: "per month",
};

export const WALKTHROUGH = {
  title: "Book a walkthrough",
  body: "Tell us about your company and we'll set up a 20-minute call to go through Aerowise with your county's rules. If it's a fit, we import your customer list for you.",
  button: "Request a walkthrough",
  sending: "Sending…",
  privacy: "We only use this to get back to you.",
  thanks: "Thanks, we have your request.",
  reply: (email: string) => `We'll reply to ${email} to set up a time.`,
  duplicate: "We already had this one, so there's no need to send it again.",
  another: "Send another request",
  tooMany: `Too many requests from this connection. Please email ${CONTACT.email} instead.`,
  failed: `We couldn't send your request. Please try again, or email ${CONTACT.email}.`,
};

export const FOOTER = { tagline: "Software for Texas septic maintenance providers." };

export const DATA_HANDLING = {
  title: "How Aerowise handles your data",
  sections: [
    { id: "what", title: "What we keep", body: "Prospect requests contain the name, email, company and optional phone, counties and message supplied in the form. Company records include staff accounts, customer contacts, sites, systems, contracts, visits, inspection/work readings and photos, signatures, reports, filing evidence, renewals, estimates, invoices, payment references and audit history. Platform administrators can review prospect requests and perform authorized support actions; company access is scoped by organization and role." },
    { id: "devices", title: "Cookies and records on your phone", body: "Sign-in uses a first-party HttpOnly session cookie. The private fictional visitor demo lasts 24 hours; it is not a place for real customer information. The technician app uses browser storage for downloaded routes, answers, photos and records waiting to sync. Clearing that storage can erase unsent work. The walkthrough request form remembers only a retry key and request fingerprint in tab-session storage, allowing an unchanged request to retry after reload without saving its contact fields there. Starting another request replaces that retry information." },
    { id: "providers", title: "Configured service providers", body: "Aerowise can use Resend for email, Twilio for texts, Stripe for homeowner payments and Aerowise subscriptions, Intuit QuickBooks for one-way accounting sync, and Cloudflare R2 for file storage. US Census address lookup may be used for geocoding. These uses depend on the deployment and company settings. Fictional demo companies use stand-ins: no real messages, charges, accounting writes or authority submissions occur. Platform request alerts can also remain in a test outbox; the confirmation and admin queue distinguish that from provider acceptance." },
    { id: "export", title: "Taking your data with you", body: "An owner can request an export from Settings → Export, including while the subscription is read-only. The archive includes record CSVs, available report/invoice and work/disposal documents, and raw inspection/work photo bytes. Its manifest identifies included files and files that could not be found; review those entries before relying on the archive. Authentication secrets, standalone access tokens and payment credentials are excluded; application bearer links in exported record text are redacted. Invoice PDFs are clearly labeled portable copies without payment links, while the stored issued originals remain unchanged. Demo archives are marked fictional. Files that are absent from storage cannot be reconstructed by an export." },
    { id: "delete", title: "Deleting your data", body: "Contact Justin to request an operational company deletion, after downloading and checking an export. The platform deletion process removes company-scoped database records and the configured object-store namespace; the administrator must verify the result. If file cleanup fails, database access remains disabled and the failure is audited; an operator must finish and verify cleanup before claiming the stored bytes are gone. It retains the company tombstone (including name and plan metadata) and platform audit records of the action. Users shared with another organization remain there; otherwise they are deleted or anonymized if a retained record still references them. Deletion is not immediate erasure from every backup, provider system, exported file or device." },
    { id: "retention", title: "Retention and backups", body: "The repository's backup tooling defaults to 14 days of local backups and 35 days of offsite backups, with deployment configuration able to change those values. Those defaults are not a verified promise about the live environment. A production retention schedule, prospect-request cleanup schedule, restore/deletion reconciliation and service-provider retention review remain owner decisions before real-data use. Expired fictional demo access is disabled and its data is eligible for cleanup; expiration does not promise immediate erasure of backups." },
    { id: "contact", title: "Questions and requests", body: "Contact Justin at (504) 435-6246 or justin@deshain.com about access, correction, exports, deletion or support. We may need to establish your authority over the company or records before acting. No fixed support response time or backup-erasure deadline is promised by this early-access draft. Read the privacy policy and terms alongside this statement; owner and counsel review is pending before publication for real-data operation." },
  ],
};
