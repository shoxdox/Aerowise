import { latestPaymentFailed } from "../lib/public-payment-state.ts";
import type { Database, DB } from "@aerowise/db";
import {
  addDays,
  addonInput,
  addonPatch,
  amountDue,
  CONSENT_TEXT,
  contractInstallments,
  DEFAULT_RENEWAL_TERMS,
  defaultAgreementTerms,
  id,
  isSignable,
  publicRenewal,
  RENEWAL_STATUSES,
  renewalAddon,
  renewalCharges,
  renewalDeclineInput,
  renewalDetail,
  renewalList,
  renewalOfferPatch,
  renewalSettings,
  renewalSettingsInput,
  renewalSignInput,
  intakeAnswers,
  parsePlanOptions,
  type AgreementContent,
  type ChosenAddon,
  type Feature,
  type PlanOption,
  type PublicRenewal,
  type RenewalDetail,
  type RenewalSettings,
  type RenewalStatus,
} from "@aerowise/domain";
import { invoiceEvent } from "@aerowise/payments";
import { activateRenewal, agreementCycles, canonicalJson, coverageLines, createRenewal, loadPlanVersion, offerTerms, RenewalError, renewalOnTimeline, sha256Hex, systemAudit } from "@aerowise/renewals";
import type { ObjectStore } from "@aerowise/storage";
import { enqueue, linkTokenId, payUrlFor, providerFor, queueQuickBooksSync, queueRenewalEmail, RENEWAL_AGREEMENT, renewUrlFor, runRenewalSweep } from "@aerowise/tasks";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { FastifyReply, FastifyRequest } from "fastify";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { audit } from "../lib/audit.ts";
import { canPayOnline, openCheckout, openInvoiceById } from "../lib/checkout.ts";
import { HttpError, notFound, unprocessable } from "../lib/errors.ts";
import { perAddress, type PublicLinkLimits } from "../lib/rate-limits.ts";
import { issueDraft, writeDraftLines, type PaymentsConfig } from "../lib/invoices.ts";
import { definedOnly } from "../lib/json.ts";
import { organizationToday } from "../lib/today.ts";
import { readForDownload } from "../lib/demo.ts";

const params = z.object({ id });
// Any shape is looked at: a token that is not a signed link is simply not found (`linkTokenId`).
const token = z.object({ token: z.string().min(1).max(200) });
const publicLimit = { max: 30, timeWindow: "1 minute" };
const notFoundLink = () => new HttpError(404, "not_found", "This renewal link is not valid. Contact your service provider for a new one.");

const joinAddress = (parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");
const cityLine = (city: string | null, state: string | null, postal: string | null) => [city, [state, postal].filter(Boolean).join(" ")].filter(Boolean).join(", ");
const iso = (d: Date | null) => d?.toISOString() ?? null;

const CLOSED_MESSAGE: Partial<Record<RenewalStatus, string>> = {
  signed: "This renewal is already signed",
  payment_pending: "This renewal is already signed",
  paid: "This renewal is already signed",
  activated: "This renewal is complete",
  declined: "This renewal was declined",
  expired: "This renewal offer has ended",
  needs_review: "This renewal is with the office",
};

/** The customer's contact a renewal speaks to: billing, else primary, else the first one. */
async function renewalContact(db: Database | Transaction<DB>, organizationId: string, customerId: string) {
  const contacts = await db
    .selectFrom("contacts")
    .select(["id", "name", "email", "phone", "type"])
    .where("organizationId", "=", organizationId)
    .where("customerId", "=", customerId)
    .orderBy("createdAt")
    .execute();
  const rank = (c: { type: string; email: string | null }) => (c.type === "billing" && c.email ? 0 : c.type === "primary" ? 1 : c.email ? 2 : 3);
  return contacts.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/** Who and where: what the customer sees as "you" and "your property". */
async function partiesFor(db: Database | Transaction<DB>, organizationId: string, r: { customerId: string; siteId: string }) {
  const [org, customer, site] = await Promise.all([
    db
      .selectFrom("organizations")
      .select(["name", "phone", "email", "addressLine1", "city", "state", "postalCode", "timezone", "defaultTaxRateBps", "invoiceTermsDays", "renewalPayment", "renewalTerms", "renewalWindowDays", "renewalAutoSend"])
      .where("id", "=", organizationId)
      .executeTakeFirstOrThrow(),
    db.selectFrom("customers").select(["displayName"]).where("organizationId", "=", organizationId).where("id", "=", r.customerId).executeTakeFirstOrThrow(),
    db.selectFrom("sites").select(["addressLine1", "addressLine2", "city", "state", "postalCode"]).where("organizationId", "=", organizationId).where("id", "=", r.siteId).executeTakeFirstOrThrow(),
  ]);
  return {
    org,
    customer,
    serviceAddress: joinAddress([site.addressLine1, site.addressLine2, cityLine(site.city, site.state, site.postalCode)]),
    providerAddress: joinAddress([org.addressLine1, cityLine(org.city, org.state, org.postalCode)]) || null,
  };
}

const termsOf = (r: RenewalRow) => ({
  planId: r.planId,
  planName: r.planName,
  customerType: r.customerType,
  termMonths: r.termMonths,
  visitsPerTerm: r.visitsPerTerm,
  priceCents: r.priceCents,
  billingFrequency: r.billingFrequency,
  serviceType: r.serviceType,
  autoRenew: r.autoRenew,
  startOn: r.startOn,
  endOn: r.endOn,
});

interface RenewalRow {
  id: string;
  organizationId: string;
  contractId: string;
  siteId: string;
  customerId: string;
  status: RenewalStatus;
  version: number;
  planId: string | null;
  planName: string;
  customerType: "residential" | "commercial";
  termMonths: number;
  visitsPerTerm: number;
  priceCents: number;
  billingFrequency: DB["renewals"]["billingFrequency"];
  serviceType: DB["renewals"]["serviceType"];
  autoRenew: boolean;
  startOn: string;
  endOn: string;
  selectedAddons: unknown;
  customerUpdates: unknown;
  sentAt: Date | null;
  sendCount: number;
  viewedAt: Date | null;
  signedAt: Date | null;
  paidAt: Date | null;
  activatedAt: Date | null;
  declinedAt: Date | null;
  declineReason: string | null;
  expiredAt: Date | null;
  reviewReason: string | null;
  signedDocumentId: string | null;
  invoiceId: string | null;
  newContractId: string | null;
}

/**
 * Renewals: the office's pipeline, campaign settings and add-on catalog, plus the link a
 * homeowner opens without signing in to confirm their details, sign and pay.
 */
export const renewalRoutes: FastifyPluginAsyncZod<{ db: Database; now: () => Date; store: ObjectStore; payments: PaymentsConfig; features?: ReadonlySet<Feature>; linkLimits: PublicLinkLimits }> = async (
  app,
  { db, now, store, payments, features = new Set(), linkLimits },
) => {
  // Signing, declining and paying: a few tries per address (lib/rate-limits.ts).
  const actionLimit = perAddress("renew-action", linkLimits.actions);
  const { provider, appUrl } = payments;
  const planBuilder = features.has("plan_builder");
  const serviceCycles = features.has("service_cycles");

  /**
   * The plan version a renewal offers, when the plan builder is on (SW-8): its own terms,
   * options and coverage go into the offer. Off, or with no version, the offer is as before.
   */
  const planOffer = async (ex: Database | Transaction<DB>, r: { organizationId: string; planVersionId: string | null }) =>
    planBuilder && r.planVersionId ? loadPlanVersion(ex, r.organizationId, r.planVersionId) : null;

  // ---- Settings and add-ons ----

  async function settings(organizationId: string): Promise<RenewalSettings> {
    const o = await db.selectFrom("organizations").select(["renewalWindowDays", "renewalAutoSend", "renewalPayment", "renewalTerms"]).where("id", "=", organizationId).executeTakeFirstOrThrow();
    return { windowDays: o.renewalWindowDays, autoSend: o.renewalAutoSend, payment: o.renewalPayment, terms: o.renewalTerms ?? DEFAULT_RENEWAL_TERMS, customTerms: o.renewalTerms !== null };
  }

  app.get(
    "/renewals/settings",
    { config: { permission: "contracts:read" }, schema: { tags: ["renewals"], summary: "How renewal campaigns run", response: { 200: renewalSettings } } },
    async (req) => settings(req.requireAuth().organizationId),
  );

  app.patch(
    "/renewals/settings",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["renewals"],
        summary: "Change the renewal window, automatic emails, when renewals activate, or the agreement text",
        body: renewalSettingsInput.partial(),
        response: { 200: renewalSettings },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const b = req.body;
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("organizations")
          .set(definedOnly({ renewalWindowDays: b.windowDays, renewalAutoSend: b.autoSend, renewalPayment: b.payment, renewalTerms: b.terms }))
          .where("id", "=", organizationId)
          .execute();
        await audit(trx, req, { action: "renewals.settings_changed", entityType: "organization", entityId: organizationId, changes: b });
      });
      return settings(organizationId);
    },
  );

  const ADDON_COLUMNS = ["id", "name", "description", "priceCents", "taxable", "active"] as const;

  app.get(
    "/renewals/addons",
    { config: { permission: "contracts:read" }, schema: { tags: ["renewals"], summary: "Add-ons offered with renewals", response: { 200: z.object({ items: z.array(renewalAddon) }) } } },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const items = await db.selectFrom("renewalAddons").select(ADDON_COLUMNS).where("organizationId", "=", organizationId).orderBy("active", "desc").orderBy("name").execute();
      return { items };
    },
  );

  app.post(
    "/renewals/addons",
    { config: { permission: "contracts:write" }, schema: { tags: ["renewals"], summary: "Offer a new add-on", body: addonInput, response: { 201: renewalAddon } } },
    async (req, reply) => {
      const { organizationId } = req.requireAuth();
      const row = await db.transaction().execute(async (trx) => {
        const created = await trx
          .insertInto("renewalAddons")
          .values({ organizationId, ...req.body, description: req.body.description ?? null, updatedAt: now() })
          .returning(ADDON_COLUMNS)
          .executeTakeFirstOrThrow();
        await audit(trx, req, { action: "renewal_addon.created", entityType: "renewal_addon", entityId: created.id, changes: req.body });
        return created;
      });
      return reply.status(201).send(row);
    },
  );

  app.patch(
    "/renewals/addons/:id",
    {
      config: { permission: "contracts:write" },
      schema: { tags: ["renewals"], summary: "Change an add-on (renewals already signed keep what they chose)", params, body: addonPatch, response: { 200: renewalAddon } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      return db.transaction().execute(async (trx) => {
        const updated = await trx
          .updateTable("renewalAddons")
          .set({ ...definedOnly(req.body), updatedAt: now() })
          .where("organizationId", "=", organizationId)
          .where("id", "=", req.params.id)
          .returning(ADDON_COLUMNS)
          .executeTakeFirst();
        if (!updated) throw notFound("Add-on");
        await audit(trx, req, { action: "renewal_addon.updated", entityType: "renewal_addon", entityId: updated.id, changes: req.body });
        return updated;
      });
    },
  );

  // ---- The office pipeline ----

  const listBase = (organizationId: string) =>
    db
      .selectFrom("renewals as r")
      .innerJoin("contracts as c", "c.id", "r.contractId")
      .innerJoin("customers as cu", "cu.id", "r.customerId")
      .innerJoin("sites as s", "s.id", "r.siteId")
      .select([
        "r.id",
        "r.status",
        "r.siteId",
        "r.contractId",
        "r.planName",
        "r.priceCents",
        "r.startOn",
        "r.endOn",
        "c.endOn as contractEndOn",
        "r.sentAt",
        "r.viewedAt",
        "r.signedAt",
        "r.activatedAt",
        "r.reviewReason",
        "cu.id as customerId",
        "cu.displayName",
        "s.addressLine1",
        "s.city",
      ])
      .select((eb) =>
        eb
          .exists(eb.selectFrom("contacts as k").select("k.id").whereRef("k.customerId", "=", "r.customerId").where("k.email", "is not", null))
          .as("hasEmail"),
      )
      .where("r.organizationId", "=", organizationId);
  type ListRow = Awaited<ReturnType<ReturnType<typeof listBase>["execute"]>>[number];
  const toListItem = (r: ListRow) => ({
    id: r.id,
    status: r.status,
    contractId: r.contractId,
    planName: r.planName,
    priceCents: r.priceCents,
    startOn: r.startOn,
    endOn: r.endOn,
    contractEndOn: r.contractEndOn,
    sentAt: iso(r.sentAt),
    viewedAt: iso(r.viewedAt),
    signedAt: iso(r.signedAt),
    activatedAt: iso(r.activatedAt),
    reviewReason: r.reviewReason,
    customer: { id: r.customerId, displayName: r.displayName },
    site: { id: r.siteId, addressLine1: r.addressLine1, city: r.city },
    hasEmail: !!r.hasEmail,
  });

  app.get(
    "/renewals",
    {
      config: { permission: "contracts:read" },
      schema: {
        tags: ["renewals"],
        summary: "The renewal pipeline, by status, soonest-ending contract first",
        querystring: z.object({ status: z.enum(RENEWAL_STATUSES).optional(), statuses: z.string().transform((v) => v.split(",")).pipe(z.array(z.enum(RENEWAL_STATUSES))).optional(), limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0) }),
        response: { 200: renewalList },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      let q = listBase(organizationId);
      if (req.query.status) q = q.where("r.status", "=", req.query.status);
      if (req.query.statuses?.length) q = q.where("r.status", "in", req.query.statuses);
      const today = await organizationToday(db, organizationId, now());
      const org = await db.selectFrom("organizations").select("renewalWindowDays").where("id", "=", organizationId).executeTakeFirstOrThrow();
      const [rows, total, counts, notStarted] = await Promise.all([
        q.orderBy("c.endOn").orderBy("r.id").limit(req.query.limit).offset(req.query.offset).execute(),
        q.clearSelect().select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow(),
        db.selectFrom("renewals").select(["status", sql<number>`count(*)::int`.as("n")]).where("organizationId", "=", organizationId).groupBy("status").execute(),
        db
          .selectFrom("contracts as c")
          .select(sql<number>`count(*)::int`.as("n"))
          .where("c.organizationId", "=", organizationId)
          .where("c.status", "=", "active")
          .where("c.serviceEndsOn", "is", null)
          .where("c.endOn", ">=", today)
          .where("c.endOn", "<=", addDays(today, org.renewalWindowDays))
          .where((eb) => eb.not(eb.exists(eb.selectFrom("renewals as r").select("r.id").whereRef("r.contractId", "=", "c.id").where("r.status", "not in", ["declined", "expired"]))))
          .where((eb) => eb.not(eb.exists(eb.selectFrom("contracts as n").select("n.id").whereRef("n.previousContractId", "=", "c.id"))))
          .executeTakeFirstOrThrow(),
      ]);
      return { total: total.n, items: rows.map(toListItem), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), notStarted: notStarted.n };
    },
  );

  app.post(
    "/renewals/campaign",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["renewals"],
        summary: "Run the renewal campaign now",
        description: "Starts renewals for contracts inside the window, emails them when automatic emails are on, sends reminders and expires ended offers. The worker runs this every hour.",
        body: z.object({}).optional(),
        response: { 200: z.object({ created: z.number().int(), sent: z.number().int(), reminded: z.number().int(), expired: z.number().int(), activated: z.number().int() }) },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      const result = await runRenewalSweep(db, organizationId, now());
      await db.transaction().execute((trx) => audit(trx, req, { action: "renewals.campaign_run", entityType: "organization", entityId: organizationId, changes: { ...result } }));
      return result;
    },
  );

  async function loadRow(organizationId: string, renewalId: string) {
    const r = await db.selectFrom("renewals").selectAll().where("organizationId", "=", organizationId).where("id", "=", renewalId).executeTakeFirst();
    if (!r) throw notFound("Renewal");
    return r;
  }

  async function detail(organizationId: string, renewalId: string): Promise<RenewalDetail> {
    const r = await loadRow(organizationId, renewalId);
    const [row, contract, invoice, doc, contact, version] = await Promise.all([
      listBase(organizationId).where("r.id", "=", r.id).executeTakeFirstOrThrow(),
      db.selectFrom("contracts").select("autoRenew").where("id", "=", r.contractId).executeTakeFirstOrThrow(),
      r.invoiceId ? db.selectFrom("invoices").select(["id", "number", "totalCents", "paymentStatus"]).where("id", "=", r.invoiceId).executeTakeFirst() : undefined,
      r.signedDocumentId ? db.selectFrom("signedDocuments").selectAll().where("id", "=", r.signedDocumentId).executeTakeFirst() : undefined,
      renewalContact(db, organizationId, r.customerId),
      r.planVersionId ? db.selectFrom("planVersions").select(["id", "version"]).where("id", "=", r.planVersionId).executeTakeFirst() : undefined,
    ]);
    return {
      ...toListItem(row),
      version: r.version,
      terms: termsOf(r),
      link: renewUrlFor(appUrl, r.id),
      sendCount: r.sendCount,
      autoRenewContract: contract.autoRenew,
      selectedAddons: r.selectedAddons as ChosenAddon[],
      selectedOptions: parsePlanOptions(r.selectedOptions),
      planVersion: version ? { id: version.id, version: version.version } : null,
      intake: doc ? ((doc.content as AgreementContent).intake ?? null) : null,
      customerUpdates: r.customerUpdates as Record<string, unknown>,
      paidAt: iso(r.paidAt),
      declinedAt: iso(r.declinedAt),
      declineReason: r.declineReason,
      expiredAt: iso(r.expiredAt),
      invoice: invoice ?? null,
      newContractId: r.newContractId,
      signedDocument: doc
        ? {
            id: doc.id,
            title: doc.title,
            signerName: doc.signerName,
            signatureKind: doc.signatureKind,
            signedAt: doc.signedAt.toISOString(),
            ipAddress: doc.ipAddress,
            userAgent: doc.userAgent,
            contentSha256: doc.contentSha256,
            pdfReady: !!doc.pdfStorageKey,
          }
        : null,
      email: contact?.email ?? null,
    };
  }

  const renewalConflict = (err: unknown): never => {
    if (err instanceof RenewalError) {
      if (err.code === "not_found") throw notFound("Contract");
      if (err.code === "plan_unavailable") throw unprocessable(err.message);
      throw new HttpError(409, err.code, err.message);
    }
    throw err;
  };

  app.post(
    "/contracts/:id/renewal",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["renewals"],
        summary: "Start a renewal for a contract, without waiting for the campaign",
        description: "Pass `send` to email the link right away.",
        params,
        body: z.object({ send: z.boolean().default(false) }),
        response: { 201: renewalDetail },
      },
    },
    async (req, reply) => {
      const { organizationId, userId } = req.requireAuth();
      const at = now();
      const renewalId = await db
        .transaction()
        .execute(async (trx) => {
          const created = await createRenewal(trx, organizationId, req.params.id, { createdBy: userId, requestId: req.id, now: at });
          if (req.body.send) await sendNow(trx, organizationId, created, at);
          return created;
        })
        .catch(renewalConflict);
      return reply.status(201).send(await detail(organizationId, renewalId));
    },
  );

  app.get(
    "/renewals/:id",
    { config: { permission: "contracts:read" }, schema: { tags: ["renewals"], summary: "A renewal with its offer, signature and payment", params, response: { 200: renewalDetail } } },
    async (req) => detail(req.requireAuth().organizationId, req.params.id),
  );

  /** Locks a renewal the office is about to change. */
  async function lockRow(trx: Transaction<DB>, organizationId: string, renewalId: string) {
    const r = await trx.selectFrom("renewals").selectAll().where("organizationId", "=", organizationId).where("id", "=", renewalId).forUpdate().executeTakeFirst();
    if (!r) throw notFound("Renewal");
    return r;
  }

  app.patch(
    "/renewals/:id",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["renewals"],
        summary: "Change the offer before the customer signs",
        description: "A customer who already has the page open is asked to review the new offer before signing.",
        params,
        body: renewalOfferPatch,
        response: { 200: renewalDetail },
      },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const r = await lockRow(trx, organizationId, req.params.id);
        if (!isSignable(r.status)) throw unprocessable("The offer can only change before the customer signs");
        // A new plan brings its own terms and price; a price alone changes only the price.
        const contract = await trx.selectFrom("contracts").selectAll().where("id", "=", r.contractId).executeTakeFirstOrThrow();
        const terms = req.body.planId
          ? await offerTerms(trx, organizationId, contract, { planId: req.body.planId, priceCents: req.body.priceCents }).catch(renewalConflict)
          : { priceCents: req.body.priceCents ?? r.priceCents };
        await trx
          .updateTable("renewals")
          .set({ ...terms, version: r.version + 1, updatedAt: now() })
          .where("id", "=", r.id)
          .execute();
        await audit(trx, req, { action: "renewal.offer_changed", entityType: "renewal", entityId: r.id, changes: { ...req.body, version: r.version + 1 } });
      });
      return detail(organizationId, req.params.id);
    },
  );

  async function sendNow(trx: Transaction<DB>, organizationId: string, renewalId: string, at: Date) {
    const r = await trx.selectFrom("renewals").select(["status", "customerId"]).where("id", "=", renewalId).executeTakeFirstOrThrow();
    if (!isSignable(r.status)) throw unprocessable("This renewal can no longer be signed");
    const contact = await renewalContact(trx, organizationId, r.customerId);
    if (!contact?.email) throw unprocessable("The customer has no email address on file. Add one to a contact, or copy the link and send it another way.");
    return queueRenewalEmail(trx, organizationId, renewalId, { now: at });
  }

  app.post(
    "/renewals/:id/send",
    {
      config: { permission: "contracts:write" },
      schema: { tags: ["renewals"], summary: "Email the renewal link to the customer (again)", params, body: z.object({}).optional(), response: { 200: renewalDetail } },
    },
    async (req) => {
      const { organizationId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        await lockRow(trx, organizationId, req.params.id);
        const sendNo = await sendNow(trx, organizationId, req.params.id, now());
        await audit(trx, req, { action: "renewal.sent", entityType: "renewal", entityId: req.params.id, changes: { sendNo } });
      });
      return detail(organizationId, req.params.id);
    },
  );

  app.post(
    "/renewals/:id/decline",
    {
      config: { permission: "contracts:write" },
      schema: { tags: ["renewals"], summary: "Record that the customer is not renewing", params, body: renewalDeclineInput, response: { 200: renewalDetail } },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      await db.transaction().execute(async (trx) => {
        const r = await lockRow(trx, organizationId, req.params.id);
        if (!isSignable(r.status) && r.status !== "needs_review") throw unprocessable("Only a renewal that is not yet signed, or is waiting for review, can be declined");
        await decline(trx, r, req.body.reason ?? null, now(), userId, req.id);
      });
      return detail(organizationId, req.params.id);
    },
  );

  async function decline(trx: Transaction<DB>, r: RenewalRow, reason: string | null, at: Date, actorUserId: string | null, requestId: string) {
    await trx.updateTable("renewals").set({ status: "declined", declinedAt: at, declineReason: reason, reviewReason: null, updatedAt: at }).where("id", "=", r.id).execute();
    await renewalOnTimeline(trx, {
      organizationId: r.organizationId,
      siteId: r.siteId,
      renewalId: r.id,
      eventType: "renewal_declined",
      summary: `Renewal declined${actorUserId ? " (recorded by the office)" : " by the customer"}${reason ? `: ${reason}` : ""}`,
      actorUserId,
      at,
    });
    await systemAudit(trx, { organizationId: r.organizationId, actorUserId, requestId, action: "renewal.declined", entityType: "renewal", entityId: r.id, changes: { reason } });
  }

  app.post(
    "/renewals/:id/activate",
    {
      config: { permission: "contracts:write" },
      schema: {
        tags: ["renewals"],
        summary: "Start the next term now",
        description:
          "For a signed renewal still waiting on payment, or one in review. A contract set to auto-renew can also be renewed without the customer signing again; its first installment is then billed as usual.",
        params,
        body: z.object({ note: z.string().trim().max(500).nullish() }),
        response: { 200: renewalDetail },
      },
    },
    async (req) => {
      const { organizationId, userId } = req.requireAuth();
      const result = await db.transaction().execute(async (trx) => {
        const r = await lockRow(trx, organizationId, req.params.id);
        const contract = await trx.selectFrom("contracts").select("autoRenew").where("id", "=", r.contractId).executeTakeFirstOrThrow();
        const signed = r.signedDocumentId !== null;
        const allowed = (signed && ["signed", "payment_pending", "paid", "needs_review"].includes(r.status)) || (contract.autoRenew && (isSignable(r.status) || r.status === "needs_review"));
        if (r.status === "activated") throw new HttpError(409, "already_activated", "This renewal is already active");
        if (!allowed) throw unprocessable(contract.autoRenew ? "This renewal cannot be activated" : "The customer has to sign first, unless the contract is set to auto-renew");
        const note = req.body.note ?? (signed ? "activated by the office" : "auto-renewed by the office");
        return activateRenewal(trx, organizationId, r.id, { now: now(), actorUserId: userId, requestId: req.id, note, planBuilder, serviceCycles });
      });
      if (result.status === "needs_review") throw new HttpError(409, "needs_review", result.reason);
      return detail(organizationId, req.params.id);
    },
  );

  app.get(
    "/renewals/:id/agreement.pdf",
    { config: { permission: "contracts:read" }, schema: { tags: ["renewals"], summary: "The signed agreement PDF", params } },
    async (req, reply) => {
      const r = await loadRow(req.requireAuth().organizationId, req.params.id);
      return sendAgreement(reply, r.signedDocumentId);
    },
  );

  async function sendAgreement(reply: FastifyReply, documentId: string | null) {
    const doc = documentId ? await db.selectFrom("signedDocuments").select(["pdfStorageKey"]).where("id", "=", documentId).executeTakeFirst() : undefined;
    if (!doc) throw notFound("Signed agreement");
    const data = doc.pdfStorageKey ? await readForDownload(db, store, doc.pdfStorageKey) : null;
    if (!data) throw new HttpError(404, "not_ready", "The signed copy is still being prepared. Try again in a minute.");
    return reply.header("content-type", "application/pdf").header("content-disposition", `inline; filename="agreement.pdf"`).send(data);
  }

  // ---- The homeowner's link (no sign-in; the link is the key) ----

  /** The renewal a signed link token names (`links.ts`); a token that does not verify is not found. */
  const renewalIdOf = (t: string) => {
    const id = linkTokenId("renew", t);
    if (!id) throw notFoundLink();
    return id;
  };
  async function byToken(t: string) {
    const r = await db.selectFrom("renewals").selectAll().where("id", "=", renewalIdOf(t)).executeTakeFirst();
    if (!r) throw notFoundLink();
    return r;
  }

  app.get(
    "/renew/:token",
    {
      config: { public: true, rateLimit: publicLimit },
      schema: { tags: ["renew"], summary: "What the homeowner sees from their renewal link", params: token, response: { 200: publicRenewal } },
    },
    async (req): Promise<PublicRenewal> => {
      const r = await byToken(req.params.token);
      const organizationId = r.organizationId;
      const [{ org, customer, serviceAddress }, contract, contact, addons, doc, inv] = await Promise.all([
        partiesFor(db, organizationId, r),
        db.selectFrom("contracts").select(["planName", "endOn"]).where("id", "=", r.contractId).executeTakeFirstOrThrow(),
        renewalContact(db, organizationId, r.customerId),
        isSignable(r.status)
          ? db.selectFrom("renewalAddons").select(["id", "name", "description", "priceCents", "taxable"]).where("organizationId", "=", organizationId).where("active", "=", true).orderBy("name").execute()
          : Promise.resolve(r.selectedAddons as ChosenAddon[]),
        r.signedDocumentId ? db.selectFrom("signedDocuments").select(["signerName", "signedAt", "pdfStorageKey", "content"]).where("id", "=", r.signedDocumentId).executeTakeFirst() : undefined,
        r.invoiceId ? db.selectFrom("invoices").select(["id"]).where("id", "=", r.invoiceId).where("status", "=", "open").executeTakeFirst() : undefined,
      ]);
      const terms = termsOf(r);
      // What the plan adds to the offer (SW-8): from the signed agreement once signed, from the
      // offered version while it can be signed.
      const signedContent = doc ? (doc.content as AgreementContent) : null;
      const offer = isSignable(r.status) ? await planOffer(db, r) : null;
      const options = signedContent ? (signedContent.options ?? []) : offer ? offer.options : parsePlanOptions(r.selectedOptions);
      const coverage = signedContent ? (signedContent.coverage ?? []) : offer ? await coverageLines(db, organizationId, offer.coverage) : [];
      let pay: PublicRenewal["pay"] = null;
      let paymentConfirmation: PublicRenewal["paymentConfirmation"] = null;
      if (inv) {
        const payable = await openInvoiceById(db, inv.id);
        const verification = await db.selectFrom("payments").select("id").where("organizationId", "=", organizationId).where("invoiceId", "=", inv.id).where("status", "=", "pending").where("bankVerificationUrl", "is not", null).executeTakeFirst();
        const invoiceUrl = payUrlFor(appUrl, inv.id);
        paymentConfirmation = { paymentStatus: payable.paymentStatus, latestPaymentFailed: await latestPaymentFailed(db, organizationId, inv.id, payable.pendingCents, now()), pendingCents: payable.pendingCents, bankVerificationRequired: Boolean(verification), invoiceUrl };
        if (amountDue(payable) > 0) pay = { amountDueCents: amountDue(payable), canPayOnline: canPayOnline(provider, payable), invoiceUrl };
      }
      return {
        status: r.status,
        version: r.version,
        provider: { name: org.name, phone: org.phone, email: org.email },
        customerName: customer.displayName,
        serviceAddress,
        currentTerm: { planName: contract.planName, endOn: contract.endOn },
        terms,
        installments: contractInstallments(terms).length,
        firstPaymentCents: contractInstallments(terms)[0]!.amountCents,
        taxRateBps: org.defaultTaxRateBps,
        addons,
        selectedAddonIds: (r.selectedAddons as ChosenAddon[]).map((a) => a.id),
        options,
        selectedOptionKeys: (signedContent ? options : offer ? offer.options.filter((o) => o.default) : parsePlanOptions(r.selectedOptions)).map((o) => o.optionKey),
        coverage: coverage.map((c) => c.summary),
        cycles: (signedContent ? (signedContent.cycles ?? []) : offer && (serviceCycles || !offer.aerobic) ? (agreementCycles(offer, terms) ?? []) : []).map((c) => `${c.label}: ${c.summary}`),
        // Asked only while it can be signed; the signed answers are in the agreement itself.
        intake: offer?.intake ? { name: offer.intake.name, definition: offer.intake.definition } : null,
        contact: { name: contact?.name ?? null, email: contact?.email ?? null, phone: contact?.phone ?? null },
        agreementText: signedContent ? signedContent.terms : (offer?.termsText ?? org.renewalTerms ?? defaultAgreementTerms(offer && (serviceCycles || !offer.aerobic) ? offer : null)),
        consentText: CONSENT_TEXT,
        payment: org.renewalPayment,
        signed: doc ? { signerName: doc.signerName, signedAt: doc.signedAt.toISOString(), pdfReady: !!doc.pdfStorageKey } : null,
        pay,
        paymentConfirmation,
        newTermStartsOn: r.status === "activated" ? r.startOn : null,
        testMode: !!provider && (await providerFor(provider, r.organizationId)).kind === "test",
      };
    },
  );

  app.post(
    "/renew/:token/view",
    {
      config: { public: true, rateLimit: publicLimit },
      schema: { tags: ["renew"], summary: "Note that the homeowner opened their link", params: token, body: z.object({}).optional(), response: { 204: z.null() } },
    },
    async (req, reply) => {
      const r = await byToken(req.params.token);
      const at = now();
      await db.transaction().execute(async (trx) => {
        const res = await trx
          .updateTable("renewals")
          .set({ viewedAt: at, status: sql`case when status in ('upcoming', 'sent') then 'viewed' else status end`, updatedAt: at })
          .where("id", "=", r.id)
          .where("viewedAt", "is", null)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) === 1) await systemAudit(trx, { organizationId: r.organizationId, action: "renewal.viewed", entityType: "renewal", entityId: r.id, requestId: req.id });
      });
      return reply.status(204).send(null);
    },
  );

  const clientMeta = (req: FastifyRequest) => {
    const forwarded = req.headers["x-forwarded-for"];
    const chain = Array.isArray(forwarded) ? forwarded.join(", ") : forwarded;
    return {
      ipAddress: (chain ? `${chain} (via ${req.ip})` : req.ip).slice(0, 300),
      userAgent: (req.headers["user-agent"] ?? "").slice(0, 500) || null,
    };
  };

  app.post(
    "/renew/:token/sign",
    {
      config: { public: true, rateLimit: actionLimit },
      schema: {
        tags: ["renew"],
        summary: "Sign the renewal",
        description:
          "Updates the customer's contact details, freezes the agreement with their signature, and issues the renewal invoice. The next term starts when it is paid, or right away when the provider bills afterwards.",
        params: token,
        body: renewalSignInput,
        response: { 200: publicRenewal.pick({ status: true }) },
      },
    },
    async (req) => {
      const at = now();
      const b = req.body;
      const meta = clientMeta(req);
      const result = await db.transaction().execute(async (trx) => {
        const r = await trx.selectFrom("renewals").selectAll().where("id", "=", renewalIdOf(req.params.token)).forUpdate().executeTakeFirst();
        if (!r) throw notFoundLink();
        const organizationId = r.organizationId;
        if (!isSignable(r.status)) throw new HttpError(409, "not_signable", CLOSED_MESSAGE[r.status] ?? "This renewal can no longer be signed");
        if (r.version !== b.version) throw new HttpError(409, "offer_changed", "The offer changed since you opened it. Review it again before signing.");
        const parties = await partiesFor(trx, organizationId, r);
        const { org } = parties;
        const prev = await trx.selectFrom("contracts").select(["status", "planName", "startOn", "endOn"]).where("id", "=", r.contractId).executeTakeFirstOrThrow();
        if (prev.status === "cancelled") throw new HttpError(409, "not_signable", "This renewal offer has ended");

        // Add-ons, as they are priced today.
        const ids = [...new Set(b.addonIds)];
        const addons: ChosenAddon[] = ids.length
          ? await trx
              .selectFrom("renewalAddons")
              .select(["id", "name", "description", "priceCents", "taxable"])
              .where("organizationId", "=", organizationId)
              .where("active", "=", true)
              .where("id", "in", ids)
              .orderBy("name")
              .execute()
          : [];
        if (addons.length !== ids.length) throw unprocessable("An add-on you chose is no longer offered. Reload the page.");

        // The plan's own options (SW-8): the required ones always, plus those chosen.
        const offer = await planOffer(trx, r);
        const keys = new Set(b.optionKeys);
        const options: PlanOption[] = (offer?.options ?? []).filter((o) => o.required || keys.has(o.optionKey));
        if ([...keys].some((k) => !offer?.options.some((o) => o.optionKey === k))) throw unprocessable("An option you chose is no longer offered. Reload the page.");

        // The plan's intake questions (SW-8), answered as the form asks; kept only in the agreement.
        const intake = offer?.intake ? { form: offer.intake, ...intakeAnswers(offer.intake.definition, b.intakeAnswers) } : null;
        if (intake?.problems.length) throw unprocessable(intake.problems.map((p) => p.message).join("; "));

        // The customer's confirmed contact details.
        const contact = await renewalContact(trx, organizationId, r.customerId);
        const phone = b.contact.phone ?? null;
        const before = contact ? { email: contact.email, phone: contact.phone } : null;
        if (contact) {
          if (contact.email !== b.contact.email || (phone !== null && contact.phone !== phone)) {
            await trx
              .updateTable("contacts")
              .set({ email: b.contact.email, ...(phone !== null ? { phone } : {}), updatedAt: at })
              .where("id", "=", contact.id)
              .execute();
          }
        } else {
          await trx
            .insertInto("contacts")
            .values({ organizationId, customerId: r.customerId, siteId: null, name: b.signerName, email: b.contact.email, phone, type: "primary", updatedAt: at })
            .execute();
        }
        const after = { email: b.contact.email, phone: phone ?? contact?.phone ?? null };
        const changed = !before || before.email !== after.email || before.phone !== after.phone;

        const terms = termsOf(r);
        const charges = renewalCharges(terms, addons, org.defaultTaxRateBps, options);
        const content: AgreementContent = {
          format: 1,
          title: `${terms.planName} renewal agreement`,
          offerVersion: r.version,
          provider: { name: org.name, address: parties.providerAddress, phone: org.phone, email: org.email },
          customer: { name: parties.customer.displayName, email: after.email, phone: after.phone },
          serviceAddress: parties.serviceAddress,
          previousTerm: { planName: prev.planName, startOn: prev.startOn, endOn: prev.endOn },
          term: terms,
          addons,
          charges: {
            lines: charges.lines.map((l) => ({ description: l.description, amountCents: l.quantity * l.unitPriceCents, taxable: l.taxable })),
            taxCents: charges.totals.taxCents,
            totalCents: charges.totals.totalCents,
            installments: charges.installments,
            payment: org.renewalPayment,
          },
          terms: offer?.termsText ?? org.renewalTerms ?? defaultAgreementTerms(offer && (serviceCycles || !offer.aerobic) ? offer : null),
          // Only with the plan builder on, so every other agreement keeps exactly its old content.
          ...(offer
            ? {
                plan: { versionId: offer.id, version: offer.version, termsSource: offer.termsText ? ("plan" as const) : ("organization" as const) },
                options,
                coverage: await coverageLines(trx, organizationId, offer.coverage),
                ...(intake ? { intake: { templateId: intake.form.id, key: intake.form.key, version: intake.form.version, name: intake.form.name, answers: intake.answers } } : {}),
                // SW-9: pumping or maintenance the term includes. A version without inspections lists its cycles even with the switch off.
                ...(offer && (serviceCycles || !offer.aerobic) && agreementCycles(offer, terms) ? { cycles: agreementCycles(offer, terms)! } : {}),
              }
            : {}),
        };
        const doc = await trx
          .insertInto("signedDocuments")
          .values({
            organizationId,
            kind: "renewal_agreement",
            renewalId: r.id,
            siteId: r.siteId,
            customerId: r.customerId,
            title: content.title,
            content: JSON.stringify(content),
            contentSha256: sha256Hex(canonicalJson(content)),
            signerName: b.signerName,
            signatureKind: b.signature.kind,
            signatureImage: b.signature.kind === "drawn" ? b.signature.image : null,
            consentText: CONSENT_TEXT,
            signedAt: at,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
            pdfStorageKey: null,
            pdfSha256: null,
            pdfByteSize: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow();

        // The renewal invoice: the first payment of the new term plus any add-ons.
        let invoiceId: string | null = null;
        if (charges.totals.totalCents > 0) {
          const inv = await trx
            .insertInto("invoices")
            .values({
              organizationId,
              customerId: r.customerId,
              siteId: r.siteId,
              number: null,
              memo: `Renewal of your maintenance plan, ${terms.startOn} to ${terms.endOn}.`,
              termsDays: org.renewalPayment === "pay_to_activate" ? 0 : org.invoiceTermsDays,
              taxRateBps: org.defaultTaxRateBps,
              discountCents: 0,
              subtotalCents: 0,
              taxableCents: 0,
              taxCents: 0,
              totalCents: 0,
              issuedOn: null,
              dueOn: null,
              pdfStorageKey: null,
              pdfSha256: null,
              pdfByteSize: null,
              sentAt: null,
              paidAt: null,
              voidedAt: null,
              voidReason: null,
              createdBy: null,
              updatedAt: at,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
          invoiceId = inv.id;
          await writeDraftLines(
            trx,
            organizationId,
            inv.id,
            charges.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPriceCents: l.unitPriceCents, taxable: l.taxable })),
            { discountCents: 0, taxRateBps: org.defaultTaxRateBps },
            at,
          );
          await invoiceEvent(trx, { organizationId, invoiceId: inv.id, eventType: "created", summary: "Created when the customer signed their renewal", at });
          await issueDraft(trx, organizationId, inv.id, { send: false, now: at });
          await queueQuickBooksSync(trx, organizationId, at);
        }

        await trx
          .updateTable("renewals")
          .set({
            status: "signed",
            signedAt: at,
            signedDocumentId: doc.id,
            invoiceId,
            selectedAddons: JSON.stringify(addons),
            selectedOptions: JSON.stringify(options),
            customerUpdates: JSON.stringify(changed ? { contact: { before, after } } : {}),
            updatedAt: at,
          })
          .where("id", "=", r.id)
          .execute();
        await renewalOnTimeline(trx, {
          organizationId,
          siteId: r.siteId,
          renewalId: r.id,
          eventType: "renewal_signed",
          summary: `Renewal signed online by ${b.signerName}: ${terms.planName}, ${terms.startOn} to ${terms.endOn}`,
          at,
        });
        await systemAudit(trx, {
          organizationId,
          requestId: req.id,
          action: "renewal.signed",
          entityType: "renewal",
          entityId: r.id,
          changes: { signedDocumentId: doc.id, invoiceId, addons: addons.map((a) => a.id), ...(offer ? { options: options.map((o) => o.optionKey) } : {}), contactChanged: changed, ...meta },
        });
        await enqueue(trx, { kind: RENEWAL_AGREEMENT, organizationId, payload: { documentId: doc.id }, dedupeKey: `renewal-agreement-${doc.id}`, runAt: at });

        if (!invoiceId || org.renewalPayment === "invoice") {
          const activated = await activateRenewal(trx, organizationId, r.id, { now: at, requestId: req.id });
          return activated.status === "activated" ? "activated" : "needs_review";
        }
        await trx.updateTable("renewals").set({ status: "payment_pending" }).where("id", "=", r.id).execute();
        return "payment_pending";
      });
      return { status: result as RenewalStatus };
    },
  );

  app.post(
    "/renew/:token/decline",
    {
      config: { public: true, rateLimit: actionLimit },
      schema: { tags: ["renew"], summary: "Tell the provider you are not renewing", params: token, body: renewalDeclineInput, response: { 200: publicRenewal.pick({ status: true }) } },
    },
    async (req) => {
      await db.transaction().execute(async (trx) => {
        const r = await trx.selectFrom("renewals").selectAll().where("id", "=", renewalIdOf(req.params.token)).forUpdate().executeTakeFirst();
        if (!r) throw notFoundLink();
        if (!isSignable(r.status)) throw new HttpError(409, "not_signable", CLOSED_MESSAGE[r.status] ?? "This renewal can no longer be changed");
        await decline(trx, r, req.body.reason ?? null, now(), null, req.id);
      });
      return { status: "declined" as const };
    },
  );

  app.post(
    "/renew/:token/checkout",
    {
      config: { public: true, rateLimit: actionLimit },
      schema: { tags: ["renew"], summary: "Pay for the renewal", params: token, body: z.object({}).optional(), response: { 200: z.object({ url: z.string() }) } },
    },
    async (req) => {
      const r = await byToken(req.params.token);
      if (!r.invoiceId) throw unprocessable("Nothing is due on this renewal");
      return openCheckout(db, {
        provider,
        appUrl,
        inv: await openInvoiceById(db, r.invoiceId),
        now: now(),
        successUrl: `${renewUrlFor(appUrl, r.id)}?paid=1`,
      });
    },
  );

  app.get(
    "/renew/:token/agreement.pdf",
    { config: { public: true, rateLimit: publicLimit }, schema: { tags: ["renew"], summary: "The signed agreement, for the customer", params: token } },
    async (req, reply) => sendAgreement(reply, (await byToken(req.params.token)).signedDocumentId),
  );

};
