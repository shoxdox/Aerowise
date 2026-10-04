import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEV_KEY = "aerowise-development-only-quickbooks-key";

function keyFrom(material: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(material)) return Buffer.from(material, "hex");
  const b = Buffer.from(material, "base64");
  if (b.length === 32 && /^[A-Za-z0-9+/_-]+=*$/.test(material)) return b;
  return createHash("sha256").update(material).digest();
}

/**
 * Encrypts QuickBooks tokens before they are stored (AES-256-GCM), and signs the OAuth
 * `state` so the callback only accepts a connection the same signed-in person started.
 * The key comes from QUICKBOOKS_TOKEN_KEY: 32 bytes as hex or base64, or any passphrase.
 */
export class TokenCipher {
  private readonly key: Buffer;
  private readonly macKey: Buffer;

  constructor(material: string = DEV_KEY) {
    this.key = keyFrom(material);
    this.macKey = createHash("sha256").update("oauth-state").update(this.key).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  decrypt(sealed: string): string {
    const [v, iv, tag, body] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("not an encrypted token");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  }

  /** An opaque `state` carrying who started connecting, valid for `ttlMs`. */
  signState(input: { organizationId: string; userId: string }, now: Date, ttlMs = 15 * 60_000): string {
    const payload = Buffer.from(JSON.stringify({ o: input.organizationId, u: input.userId, e: now.getTime() + ttlMs, n: randomBytes(8).toString("hex") })).toString("base64url");
    return `${payload}.${createHmac("sha256", this.macKey).update(payload).digest("base64url")}`;
  }

  /** Null when the state was not signed here, is malformed, or has expired. */
  verifyState(state: string, now: Date): { organizationId: string; userId: string } | null {
    const [payload, mac] = state.split(".");
    if (!payload || !mac) return null;
    const want = createHmac("sha256", this.macKey).update(payload).digest();
    const got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { o: string; u: string; e: number };
      if (typeof p.e !== "number" || p.e < now.getTime()) return null;
      return { organizationId: p.o, userId: p.u };
    } catch {
      return null;
    }
  }
}
