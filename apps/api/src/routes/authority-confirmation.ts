import { confirmationsFor, loadCatalog, loadConfirmations } from "@aerowise/compliance";
import type { Database } from "@aerowise/db";
import { authorityConfirmation, confirmationSummary } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound } from "../lib/errors.ts";

/**
 * W12.V4: for the site and filing authority panels (W10.5), how far an authority's filing
 * questions are confirmed, per field. Only states: who answered and what they said stay on
 * the platform admin page.
 */
export const authorityConfirmationRoutes: FastifyPluginAsyncZod<{ db: Database }> = async (app, { db }) => {
  app.get(
    "/jurisdictions/:id/confirmation",
    {
      config: { permission: "crm:read" },
      schema: {
        tags: ["filings"],
        summary: "How far where reports go, format, signature, where contracts go and receipt are confirmed with the authority",
        params: z.object({ id: z.uuid() }),
        response: { 200: authorityConfirmation },
      },
    },
    async (req) => {
      req.requireAuth();
      const entry = (await loadCatalog(db)).find((e) => e.jurisdiction.id === req.params.id && e.jurisdiction.active);
      if (!entry) throw notFound("Authority");
      const fields = confirmationsFor(await loadConfirmations(db, entry.jurisdiction.id), entry.jurisdiction.id);
      return { jurisdictionId: entry.jurisdiction.id, key: entry.jurisdiction.key, fields, summary: confirmationSummary(fields) };
    },
  );
};
