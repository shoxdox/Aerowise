import type { FastifyRequest } from "fastify";

/**
 * Limits on the routes a link opens without a sign-in (pay, renew, portal, estimate,
 * invitation, password reset) and on signed file links. They are keyed on the caller's
 * address alone: keying on the token as well, as these routes once did, gave every guessed
 * token its own allowance, so the limit never applied to the one thing it was for.
 * `TRUST_PROXY` decides which address a request is counted under.
 */
export interface PublicLinkLimits {
  /** Signing, declining, paying, accepting an invitation, setting a password: per address per minute. */
  actions: number;
  /** Signed file links (photos in reports and pages): per address per minute. */
  files: number;
}

export const DEFAULT_PUBLIC_LINK_LIMITS: PublicLinkLimits = { actions: 20, files: 300 };

/** A per-address, per-minute limit for one route. `name` keeps routes' counts apart. */
export const perAddress = (name: string, max: number) => ({ max, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => `${name}:${req.ip}` });
