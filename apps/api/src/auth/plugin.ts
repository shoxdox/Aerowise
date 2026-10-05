import type { Database } from "@aerowise/db";
import { isReadOnly, READ_ONLY_MESSAGE, roleHasPermission, type Permission } from "@aerowise/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { forbidden, HttpError, unauthorized } from "../lib/errors.ts";
import { ADMIN_SESSION_COOKIE, findAdminSession, type AdminContext } from "./admin-sessions.ts";
import { findSession, SESSION_COOKIE, type AuthContext } from "./sessions.ts";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Permission required to call the route. Every non-public route must set one. */
    permission?: Permission;
    /** Marks a route as callable without signing in (health, login). */
    public?: boolean;
    /**
     * A platform-admin (/admin) route: needs a platform-admin session. No tenant role
     * or tenant session ever satisfies it.
     */
    platformAdmin?: boolean;
    /** Accepts a raw image body instead of JSON (photo uploads). */
    imageUpload?: boolean;
    /** Accepts a form-encoded body: provider webhooks that sign their requests (Twilio). */
    signedForm?: boolean;
    /** May change data even when the organization is read-only (accepting the terms). */
    allowedWhenReadOnly?: boolean;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
    requireAuth(): AuthContext;
    admin: AdminContext | null;
    requireAdmin(): AdminContext;
  }
}

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/**
 * Deny by default: registering a route without `config.permission` or `config.public`
 * throws at startup, and every request to a protected route must carry a valid session
 * whose role grants the declared permission. A read-only organization's sessions may
 * only use safe methods.
 */
export const authPlugin = fp(async (app: FastifyInstance, opts: { db: Database }) => {
  app.decorateRequest("auth", null);
  app.decorateRequest("requireAuth", function (this: FastifyRequest) {
    if (!this.auth) throw unauthorized();
    return this.auth;
  });

  app.decorateRequest("admin", null);
  app.decorateRequest("requireAdmin", function (this: FastifyRequest) {
    if (!this.admin) throw unauthorized();
    return this.admin;
  });

  app.addHook("onRoute", (route) => {
    const config = route.config as { permission?: Permission; public?: boolean; platformAdmin?: boolean } | undefined;
    if (route.method === "HEAD") return;
    const declared = [config?.public, config?.permission, config?.platformAdmin].filter(Boolean).length;
    if (declared !== 1) {
      throw new Error(`Route ${route.method} ${route.url} must declare config.permission, config.platformAdmin or config.public (exactly one)`);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    const config = req.routeOptions.config;
    // Unknown routes fall through to the 404 handler.
    if (!req.routeOptions.url) return;

    // CSRF defense alongside SameSite=Lax cookies: state-changing requests must be JSON,
    // which a cross-site HTML form cannot send without a CORS preflight. Image uploads
    // are allowed on routes that opt in: image/* is not a CORS-safelisted type either.
    if (!SAFE_METHODS.includes(req.method)) {
      const type = req.headers["content-type"] ?? "";
      const allowed =
        type.startsWith("application/json") ||
        (config.imageUpload === true && type.startsWith("image/")) ||
        // Never with a session: these routes check the provider's signature instead.
        (config.signedForm === true && config.public === true && type.startsWith("application/x-www-form-urlencoded"));
      if (!allowed) {
        throw new HttpError(415, "unsupported_media_type", "Requests must send application/json");
      }
    }

    if (config.platformAdmin) {
      const adminToken = req.cookies[ADMIN_SESSION_COOKIE];
      req.admin = adminToken ? await findAdminSession(opts.db, adminToken) : null;
      if (req.admin) req.log = reply.log = req.log.child({ platformAdminId: req.admin.adminId });
      req.requireAdmin();
      return;
    }

    const token = req.cookies[SESSION_COOKIE];
    req.auth = token ? await findSession(opts.db, token) : null;
    // Every later log line for this request (including "request completed") names the tenant.
    if (req.auth) req.log = reply.log = req.log.child({ organizationId: req.auth.organizationId, userId: req.auth.userId });

    if (config.public) return;
    const auth = req.requireAuth();
    if (!config.permission || !roleHasPermission(auth.role, config.permission)) throw forbidden();
    // A lapsed organization keeps reading and exporting everything (reads are GETs) but
    // changes nothing. Public routes (homeowner links, provider webhooks) are not tenant
    // sessions and keep working, so a homeowner can still pay what they owe.
    if (!SAFE_METHODS.includes(req.method) && isReadOnly(auth.subscriptionState) && !config.allowedWhenReadOnly) {
      throw new HttpError(403, "organization_read_only", READ_ONLY_MESSAGE);
    }
  });
});
