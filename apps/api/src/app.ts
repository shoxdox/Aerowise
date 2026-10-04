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
import { authRoutes } from "./routes/auth.ts";
import { contractRoutes } from "./routes/contracts.ts";
import { customerRoutes } from "./routes/customers.ts";
import { inspectionRoutes } from "./routes/inspections.ts";
import { scheduleRoutes } from "./routes/schedule.ts";
import { siteRoutes } from "./routes/sites.ts";
import { UrlSigner } from "./storage/signed-urls.ts";
import { LocalDiskStore, type ObjectStore } from "./storage/store.ts";

export interface AppOptions {
  db: Database;
  production?: boolean;
  logger?: FastifyServerOptions["logger"];
  /** Sign-in attempts allowed per IP and email per minute. */
  loginRateLimit?: number;
  /** Clock used for "today" in due dates and contract states. Tests pin it. */
  now?: () => Date;
  /** Where uploaded photos are kept. Defaults to ./.data/files on local disk. */
  store?: ObjectStore;
  /** Secret for signed file links. Required in production. */
  fileSigningSecret?: string;
}

export async function buildApp({
  db,
  production = false,
  logger = false,
  loginRateLimit = 10,
  now = () => new Date(),
  store = new LocalDiskStore(".data/files"),
  fileSigningSecret,
}: AppOptions) {
  if (production && !fileSigningSecret) throw new Error("FILE_SIGNING_SECRET is required in production");
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
        components: { securitySchemes: { session: { type: "apiKey", in: "cookie", name: "aw_session" } } },
        security: [{ session: [] }],
      },
      transform: jsonSchemaTransform,
    });
    app.get("/openapi.json", { config: { public: true }, schema: { hide: true } }, async () => app.swagger());
  }

  await app.register(authPlugin, { db });

  app.get("/health", { config: { public: true }, schema: { hide: true } }, async () => {
    await db.selectNoFrom((eb) => eb.lit(1).as("ok")).execute();
    return { ok: true };
  });

  await app.register(authRoutes, { db, production, loginRateLimit });
  await app.register(customerRoutes, { db });
  await app.register(siteRoutes, { db });
  await app.register(contractRoutes, { db, now });
  await app.register(scheduleRoutes, { db, now });
  await app.register(inspectionRoutes, { db, now, store, signer });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
