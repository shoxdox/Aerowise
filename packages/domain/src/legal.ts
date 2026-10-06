import { z } from "zod";

// W8.3: the terms of service and privacy policy each company owner accepts. The text is a
// placeholder until Justin supplies lawyer-reviewed text. Changing either document means a
// new version here, and every owner is asked to accept again.

export const LEGAL_DOCUMENTS = ["terms", "privacy"] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

export const LEGAL_DOCUMENT_TITLES: Record<LegalDocument, string> = {
  terms: "Terms of service",
  privacy: "Privacy policy",
};

/** The version owners must have accepted. Bump one (never reuse a value) when its text changes. */
export const CURRENT_LEGAL_VERSIONS: Record<LegalDocument, string> = {
  terms: "2026-10-05-placeholder",
  privacy: "2026-10-05-placeholder",
};

/** The documents a user still has to accept: those whose current version they have not accepted. */
export function legalDocumentsDue(accepted: { document: string; version: string }[]): LegalDocument[] {
  return LEGAL_DOCUMENTS.filter((d) => !accepted.some((a) => a.document === d && a.version === CURRENT_LEGAL_VERSIONS[d]));
}

export const legalStatus = z.object({
  /** Only owners accept, on the company's behalf; for anyone else this is always empty. */
  due: z.array(z.enum(LEGAL_DOCUMENTS)),
  documents: z.array(
    z.object({
      document: z.enum(LEGAL_DOCUMENTS),
      title: z.string(),
      currentVersion: z.string(),
      /** This user's latest acceptance of this document in this organization, if any. */
      acceptedVersion: z.string().nullable(),
      acceptedAt: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
});
export type LegalStatus = z.infer<typeof legalStatus>;

/** The versions the owner was shown. A stale version (the text changed meanwhile) is refused. */
export const legalAcceptInput = z.object({ terms: z.string().min(1).max(100), privacy: z.string().min(1).max(100) });
