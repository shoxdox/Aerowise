import type { Database } from "@aerowise/db";
import { CURRENT_LEGAL_VERSIONS, LEGAL_DOCUMENTS, legalAcceptInput, legalStatus } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { audit } from "../lib/audit.ts";
import { HttpError } from "../lib/errors.ts";
import { loadLegalStatus } from "../lib/legal.ts";

export const legalRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  app.get(
    "/legal",
    { config: { permission: "self:read" }, schema: { tags: ["auth"], summary: "The terms and privacy policy versions this user has accepted here, and which are due", response: { 200: legalStatus } } },
    async (req) => loadLegalStatus(db, req.requireAuth()),
  );

  app.post(
    "/legal/accept",
    {
      // An owner accepts on the company's behalf. A lapsed (read-only) company can still
      // accept, or its owner could never get back in to export their data.
      config: { permission: "org:manage", allowedWhenReadOnly: true },
      schema: {
        tags: ["auth"],
        summary: "Accept the current terms of service and privacy policy",
        description: "Send the versions you were shown. If either changed since, nothing is recorded and the answer is 409.",
        body: legalAcceptInput,
        response: { 200: legalStatus },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      if (LEGAL_DOCUMENTS.some((d) => req.body[d] !== CURRENT_LEGAL_VERSIONS[d])) {
        throw new HttpError(409, "legal_version_changed", "The terms or privacy policy changed since you opened them. Reload and read the new version.");
      }
      const at = now();
      await db.transaction().execute(async (trx) => {
        for (const document of LEGAL_DOCUMENTS) {
          const row = await trx
            .insertInto("legalAcceptances")
            .values({ organizationId: auth.organizationId, userId: auth.userId, document, version: CURRENT_LEGAL_VERSIONS[document], acceptedAt: at, requestId: req.id })
            .onConflict((oc) => oc.columns(["organizationId", "userId", "document", "version"]).doNothing())
            .returning("id")
            .executeTakeFirst();
          if (row) await audit(trx, req, { action: "legal.accepted", entityType: "legal_acceptance", entityId: row.id, changes: { document, version: CURRENT_LEGAL_VERSIONS[document] } });
        }
      });
      return loadLegalStatus(db, auth);
    },
  );
};
