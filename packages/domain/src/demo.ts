// A demo company is fictional (the public demo, and later each prospect's own demo). These
// are the same rules migration 0039 enforces in the database, for screens and checks that
// want to say so before saving.

/** An address at a domain reserved for examples (RFC 2606/6761); blank counts as fictional. */
export function isFictionalEmail(email: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  return e === "" || /@([a-z0-9-]+\.)*(example\.(com|net|org)|(example|test|invalid|localhost))$/.test(e);
}

/** A US number in 555-0100 to 555-0199, the range set aside for fiction; blank counts as fictional. */
export function isFictionalPhone(phone: string | null | undefined): boolean {
  const p = (phone ?? "").trim();
  return p === "" || /^1?[2-9][0-9]{2}55501[0-9]{2}$/.test(p.replace(/[^0-9]/g, ""));
}

/** What the banner says in a demo company, on every screen. */
export const DEMO_NOTICE = "Fictional demo company. Nothing is emailed, texted, filed or charged, and the data is reset regularly.";
