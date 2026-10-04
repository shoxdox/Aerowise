import { createHmac, timingSafeEqual } from "node:crypto";

/** What a link opens. Part of the signature, so a photo link cannot open a report. */
export type SignedKind = "files" | "report-files";

/**
 * Short-lived links to stored files. The signature covers the kind of file, the
 * organization id, the file id and the expiry, so a link works for exactly one file in
 * one tenant and cannot be edited to point at another.
 */
export class UrlSigner {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds = 15 * 60,
  ) {}

  private sign(kind: SignedKind, organizationId: string, id: string, exp: number) {
    return createHmac("sha256", this.secret).update(`${kind}.${organizationId}.${id}.${exp}`).digest("base64url");
  }

  url(organizationId: string, id: string, nowMs: number, kind: SignedKind = "files") {
    const exp = Math.floor(nowMs / 1000) + this.ttlSeconds;
    return `/${kind}/${id}?exp=${exp}&sig=${this.sign(kind, organizationId, id, exp)}`;
  }

  verify(organizationId: string, id: string, exp: number, sig: string, nowMs: number, kind: SignedKind = "files") {
    if (exp < Math.floor(nowMs / 1000)) return false;
    const expected = Buffer.from(this.sign(kind, organizationId, id, exp));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
