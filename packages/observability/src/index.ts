import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { pino, type Logger } from "pino";

/** What an error or alert is about. organizationId is the tenant, when there is one. */
export interface ReportContext {
  organizationId?: string | null;
  requestId?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

export type ReportLevel = "error" | "warning" | "info";

/**
 * Where unexpected errors and operational alerts go. The default does nothing (errors are
 * still in the JSON logs); with SENTRY_DSN set they go to Sentry. Reporting never throws
 * and never blocks the caller for long.
 */
export interface ErrorReporter {
  readonly name: string;
  captureException(err: unknown, ctx?: ReportContext): void;
  captureMessage(message: string, level: ReportLevel, ctx?: ReportContext): void;
  /** Waits for reports still being sent (on shutdown). */
  flush(timeoutMs?: number): Promise<void>;
}

export class NoopReporter implements ErrorReporter {
  readonly name = "none";
  captureException() {}
  captureMessage() {}
  async flush() {}
}

/** Keeps what was reported, for tests. */
export class TestReporter implements ErrorReporter {
  readonly name = "test";
  reports: { kind: "exception" | "message"; message: string; level: ReportLevel; ctx: ReportContext }[] = [];
  captureException(err: unknown, ctx: ReportContext = {}) {
    this.reports.push({ kind: "exception", message: err instanceof Error ? err.message : String(err), level: "error", ctx });
  }
  captureMessage(message: string, level: ReportLevel, ctx: ReportContext = {}) {
    this.reports.push({ kind: "message", message, level, ctx });
  }
  async flush() {}
}

interface Dsn {
  url: string;
  publicKey: string;
  raw: string;
}

function parseDsn(dsn: string): Dsn {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\//, "");
  if (!u.username || !/^\d+$/.test(projectId)) throw new Error("SENTRY_DSN is not a Sentry DSN (https://<key>@<host>/<project id>)");
  return { url: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, publicKey: u.username, raw: dsn };
}

/** V8 stack lines to Sentry frames, oldest call first. */
function framesOf(stack: string | undefined) {
  if (!stack) return [];
  const frames = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const filename = m[2]!.replace(/^file:\/\//, "");
    frames.push({ function: m[1] ?? "?", filename, lineno: Number(m[3]), colno: Number(m[4]), in_app: !filename.includes("node_modules") && !filename.startsWith("node:") });
  }
  return frames.reverse();
}

/**
 * Sends events to Sentry over its envelope endpoint with plain fetch, so the API and worker
 * carry no SDK (and no automatic instrumentation). Tags every event with the organization.
 */
export class SentryReporter implements ErrorReporter {
  readonly name = "sentry";
  private readonly dsn: Dsn;
  private readonly fetch: typeof fetch;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    dsn: string,
    private readonly opts: { environment?: string; release?: string; fetch?: typeof fetch; onError?: (err: unknown) => void } = {},
  ) {
    this.dsn = parseDsn(dsn);
    this.fetch = opts.fetch ?? fetch;
  }

  captureException(err: unknown, ctx: ReportContext = {}) {
    const e = err instanceof Error ? err : new Error(String(err));
    this.send({ level: "error", exception: { values: [{ type: e.name, value: e.message, stacktrace: { frames: framesOf(e.stack) } }] } }, ctx);
  }

  captureMessage(message: string, level: ReportLevel, ctx: ReportContext = {}) {
    this.send({ level, message: { formatted: message } }, ctx);
  }

  async flush(timeoutMs = 2000) {
    await Promise.race([Promise.allSettled([...this.pending]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  private send(body: Record<string, unknown>, ctx: ReportContext) {
    const eventId = randomUUID().replace(/-/g, "");
    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "node",
      server_name: hostname(),
      environment: this.opts.environment,
      release: this.opts.release,
      tags: { ...ctx.tags, ...(ctx.organizationId ? { organization_id: ctx.organizationId } : {}), ...(ctx.requestId ? { request_id: ctx.requestId } : {}) },
      extra: ctx.extra,
      ...body,
    };
    const envelope = [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: this.dsn.raw }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
    const p = this.fetch(this.dsn.url, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${this.dsn.publicKey}, sentry_client=aerowise/1.0` },
      body: envelope,
      signal: AbortSignal.timeout(5000),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Sentry answered ${res.status}`);
      })
      .catch((err) => this.opts.onError?.(err))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }
}

/** Sentry when SENTRY_DSN is set, nothing otherwise. Events are tagged with DEPLOY_ENV and the deployed commit (GIT_COMMIT on our server, RENDER_GIT_COMMIT on Render). */
export function reporterFromEnv(env: Record<string, string | undefined>, onError?: (err: unknown) => void): ErrorReporter {
  if (!env.SENTRY_DSN) return new NoopReporter();
  return new SentryReporter(env.SENTRY_DSN, { environment: env.DEPLOY_ENV ?? env.NODE_ENV ?? "development", release: env.GIT_COMMIT || env.RENDER_GIT_COMMIT || undefined, onError });
}

/** JSON lines on stdout, one object per event, the same shape as the API's request logs. */
export function createLogger(name: string, opts: { level?: string; destination?: NodeJS.WritableStream } = {}): Logger {
  return pino({ name, level: opts.level ?? process.env.LOG_LEVEL ?? "info", base: { service: name } }, opts.destination as never);
}

export type { Logger };
