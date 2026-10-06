import type { Database } from "@aerowise/db";
import { CURRENT_LEGAL_VERSIONS, LEGAL_DOCUMENT_TITLES, LEGAL_DOCUMENTS, legalDocumentsDue, type LegalStatus, type Role } from "@aerowise/domain";

/** Where a user stands on the terms and privacy policy in one organization. Only owners ever have documents due. */
export async function loadLegalStatus(db: Database, auth: { organizationId: string; userId: string; role: Role }): Promise<LegalStatus> {
  const rows = await db
    .selectFrom("legalAcceptances")
    .select(["document", "version", "acceptedAt"])
    .where("organizationId", "=", auth.organizationId)
    .where("userId", "=", auth.userId)
    .orderBy("acceptedAt", "desc")
    .execute();
  return {
    due: auth.role === "owner" ? legalDocumentsDue(rows) : [],
    documents: LEGAL_DOCUMENTS.map((document) => {
      const latest = rows.find((r) => r.document === document);
      return {
        document,
        title: LEGAL_DOCUMENT_TITLES[document],
        currentVersion: CURRENT_LEGAL_VERSIONS[document],
        acceptedVersion: latest?.version ?? null,
        acceptedAt: latest?.acceptedAt.toISOString() ?? null,
      };
    }),
  };
}
