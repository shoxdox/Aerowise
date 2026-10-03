import type { Database } from "@aerowise/db";
import { roleHasPermission, type Permission } from "@aerowise/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { forbidden, HttpError, unauthorized } from "../lib/errors.ts";
import { findSession, SESSION_COOKIE, type AuthContext } from "./sessions.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Permission required to call the route. Every non-public route must set one. */
    permission?: Permission;
    /** Marks a route as callable without signing in (health, login). */
    public?: boolean;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
    requireAuth(): AuthContext;
  }
}

/**
 * Deny by default: registering a route without `config.permission` or `config.public`
 * throws at startup, and every request to a protected route must carry a valid session
 * whose role grants the declared permission.
 */
export const authPlugin = fp(async (app: FastifyInstance, opts: { db: Database }) => {
  app.decorateRequest("auth", null);
  app.decorateRequest("requireAuth", function (this: FastifyRequest) {
    if (!this.auth) throw unauthorized();
    return this.auth;
  });

  app.addHook("onRoute", (route) => {
    const config = route.config as { permission?: Permission; public?: boolean } | undefined;
    if (route.method === "HEAD") return;
    if (!config?.public && !config?.permission) {
      throw new Error(`Route ${route.method} ${route.url} must declare config.permission or config.public`);
    }
  });

  app.addHook("onRequest", async (req) => {
    const config = req.routeOptions.config;
    // Unknown routes fall through to the 404 handler.
    if (!req.routeOptions.url) return;

    // CSRF defense alongside SameSite=Lax cookies: state-changing requests must be JSON,
    // which a cross-site HTML form cannot send without a CORS preflight.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const type = req.headers["content-type"] ?? "";
      if (!type.startsWith("application/json")) {
        throw new HttpError(415, "unsupported_media_type", "Requests must send application/json");
      }
    }

    const token = req.cookies[SESSION_COOKIE];
    req.auth = token ? await findSession(opts.db, token) : null;

    if (config.public) return;
    const auth = req.requireAuth();
    if (!config.permission || !roleHasPermission(auth.role, config.permission)) throw forbidden();
  });
});
