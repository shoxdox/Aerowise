// Public words describe the implemented workflow. Rates and authority rules come from the API.
export const PUBLIC_DEMO_URL = "https://staging.deshain.com/demo";
export const PUBLIC_HOME_URL = "https://staging.deshain.com";

export const HERO = {
  eyebrow: "Early access · For Texas septic maintenance providers",
  title: "Keep visits, inspection records and report deadlines together.",
  body: "Schedule the route, inspect on the phone—even without a signal—and prepare the report for office review. One record connects the field work, filing evidence and homeowner follow-up.",
  facts: ["Fictional visitor demo", "Offline field workflow", "Provider review before filing"],
  shot: { src: "/marketing/office-due.png", alt: "Fictional demo company Due list with visit dates, overdue flags and site access notes", caption: "Real product capture · fictional demo records. Scroll the image on a phone to read the visit details." },
};
export const TRY_IT = {
  title: "Preview an inspection",
  intro: "Try the same answer fields the technician uses. This public example stays in your browser; it does not create an inspection, report or filing.",
  pick: "Reporting authority", authority: "Authority", visits: "Visit interval in this profile", report: "Draft report deadline", goes: "Filing method in this profile", extra: "Additional answer fields", renewal: "Renewal timing", corrective: "After a failed item", formLabel: "Example technician inspection answers",
  needs: (n: number, authority: string) => `${n} example ${n === 1 ? "answer" : "answers"} still needed for ${authority}`,
  ready: (authority: string) => `Example answers complete for ${authority}.`,
  readyNote: "In the app, required photos, site and system details, provider credentials, office review and signature must also be completed before a report can follow its filing method.",
  note: "Photos, location and the full report checks are outside this preview. Selecting a profile does not assign it to a real site.", reset: "Start over",
};
export const STEPS = {
  title: "Schedule → inspect → office reviews the report",
  items: [
    { title: "Schedule the right visit", body: "Bring customer, site and contract records together. Review the site's permit and authority before relying on a visit interval or reporting deadline." },
    { title: "Inspect on the phone", body: "Download the route, record readings and photos, and finish the inspection offline. The phone keeps work locally until it can send it to the office." },
    { title: "Review and record the filing", body: "The responsible provider reviews and signs. The office emails through a supported channel or downloads and submits manually, then keeps the submission evidence. Authority acceptance requires its own evidence." },
  ],
};
export const COVERAGE = {
  title: "Does your authority fit?",
  intro: "Profiles are built from public sources. Before live use, review the permit, system applicability, report format and submission process with the provider. A county can contain more than one reporting authority; the permit determines which applies.",
  groups: {
    email: { label: "Email preparation and sending", note: "The profile has a published inbox; provider review and configured delivery come first." },
    portal: { label: "Manual upload", note: "Download the report, upload through the authority's process, and record evidence." },
    prepared: { label: "Manual submission or channel to confirm", note: "Prepare and download the report. Confirm the actual channel with the provider; a published acknowledgment may not exist." },
  },
  draftLabel: "Public-source draft", draftNote: "This profile has not been verified by the authority. Applicability and unresolved requirements need review before live use.", confirmedLabel: "Authority-confirmed fields",
  empty: "No public profiles are available on this deployment. Contact Justin about your authority.", notYours: "Authority missing? Ask Justin to review your permit and current process. A request does not promise coverage or acceptance.",
};
export const PRICING = { title: "A clear offer after the pilot", founderLabel: "First-five founder offer", note: "The minimum is a floor, not an extra fee. Your company's subscription page is the source for its agreed rate and start/end dates." };
export const CONTACT = { line: "Contact Justin directly to discuss a supervised pilot:", footer: "Built in Texas by Justin. Early access: no real provider or authority has validated Aerowise yet.", phone: "(504) 435-6246", phoneHref: "tel:+15044356246", email: "justin@deshain.com" };
export const RESPONSIBILITY = "The licensed maintenance provider reviews and is responsible for every report. Prepared or submitted does not establish authority acceptance.";
export const TRY_DEMO = { button: "Explore the demo" };
export const DEMO = {
  title: "Talk to Justin about a pilot", intro: "Call or email for the most direct contact. You can also save a request in Aerowise's private admin queue.", button: "Save pilot request", thanks: "Your request is saved in the private admin queue.", tooMany: "Too many requests from this connection. If you already submitted, it may be saved; contact Justin directly.", failed: "We could not confirm whether your request saved. Retry with the same details, or contact Justin directly.",
};
export const DATA_HANDLING = {
  title: "How Aerowise handles your data",
  sections: [
    { id: "what", title: "What we keep", body: "Prospect requests contain the name, email, company and optional phone, counties and message supplied in the form. Company records include staff accounts, customer contacts, sites, systems, contracts, visits, inspection/work readings and photos, signatures, reports, filing evidence, renewals, estimates, invoices, payment references and audit history. Platform administrators can review prospect requests and perform authorized support actions; company access is scoped by organization and role." },
    { id: "devices", title: "Cookies and records on your phone", body: "Sign-in uses a first-party HttpOnly session cookie. The private fictional visitor demo lasts 24 hours; it is not a place for real customer information. The technician app uses browser storage for downloaded routes, answers, photos and records waiting to sync. Clearing that storage can erase unsent work. Public inspection-preview answers stay in browser memory and disappear when the page reloads." },
    { id: "providers", title: "Configured service providers", body: "Aerowise can use Resend for email, Twilio for texts, Stripe for homeowner payments and Aerowise subscriptions, Intuit QuickBooks for one-way accounting sync, and Cloudflare R2 for file storage. US Census address lookup may be used for geocoding. These uses depend on the deployment and company settings. Fictional demo companies use stand-ins: no real messages, charges, accounting writes or authority submissions occur. Platform request alerts can also remain in a test outbox; the confirmation and admin queue distinguish that from provider acceptance." },
    { id: "export", title: "Taking your data with you", body: "An owner can request an export from Settings → Export, including while the subscription is read-only. The archive includes record CSVs, available report/invoice and work/disposal documents, and raw inspection/work photo bytes. Its manifest identifies included files and files that could not be found; review those entries before relying on the archive. Authentication secrets, access tokens and payment credentials are excluded. Demo archives are marked fictional. Files that are absent from storage cannot be reconstructed by an export." },
    { id: "delete", title: "Deleting your data", body: "Contact Justin to request an operational company deletion, after downloading and checking an export. The platform deletion process removes company-scoped database records and the configured object-store namespace; the administrator must verify the result. It retains the company tombstone (including name and plan metadata) and platform audit records of the action. Users shared with another organization remain there; otherwise they are deleted or anonymized if a retained record still references them. Deletion is not immediate erasure from every backup, provider system, exported file or device." },
    { id: "retention", title: "Retention and backups", body: "The repository's backup tooling defaults to 14 days of local backups and 35 days of offsite backups, with deployment configuration able to change those values. Those defaults are not a verified promise about the live environment. A production retention schedule, prospect-request cleanup schedule, restore/deletion reconciliation and service-provider retention review remain owner decisions before real-data use. Expired fictional demo access is disabled and its data is eligible for cleanup; expiration does not promise immediate erasure of backups." },
    { id: "contact", title: "Questions and requests", body: "Contact Justin at (504) 435-6246 or justin@deshain.com about access, correction, exports, deletion or support. We may need to establish your authority over the company or records before acting. No fixed support response time or backup-erasure deadline is promised by this early-access draft. Read the privacy policy and terms alongside this statement; owner and counsel review is pending before publication for real-data operation." },
  ],
};
