import type { Database } from "@aerowise/db";
import { INSPECTING_CREDENTIALS, onboardingChecklist, onboardingChecklistFor } from "@aerowise/domain";
import { explainSite, loadCatalog } from "@aerowise/compliance";
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
      const { organizationId, role } = req.requireAuth();
      const today = await organizationToday(db, organizationId, now());

      // A license counts while it is active and not past its expiry date.
      const valid = db
        .selectFrom("providerCredentials")
        .select(["id", "userId", "kind"])
        .where("organizationId", "=", organizationId)
        .where("active", "=", true)
        .where((eb) => eb.or([eb("expiresOn", "is", null), eb("expiresOn", ">=", today)]));

      const [org, credentials, members, customers, quickbooks, sites, applicable, contracts, scheduled, reviewed, catalog] = await Promise.all([
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
        db.selectFrom("sites").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).executeTakeFirstOrThrow(),
        db.selectFrom("sites as s").innerJoin("siteAuthorityAssignments as a", (j) => j.onRef("a.id", "=", "s.authorityAssignmentId").onRef("a.organizationId", "=", "s.organizationId").onRef("a.siteId", "=", "s.id").onRef("a.jurisdictionId", "=", "s.jurisdictionId"))
          .select(["s.id", "s.county", "s.state", "s.jurisdictionId", "s.authorityAssignmentId", "s.useCategory", "s.permitIntervalMonths"])
          .where("s.organizationId", "=", organizationId).where("s.active", "=", true).where("a.jurisdictionId", "is not", null).where("a.evidenceKind", "is not", null).where("a.evidenceReference", "is not", null).execute(),
        db.selectFrom("contracts").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).where("status", "=", "active").executeTakeFirstOrThrow(),
        db.selectFrom("jobs").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).where("status", "in", ["scheduled", "in_progress", "completed"]).executeTakeFirstOrThrow(),
        db.selectFrom("reportSignatures").select((eb) => eb.fn.countAll<string>().as("n")).where("organizationId", "=", organizationId).executeTakeFirstOrThrow(),
        loadCatalog(db),
      ]);

      const inspecting = new Set(credentials.filter((c) => c.userId && INSPECTING_CREDENTIALS.includes(c.kind)).map((c) => c.userId));
      const inspectors = members
        .filter((m) => m.role === "technician" || inspecting.has(m.userId))
        .map((m) => ({ name: m.name, role: m.role, hasValidCredential: inspecting.has(m.userId) }));

      return onboardingChecklistFor({
        company: org,
        role,
        sites: Number(sites.n),
        applicableSites: applicable.filter((s) => explainSite(catalog, s, today).resolved?.jurisdictionId === s.jurisdictionId).length,
        contracts: Number(contracts.n),
        scheduledVisits: Number(scheduled.n),
        reviewedReports: Number(reviewed.n),
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
