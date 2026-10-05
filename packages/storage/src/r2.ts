import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { assertOrganizationKey, type ObjectStore } from "./index.ts";

type Fetch = typeof fetch;

export interface R2Options {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Another S3-compatible endpoint (a local MinIO, a test double). Defaults to R2's. */
  endpoint?: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

/**
 * Cloudflare R2 through its S3 API, signed with SigV4. The bucket stays private: this
 * store never hands out bucket URLs. People reach a file only through Aerowise's own
 * short-lived signed links, which check the organization before streaming it from here.
 */
export class R2Store implements ObjectStore {
  private readonly aws: AwsClient;
  private readonly base: string;
  private readonly fetch: Fetch;
  private readonly timeoutMs: number;

  constructor(opts: R2Options) {
    this.aws = new AwsClient({ accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, service: "s3", region: "auto" });
    const endpoint = (opts.endpoint ?? `https://${opts.accountId}.r2.cloudflarestorage.com`).replace(/\/$/, "");
    this.base = `${endpoint}/${encodeURIComponent(opts.bucket)}`;
    this.fetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private url(key: string) {
    assertOrganizationKey(key);
    return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  private async send(method: "GET" | "PUT", key: string, init: { body?: Buffer; headers?: Record<string, string> } = {}) {
    // The payload hash is signed too, so the bucket refuses a body changed on the way.
    const contentSha256 = createHash("sha256").update(init.body ?? Buffer.alloc(0)).digest("hex");
    const signed = await this.aws.sign(this.url(key), { method, headers: { ...init.headers, "x-amz-content-sha256": contentSha256 }, body: init.body });
    return this.fetch(signed, { signal: AbortSignal.timeout(this.timeoutMs) });
  }

  async put(key: string, body: Buffer, contentType: string) {
    const res = await this.send("PUT", key, { body, headers: { "content-type": contentType } });
    if (!res.ok) throw new Error(`R2 refused to store ${key}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }

  async get(key: string) {
    const res = await this.send("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 could not read ${key}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
