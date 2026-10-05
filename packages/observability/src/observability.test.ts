import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, NoopReporter, reporterFromEnv, SentryReporter } from "./index.ts";

function fakeSentry() {
  const sent: { url: string; headers: Headers; lines: unknown[] }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), lines: String(init.body).split("\n").map((l) => JSON.parse(l)) });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

describe("error reporting", () => {
  it("does nothing without SENTRY_DSN, and reports to Sentry with one", () => {
    expect(reporterFromEnv({})).toBeInstanceOf(NoopReporter);
    expect(reporterFromEnv({ SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/42" })).toBeInstanceOf(SentryReporter);
    expect(() => reporterFromEnv({ SENTRY_DSN: "https://o1.ingest.sentry.io/notaproject" })).toThrow(/not a Sentry DSN/);
  });

  it("sends an exception as a Sentry envelope tagged with the organization and request", async () => {
    const s = fakeSentry();
    const r = new SentryReporter("https://abc123@o1.ingest.sentry.io/42", { environment: "staging", release: "abc", fetch: s.fetch });
    r.captureException(new TypeError("boom"), { organizationId: "org-1", requestId: "req-1", tags: { route: "GET /x" }, extra: { taskId: "t1" } });
    await r.flush();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.url).toBe("https://o1.ingest.sentry.io/api/42/envelope/");
    expect(s.sent[0]!.headers.get("x-sentry-auth")).toBe("Sentry sentry_version=7, sentry_key=abc123, sentry_client=aerowise/1.0");
    const [header, item, event] = s.sent[0]!.lines as [{ event_id: string }, unknown, { event_id: string; exception: { values: { stacktrace: { frames: unknown } }[] } }];
    expect(header.event_id).toBe(event.event_id);
    expect(item).toEqual({ type: "event" });
    expect(event).toMatchObject({
      level: "error",
      environment: "staging",
      release: "abc",
      tags: { route: "GET /x", organization_id: "org-1", request_id: "req-1" },
      extra: { taskId: "t1" },
      exception: { values: [{ type: "TypeError", value: "boom" }] },
    });
    const frames = event.exception.values[0]!.stacktrace.frames as { filename: string; in_app: boolean }[];
    expect(frames.at(-1)!.filename).toMatch(/observability\.test\.ts$/);
  });

  it("sends alerts as messages, and a failing Sentry never throws into the caller", async () => {
    const errors: unknown[] = [];
    const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const r = new SentryReporter("https://k@sentry.example/7", { fetch: down, onError: (e) => errors.push(e) });
    expect(() => r.captureMessage("Worker queue stalled", "error", { tags: { alert: "queue_stalled" } })).not.toThrow();
    await r.flush();
    expect(String(errors[0])).toMatch(/503/);
  });
});

describe("logs", () => {
  it("writes one JSON object per line with the service name", () => {
    const lines: string[] = [];
    const out = new Writable({ write: (chunk, _e, done) => (lines.push(String(chunk)), done()) });
    createLogger("worker", { destination: out }).info({ taskId: "t1", organizationId: "org-1" }, "task done");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 30, service: "worker", taskId: "t1", organizationId: "org-1", msg: "task done" });
  });
});
