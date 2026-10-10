import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pay links and renewal links are signed, not stored. A token is the row's id and an HMAC of
 * it under the server's signing secret, so the database holds nothing a link can be rebuilt
 * from (a copy of the database gives nobody a working link), and the same link can be put in
 * an invoice PDF, a reminder email, a text and the customer portal without keeping its
 * plaintext anywhere. A link stops working when its invoice is no longer open or its renewal
 * can no longer be signed; those states are the expiry.
 *
 * The API and the worker both call `configureLinkTokens` once at start-up with
 * FILE_SIGNING_SECRET, so links made by either verify on the API.
 */

const DEV_SECRET = "aerowise-development-only-signing-secret";
let secret = DEV_SECRET;

export function configureLinkTokens(signingSecret: string | undefined) {
  secret = signingSecret && signingSecret.length > 0 ? signingSecret : DEV_SECRET;
}

export type LinkKind = "pay" | "renew";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mac = (kind: LinkKind, id: string) => createHmac("sha256", secret).update(`${kind}:${id}`).digest("base64url");

/** The token in a link: `<id>.<signature>`. */
export const linkToken = (kind: LinkKind, id: string) => `${id}.${mac(kind, id)}`;

/** The id a token names, when its signature verifies; null for anything else. */
export function linkTokenId(kind: LinkKind, token: string): string | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const id = token.slice(0, dot).toLowerCase();
  if (!UUID.test(id)) return null;
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(kind, id));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return id;
}

/** Shape of a signed link token, for route parameter validation. */
export const LINK_TOKEN_PATTERN = /^[0-9a-fA-F-]{36}\.[A-Za-z0-9_-]{43}$/;

const base = (appUrl: string) => appUrl.replace(/\/$/, "");
export const payUrlFor = (appUrl: string, invoiceId: string) => `${base(appUrl)}/pay/${linkToken("pay", invoiceId)}`;
export const renewUrlFor = (appUrl: string, renewalId: string) => `${base(appUrl)}/renew/${linkToken("renew", renewalId)}`;
