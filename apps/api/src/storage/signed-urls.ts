import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived links to stored files. The signature covers the organization id, the
 * attachment id and the expiry, so a link works for exactly one file in one tenant and
 * cannot be edited to point at another.
 */
export class UrlSigner {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds = 15 * 60,
  ) {}

  private sign(organizationId: string, attachmentId: string, exp: number) {
    return createHmac("sha256", this.secret).update(`${organizationId}.${attachmentId}.${exp}`).digest("base64url");
  }

  url(organizationId: string, attachmentId: string, nowMs: number) {
    const exp = Math.floor(nowMs / 1000) + this.ttlSeconds;
    return `/files/${attachmentId}?exp=${exp}&sig=${this.sign(organizationId, attachmentId, exp)}`;
  }

  verify(organizationId: string, attachmentId: string, exp: number, sig: string, nowMs: number) {
    if (exp < Math.floor(nowMs / 1000)) return false;
    const expected = Buffer.from(this.sign(organizationId, attachmentId, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
