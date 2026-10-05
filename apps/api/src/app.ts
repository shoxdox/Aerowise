import { OutboxTransport, syncRulesets, type EmailTransport } from "@aerowise/compliance";
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
import { authRoutes } from "./routes/auth.ts";
import { filingRoutes } from "./routes/filings.ts";
import { importRoutes } from "./routes/imports.ts";
import { inboxRoutes } from "./routes/inbox.ts";
import { invoiceRoutes } from "./routes/invoices.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { portalRoutes } from "./routes/portal.ts";
import { quickbooksRoutes } from "./routes/quickbooks.ts";
import { renewalRoutes } from "./routes/renewals.ts";
import { contractRoutes } from "./routes/contracts.ts";
import { customerRoutes } from "./routes/customers.ts";
import { inspectionRoutes } from "./routes/inspections.ts";
import { readinessRoutes } from "./routes/readiness.ts";
import { labTestRoutes } from "./routes/lab-tests.ts";
import { reportRoutes } from "./routes/reports.ts";
import { scheduleRoutes } from "./routes/schedule.ts";
import { siteRoutes } from "./routes/sites.ts";
import { routingRoutes } from "./routes/routing.ts";
import { smsRoutes } from "./routes/sms.ts";
import { userRoutes } from "./routes/users.ts";
import { passwordResetRoutes } from "./routes/password-reset.ts";
import { UrlSigner } from "./storage/signed-urls.ts";
import { LocalDiskStore, type ObjectStore } from "@aerowise/storage";
import { checkHeartbeat, DEFAULT_APP_URL, enqueue, type HeartbeatOptions } from "@aerowise/tasks";
import { TestPaymentProvider, type PaymentProvider } from "@aerowise/payments";
import { TestQuickBooksProvider, TokenCipher } from "@aerowise/quickbooks";
import type { QuickBooksConfig } from "./lib/quickbooks.ts";
import { TestSmsProvider, type SmsConfig } from "@aerowise/sms";
import { CensusGeocoder, TestGeocoder, type Geocoder } from "@aerowise/routing";

export interface AppOptions {
  db: Database;
  production?: boolean;
  logger?: FastifyServerOptions["logger"];
  /** Sign-in attempts allowed per IP and email per minute. */
  loginRateLimit?: number;
  /** Password reset requests allowed per IP and email per minute. */
  passwordResetRateLimit?: number;
  /** Clock used for "today" in due dates and contract states. Tests pin it. */
  now?: () => Date;
  /** Where uploaded photos are kept. Defaults to ./.data/files on local disk. */
  store?: ObjectStore;
  /** Secret for signed file links. Required in production. */
  fileSigningSecret?: string;
  /** How filings and invitations are emailed. Defaults to the development outbox in file storage. */
  mail?: EmailTransport;
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
  /**
   * When the worker runs on the same machine as the API (one hosted service sharing a disk),
   * /health also fails if the worker's heartbeat is missing or old, so the host restarts both.
   */
  workerHeartbeat?: HeartbeatOptions;
}

export async function buildApp({
  db,
  production = false,
  logger = false,
  loginRateLimit = 10,
  passwordResetRateLimit = 5,
  now = () => new Date(),
  store = new LocalDiskStore(".data/files"),
  fileSigningSecret,
  mail,
  accountMailFrom = "accounts@aerowise.invalid",
  payments = production ? null : new TestPaymentProvider(),
  appUrl = DEFAULT_APP_URL,
  quickbooks = production ? null : { provider: new TestQuickBooksProvider(db, now), cipher: new TokenCipher() },
  sms = production ? null : { provider: new TestSmsProvider(), webhookBaseUrl: `${appUrl.replace(/\/$/, "")}/api` },
  geocoder = production ? new CensusGeocoder() : new TestGeocoder(),
  workerHeartbeat,
}: AppOptions) {
  if (production && !fileSigningSecret) throw new Error("FILE_SIGNING_SECRET is required in production");
  // Reporting authorities' rules ship with the code; make sure the database has them.
  // Fictional rules (the example county) are for development and tests only.
  await syncRulesets(db, undefined, { includeFictional: !production });
  const signer = new UrlSigner(fileSigningSecret ?? "aerowise-development-only-signing-secret");

  const app = Fastify({
    logger,
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
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
    return reply.status(500).send({ error: "internal", message: "Something went wrong", requestId: req.id });
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("cache-control", "no-store");
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

  app.get("/health", { config: { public: true }, schema: { hide: true } }, async (_req, reply) => {
    await db.selectNoFrom((eb) => eb.lit(1).as("ok")).execute();
    if (!workerHeartbeat) return { ok: true };
    const worker = await checkHeartbeat(workerHeartbeat, now());
    if (!worker.ok) return reply.code(503).send({ ok: false, worker: worker.reason });
    return { ok: true, worker: "ok" };
  });

  const transport = mail ?? new OutboxTransport(store, now);
  const invitations = { mail: transport, appUrl, from: accountMailFrom };
  await app.register(authRoutes, { db, production, loginRateLimit });
  await app.register(adminRoutes, { db, production, loginRateLimit, now, invitations });
  await app.register(userRoutes, { db, now, production, invitations });
  await app.register(passwordResetRoutes, { db, now, rateLimit: passwordResetRateLimit });
  await app.register(customerRoutes, { db, now });
  await app.register(siteRoutes, { db, now });
  await app.register(contractRoutes, { db, now });
  await app.register(scheduleRoutes, { db, now });
  await app.register(inspectionRoutes, { db, now, store, signer });
  await app.register(reportRoutes, { db, now, store, signer });
  await app.register(inboxRoutes, { db, now });
  await app.register(importRoutes, { db, now });
  await app.register(invoiceRoutes, { db, now, store, payments: { provider: payments, appUrl } });
  await app.register(paymentRoutes, { db, now, store, payments: { provider: payments, appUrl }, production });
  await app.register(renewalRoutes, { db, now, store, payments: { provider: payments, appUrl } });
  await app.register(portalRoutes, { db, now, store, appUrl });
  await app.register(quickbooksRoutes, { db, now, quickbooks, appUrl });
  await app.register(smsRoutes, { db, now, sms });
  await app.register(routingRoutes, { db, now, geocoder });
  const compliance = { store, mail: transport, enqueue };
  await app.register(filingRoutes, { db, now, signer, compliance });
  await app.register(readinessRoutes, { db, now, signer, compliance });
  await app.register(labTestRoutes, { db, now });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
