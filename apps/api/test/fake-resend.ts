import { signResendWebhook } from "@aerowise/compliance";

interface Stored {
  id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
  tags: { name: string; value: string }[];
  attachments: { filename: string }[];
}

export const RESEND_TEST_SECRET = `whsec_${Buffer.from("aerowise-test-webhook-secret").toString("base64")}`;

/**
 * A stand-in for Resend's HTTP API, plugged in as `fetch`. It keeps idempotency keys for
 * 24 hours of the test clock, lists sent emails newest first, and can be told to:
 * - "lose": send the email, then drop the connection before answering (the worst case);
 * - "error_500": answer 500 without sending (we cannot tell that from "lose");
 * - "reject_422": refuse the request (certainly not sent).
 */
export class FakeResend {
  emails: Stored[] = [];
  keys = new Map<string, { id: string; at: number }>();
  requests: { method: string; path: string }[] = [];
  next: "ok" | "lose" | "error_500" | "reject_422" = "ok";
  private seq = 0;

  constructor(private readonly clock: () => Date) {}

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.requests.push({ method, path: url.pathname + url.search });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/emails") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const after = url.searchParams.get("after");
      const all = [...this.emails].reverse();
      const start = after ? all.findIndex((e) => e.id === after) + 1 : 0;
      const page = all.slice(start, start + limit);
      return json(200, { object: "list", has_more: start + limit < all.length, data: page.map(({ tags: _t, attachments: _a, ...e }) => ({ ...e, last_event: "delivered" })) });
    }
    if (method === "POST" && url.pathname === "/emails") {
      const mode = this.next;
      this.next = "ok";
      if (mode === "reject_422") return json(422, { name: "validation_error", message: "Invalid `to` field" });
      if (mode === "error_500") return json(500, { name: "internal_server_error", message: "Something went wrong" });
      const key = new Headers(init?.headers).get("idempotency-key")!;
      const now = this.clock().getTime();
      const remembered = this.keys.get(key);
      let id: string;
      if (remembered && now - remembered.at < 24 * 3600_000) {
        id = remembered.id;
      } else {
        const body = JSON.parse(String(init!.body)) as Omit<Stored, "id" | "created_at">;
        id = `re_${++this.seq}`;
        this.emails.push({ id, from: body.from, to: body.to, subject: body.subject, created_at: new Date(now).toISOString(), tags: body.tags, attachments: body.attachments });
        this.keys.set(key, { id, at: now });
      }
      if (mode === "lose") throw new TypeError("fetch failed: socket hang up");
      return json(200, { id });
    }
    return json(404, { message: "not found" });
  };

  /** A webhook as Resend would deliver it, signed with the test secret. */
  webhook(type: string, emailId: string, data: Record<string, unknown> = {}, eventId = `msg_${crypto.randomUUID()}`) {
    const email = this.emails.find((e) => e.id === emailId);
    const body = JSON.stringify({
      type,
      created_at: this.clock().toISOString(),
      data: { email_id: emailId, to: email?.to, subject: email?.subject, tags: Object.fromEntries((email?.tags ?? []).map((t) => [t.name, t.value])), ...data },
    });
    return { body, headers: { "content-type": "application/json", ...signResendWebhook(RESEND_TEST_SECRET, eventId, Math.floor(this.clock().getTime() / 1000), body) } };
  }
}
