import type { Database } from "@aerowise/db";
import { INSPECTING_CREDENTIALS, onboardingChecklist, onboardingChecklistFor } from "@aerowise/domain";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { organizationToday } from "../lib/today.ts";

/** The first-run checklist on the office home, worked out from the company's records each time. */
export const onboardingRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date }> = async (app, { db, now }) => {
  app.get(
    "/onboarding",
    {
      config: { permission: "users:read" },
      schema: { tags: ["organization"], summary: "First-run checklist for a new company", response: { 200: onboardingChecklist } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const today = await organizationToday(db, organizationId, now());

      // A license counts while it is active and not past its expiry date.
      const valid = db
        .selectFrom("providerCredentials")
        .select(["id", "userId", "kind"])
        .where("organizationId", "=", organizationId)
        .where("active", "=", true)
        .where((eb) => eb.or([eb("expiresOn", "is", null), eb("expiresOn", ">=", today)]));

      const [org, credentials, members, customers, quickbooks] = await Promise.all([
        db
          .selectFrom("organizations")
          .select(["name", "phone", "addressLine1", "city", "state", "postalCode", "serviceCounties", "responsibleCredentialId", "stripeChargesEnabled"])
          .where("id", "=", organizationId)
          .executeTakeFirstOrThrow(),
        valid.execute(),
        db
          .selectFrom("memberships as m")
          .innerJoin("users as u", "u.id", "m.userId")
          .select(["m.userId", "m.role", "u.name"])
          .where("m.organizationId", "=", organizationId)
          .where("m.active", "=", true)
          .execute(),
        db.selectFrom("customers").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).executeTakeFirstOrThrow(),
        db.selectFrom("quickbooksConnections").select("status").where("organizationId", "=", organizationId).executeTakeFirst(),
      ]);

      const inspecting = new Set(credentials.filter((c) => c.userId && INSPECTING_CREDENTIALS.includes(c.kind)).map((c) => c.userId));
      const inspectors = members
        .filter((m) => m.role === "technician" || inspecting.has(m.userId))
        .map((m) => ({ name: m.name, role: m.role, hasValidCredential: inspecting.has(m.userId) }));

      return onboardingChecklistFor({
        company: org,
        responsibleMpValid: credentials.some((c) => c.id === org.responsibleCredentialId && c.kind === "tceq_maintenance_provider"),
        inspectors,
        serviceCounties: org.serviceCounties.length,
        customers: Number(customers.n),
        stripeChargesEnabled: org.stripeChargesEnabled,
        quickbooksConnected: quickbooks?.status === "connected",
      });
    },
  );
};
