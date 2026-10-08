import { OutboxTransport, syncRulesets, type EmailProvider, type EmailTransport } from "@aerowise/compliance";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import type { Database } from "@aerowise/db";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { authPlugin } from "./auth/plugin.ts";
import { HttpError } from "./lib/errors.ts";
import { adminRoutes } from "./routes/admin.ts";
import { adminEvidenceRoutes } from "./routes/admin-evidence.ts";
import { authorityConfirmationRoutes } from "./routes/authority-confirmation.ts";
import { adminSupportRoutes } from "./routes/admin-support.ts";
import { adminDemoRoutes } from "./routes/admin-demos.ts";
import { authRoutes } from "./routes/auth.ts";
import { filingRoutes } from "./routes/filings.ts";
import { importRoutes } from "./routes/imports.ts";
import { exportRoutes } from "./routes/exports.ts";
import { inboxRoutes } from "./routes/inbox.ts";
import { invoiceRoutes } from "./routes/invoices.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { billingRoutes } from "./routes/billing.ts";
import { subscriptionRoutes } from "./routes/subscription.ts";
import { TestBillingProvider, type BillingProvider } from "@aerowise/billing";
import { portalRoutes } from "./routes/portal.ts";
import { quickbooksRoutes } from "./routes/quickbooks.ts";
import { renewalRoutes } from "./routes/renewals.ts";
import { contractRoutes } from "./routes/contracts.ts";
import { coverageRoutes } from "./routes/coverage.ts";
import { customerRoutes } from "./routes/customers.ts";
import { inspectionRoutes } from "./routes/inspections.ts";
import { readinessRoutes } from "./routes/readiness.ts";
import { labTestRoutes } from "./routes/lab-tests.ts";
import { monitoringRoutes } from "./routes/monitoring.ts";
import { reportRoutes } from "./routes/reports.ts";
import { scheduleRoutes } from "./routes/schedule.ts";
import { siteRoutes } from "./routes/sites.ts";
import { routingRoutes } from "./routes/routing.ts";
import { smsRoutes } from "./routes/sms.ts";
import { emailRoutes } from "./routes/email.ts";
import { userRoutes } from "./routes/users.ts";
import { passwordResetRoutes } from "./routes/password-reset.ts";
import { onboardingRoutes } from "./routes/onboarding.ts";
import { organizationRoutes } from "./routes/organization.ts";
import { publicRoutes } from "./routes/public.ts";
import { demoRequestRoutes } from "./routes/demo-requests.ts";
import { demoVisitRoutes } from "./routes/demo-visits.ts";
import { legalRoutes } from "./routes/legal.ts";
import { serviceItemRoutes } from "./routes/service-items.ts";
import { workOrderRoutes } from "./routes/work-orders.ts";
import { estimateRoutes } from "./routes/estimates.ts";
import { formRoutes } from "./routes/forms.ts";
import { workSyncRoutes } from "./routes/work-sync.ts";
import { UrlSigner } from "./storage/signed-urls.ts";
import { LocalDiskStore, type ObjectStore } from "@aerowise/storage";
import { checkHeartbeat, checkQueue, DEFAULT_APP_URL, enqueue, type HeartbeatOptions } from "@aerowise/tasks";
import { NoopReporter, type ErrorReporter } from "@aerowise/observability";
import { TestPaymentProvider, type PaymentProvider } from "@aerowise/payments";
import { TestQuickBooksProvider, TokenCipher } from "@aerowise/quickbooks";
import type { QuickBooksConfig } from "./lib/quickbooks.ts";
import { TestSmsProvider, type SmsConfig } from "@aerowise/sms";
import { CensusGeocoder, TestGeocoder, type Geocoder } from "@aerowise/routing";
import { DEFAULT_SUBSCRIPTION_CONFIG, parseFeatures, type Feature, type SubscriptionConfig } from "@aerowise/domain";

export interface AppOptions {
  db: Database;
  production?: boolean;
  /**
   * The hosted demo (DEMO_MODE): outside services default to their test stand-ins and the
   * fictional example rules load, even in production. The web app shows a demo banner.
   */
  demo?: boolean;
  logger?: FastifyServerOptions["logger"];
  /** Sign-in attempts allowed per IP and email per minute. */
  loginRateLimit?: number;
  /** Password reset requests allowed per IP and email per minute. */
  passwordResetRateLimit?: number;
  /**
   * Which proxies in front of the API to believe about the client's address (Fastify's
   * `trustProxy`: true, or the proxies' addresses and ranges). Rate limits key on that
   * address, so leave it off unless every request really passes through those proxies.
   */
  trustProxy?: boolean | string;
  /** Where unexpected errors go (Sentry when configured). Defaults to nowhere; they are logged either way. */
  reporter?: ErrorReporter;
  /** Clock used for "today" in due dates and contract states. Tests pin it. */
  now?: () => Date;
  /** Where uploaded photos, reports and outbox mail are kept. Defaults to ./.data/files on local disk. */
  store?: ObjectStore;
  /** Secret for signed file links. Required in production. */
  fileSigningSecret?: string;
  /** How filings and invitations are emailed. Defaults to the development outbox in file storage. */
  mail?: EmailTransport;
  /** The mail provider behind `mail`, whose delivery webhooks the API receives. None for the outbox. */
  mailProvider?: EmailProvider | null;
  /** From address on account emails (invitations). */
  accountMailFrom?: string;
  /**
   * Takes card and bank payments. Defaults to the built-in test provider outside
   * production; in production, online payments are off unless Stripe is configured.
   */
  payments?: PaymentProvider | null;
  /**
   * QuickBooks Online. Defaults to the built-in test company outside production; in
   * production, QuickBooks is off unless Intuit keys are configured.
   */
  quickbooks?: QuickBooksConfig | null;
  /** The web app's public address, used in pay links and the QuickBooks callback. */
  appUrl?: string;
  /**
   * Text messages. Defaults to the built-in test provider outside production; in
   * production, texting is off unless Twilio is configured.
   */
  sms?: SmsConfig | null;
  /**
   * Finds addresses on the map. Defaults to the built-in test geocoder outside production
   * and the US Census geocoder in production.
   */
  geocoder?: Geocoder | null;
  /** Aerowise's own prices and free-period lengths (what companies pay Aerowise). */
  subscription?: SubscriptionConfig;
  /** Who is emailed about a new demo request; empty means every active platform admin. */
  demoRequestNotifyTo?: string[];
  /**
   * Stripe Billing, for what companies pay Aerowise (not homeowner payments). Defaults to the
   * built-in test provider outside production; in production it is off unless configured.
   */
  billing?: BillingProvider | null;
  /**
   * When the worker runs on the same machine as the API (one hosted service sharing a disk),
   * /health also fails if the worker's heartbeat is missing or old, so the host restarts both.
   */
  workerHeartbeat?: HeartbeatOptions;
  /** Visitor demo limits (W10.2); tests lower them. */
  demoVisitLimits?: { perHour?: number; maxLive?: number };
  /** Features switched on for this deployment. Defaults to AEROWISE_FEATURES (all off when unset). */
  features?: ReadonlySet<Feature>;
}

export async function buildApp({
  db,
  production = false,
  demo = false,
  logger = false,
  loginRateLimit = 10,
  passwordResetRateLimit = 5,
  trustProxy = false,
  reporter = new NoopReporter(),
  now = () => new Date(),
  store = new LocalDiskStore(".data/files"),
  fileSigningSecret,
  mail,
  mailProvider = null,
  accountMailFrom = "accounts@aerowise.invalid",
  payments = production && !demo ? null : new TestPaymentProvider(),
  appUrl = DEFAULT_APP_URL,
  quickbooks = production && !demo ? null : { provider: new TestQuickBooksProvider(db, now), cipher: new TokenCipher() },
  sms = production && !demo ? null : { provider: new TestSmsProvider(), webhookBaseUrl: `${appUrl.replace(/\/$/, "")}/api` },
  geocoder = production && !demo ? new CensusGeocoder() : new TestGeocoder(),
  subscription = DEFAULT_SUBSCRIPTION_CONFIG,
  demoRequestNotifyTo = [],
  billing = production && !demo ? null : new TestBillingProvider(),
  workerHeartbeat,
  demoVisitLimits,
  features = parseFeatures(process.env.AEROWISE_FEATURES),
}: AppOptions) {
  if (production && !fileSigningSecret) throw new Error("FILE_SIGNING_SECRET is required in production");
  // Reporting authorities' rules ship with the code; make sure the database has them.
  // Fictional rules (the example county) are for development, tests and the demo only.
  await syncRulesets(db, undefined, { includeFictional: !production || demo });
  const signer = new UrlSigner(fileSigningSecret ?? "aerowise-development-only-signing-secret");

  const app = Fastify({
    logger,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: false,
    trustProxy,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    // The database refuses real contact details in a demo company (migration 0039).
    const pg = err as { code?: string; constraint?: string };
    if (pg.code === "23514" && (pg.constraint === "demo_fictional_email" || pg.constraint === "demo_fictional_phone")) {
      return reply.status(422).send({ error: "fictional_contact_required", message: (err as Error).message.replace(/^a demo/, "A demo") + "." });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: "invalid_request",
        message: "Request failed validation",
        issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.status(429).send({ error: "rate_limited", message: "Too many attempts. Try again in a minute." });
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: "bad_request", message: (err as Error).message });
    }
    req.log.error({ err }, "unhandled error");
    reporter.captureException(err, {
      organizationId: req.auth?.organizationId ?? null,
      requestId: req.id,
      tags: { route: `${req.method} ${req.routeOptions.url ?? "unknown"}` },
    });
    return reply.status(500).send({ error: "internal", message: "Something went wrong", requestId: req.id });
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
    // The API serves JSON and files, never pages: nothing it returns may be framed, sniffed
    // into another type, or leak its URL (signed links carry tokens) to another site.
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "same-origin");
    if (production) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  if (!production) {
    await app.register(swagger, {
      openapi: {
        info: { title: "Aerowise API", version: "0.1.0" },
        components: {
          securitySchemes: {
            session: { type: "apiKey", in: "cookie", name: "aw_session" },
            adminSession: { type: "apiKey", in: "cookie", name: "aw_admin_session" },
          },
        },
        security: [{ session: [] }],
      },
      transform: jsonSchemaTransform,
    });
    app.get("/openapi.json", { config: { public: true }, schema: { hide: true } }, async () => app.swagger());
  }

  await app.register(authPlugin, { db });

  // Lets the web app show the demo banner (and the demo sign-ins) without its own setting.
  // `demo` is the demo deployment; `demoCompany` that whoever is signed in works in a demo company.
  app.get("/app-info", { config: { public: true }, schema: { hide: true } }, async (req) => {
    const org = req.auth ? await db.selectFrom("organizations").select(["demo", "demoExpiresAt"]).where("id", "=", req.auth.organizationId).executeTakeFirst() : undefined;
    // `demoVisitor`: a visitor's own demo company (W10.2), where the banner offers other people's views.
    // `features`: what this deployment has switched on, so the web app shows only those screens.
    return { demo, demoCompany: demo || org?.demo === true, demoVisitor: !!org?.demoExpiresAt, features: [...features].sort() };
  });

  app.get("/health", { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
    await db.selectNoFrom((eb) => eb.lit(1).as("ok")).execute();
    if (!workerHeartbeat) return { ok: true };
    const worker = await checkHeartbeat(workerHeartbeat, now());
    if (!worker.ok) return reply.code(503).send({ ok: false, worker: worker.reason });
    return { ok: true, worker: "ok" };
  });

  // A second uptime check target: fails while work is due and nobody runs it, or a filing
  // task keeps failing. Counts only; the worker's alerts carry the details.
  app.get("/health/queue", { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
    const q = await checkQueue(db, now());
    const body = { ok: q.ok, waiting: q.waiting, oldestWaitSeconds: q.oldestWaitSeconds, failingFilingTasks: q.failingFilingTasks };
    return q.ok ? body : reply.code(503).send(body);
  });

  const transport = mail ?? new OutboxTransport(store, now);
  const invitations = { mail: transport, appUrl, from: accountMailFrom };
  await app.register(authRoutes, { db, production, loginRateLimit, demoTicketKey: fileSigningSecret ?? "aerowise-development-only-signing-secret" });
  await app.register(adminRoutes, { db, production, loginRateLimit, now, invitations, subscription, store });
  await app.register(adminEvidenceRoutes, { db, now });
  await app.register(authorityConfirmationRoutes, { db });
  await app.register(adminSupportRoutes, { db, production });
  await app.register(adminDemoRoutes, { db, store, now, production, appUrl, subscription, features });
  await app.register(userRoutes, { db, now, production, invitations });
  await app.register(passwordResetRoutes, { db, now, rateLimit: passwordResetRateLimit });
  await app.register(organizationRoutes, { db, store });
  await app.register(onboardingRoutes, { db, now });
  await app.register(customerRoutes, { db, now });
  await app.register(siteRoutes, { db, now });
  await app.register(contractRoutes, { db, now, features });
  await app.register(scheduleRoutes, { db, now });
  await app.register(workOrderRoutes, { db, now, features });
  await app.register(serviceItemRoutes, { db, now, features });
  await app.register(coverageRoutes, { db, now, features });
  await app.register(formRoutes, { db, features });
  await app.register(workSyncRoutes, { db, now, store, signer, features });
  await app.register(estimateRoutes, { db, now, features, appUrl });
  await app.register(inspectionRoutes, { db, now, store, signer });
  await app.register(reportRoutes, { db, now, store, signer });
  await app.register(inboxRoutes, { db, now });
  await app.register(importRoutes, { db, now });
  await app.register(exportRoutes, { db, store, now });
  await app.register(invoiceRoutes, { db, now, store, payments: { provider: payments, appUrl }, features });
  await app.register(billingRoutes, { db, now, provider: billing, config: subscription });
  await app.register(subscriptionRoutes, { db, now, provider: billing, config: subscription, appUrl });
  await app.register(paymentRoutes, { db, now, store, payments: { provider: payments, appUrl }, testCheckout: !production || demo });
  await app.register(renewalRoutes, { db, now, store, payments: { provider: payments, appUrl }, features });
  await app.register(portalRoutes, { db, now, store, appUrl });
  await app.register(quickbooksRoutes, { db, now, quickbooks, appUrl });
  await app.register(smsRoutes, { db, now, sms });
  await app.register(routingRoutes, { db, now, geocoder });
  await app.register(emailRoutes, { db, now, provider: mailProvider });
  const compliance = { store, mail: transport, enqueue };
  await app.register(filingRoutes, { db, now, signer, compliance });
  await app.register(readinessRoutes, { db, now, signer, compliance });
  await app.register(labTestRoutes, { db, now });
  await app.register(monitoringRoutes, { db, now });
  await app.register(publicRoutes, { db, now, subscription });
  await app.register(legalRoutes, { db, now });
  await app.register(demoVisitRoutes, { db, store, now, enabled: demo, production, hashKey: fileSigningSecret ?? "aerowise-development-only-signing-secret", limits: demoVisitLimits, features });
  await app.register(demoRequestRoutes, { db, now, demoMail: { mail: transport, from: accountMailFrom, notifyTo: demoRequestNotifyTo, appUrl } });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
