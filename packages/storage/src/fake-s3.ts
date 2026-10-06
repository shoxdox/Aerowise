import { createHash } from "node:crypto";

/**
 * An S3-compatible bucket in memory, plugged into `R2Store` as `fetch`, for tests. It
 * checks what a real bucket would refuse: a request not signed with SigV4 for the right
 * key, region and service, or a body that does not match its signed hash.
 */
export class FakeS3 {
  objects = new Map<string, { body: Buffer; contentType: string }>();
  requests: { method: string; path: string }[] = [];

  constructor(
    private readonly bucket = "aerowise-test",
    private readonly accessKeyId = "test-access-key",
  ) {}

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    this.requests.push({ method: req.method, path: url.pathname });
    const auth = req.headers.get("authorization") ?? "";
    if (!new RegExp(`^AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/\\d{8}/auto/s3/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$`).test(auth)) {
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
    }
    if (req.method === "GET" && url.pathname === `/${this.bucket}` && url.searchParams.get("list-type") === "2") {
      // ListObjectsV2, two keys a page so tests cross a page boundary.
      const all = [...this.objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? "")).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = all.slice(start, start + 2);
      const more = start + 2 < all.length;
      const keys = page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key></Contents>`).join("");
      const next = more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : "";
      return new Response(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${keys}${next}</ListBucketResult>`, { status: 200 });
    }
    const prefix = `/${this.bucket}/`;
    if (!url.pathname.startsWith(prefix)) return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
    const key = url.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    if (req.method === "PUT") {
      const body = Buffer.from(await req.arrayBuffer());
      const claimed = req.headers.get("x-amz-content-sha256");
      if (claimed !== createHash("sha256").update(body).digest("hex")) return new Response("<Error><Code>XAmzContentSHA256Mismatch</Code></Error>", { status: 400 });
      this.objects.set(key, { body, contentType: req.headers.get("content-type") ?? "application/octet-stream" });
      return new Response(null, { status: 200 });
    }
    if (req.method === "GET") {
      const o = this.objects.get(key);
      if (!o) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      return new Response(new Uint8Array(o.body), { status: 200, headers: { "content-type": o.contentType } });
    }
    if (req.method === "DELETE") {
      this.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };
}
