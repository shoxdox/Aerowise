import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The worker touches a file after every pass of its loop. A host (or the API's /health, when
// the two share a machine) treats a missing or old file as a stuck or dead worker.

/** Where the worker writes its heartbeat unless WORKER_HEARTBEAT_FILE says otherwise. */
export const DEFAULT_HEARTBEAT_FILE = join(tmpdir(), "aerowise-worker-heartbeat");

/**
 * How old the heartbeat may be before the worker counts as unhealthy. One pass can include a
 * slow task (a report PDF, a QuickBooks sync), so this is minutes, not the poll interval.
 */
export const DEFAULT_HEARTBEAT_MAX_AGE_MS = 5 * 60_000;

export interface HeartbeatOptions {
  file: string;
  maxAgeMs: number;
}

export function heartbeatFromEnv(env: NodeJS.ProcessEnv): HeartbeatOptions {
  const maxAgeMs = Number(env.WORKER_HEARTBEAT_MAX_AGE_MS ?? DEFAULT_HEARTBEAT_MAX_AGE_MS);
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("WORKER_HEARTBEAT_MAX_AGE_MS must be a positive number");
  return { file: env.WORKER_HEARTBEAT_FILE || DEFAULT_HEARTBEAT_FILE, maxAgeMs };
}

export async function writeHeartbeat(file: string, now: Date = new Date()) {
  try {
    await utimes(file, now, now);
  } catch {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "");
    await utimes(file, now, now);
  }
}

export type HeartbeatStatus = { ok: true; ageMs: number } | { ok: false; ageMs: number | null; reason: string };

export async function checkHeartbeat({ file, maxAgeMs }: HeartbeatOptions, now: Date = new Date()): Promise<HeartbeatStatus> {
  let mtime: Date;
  try {
    mtime = (await stat(file)).mtime;
  } catch {
    return { ok: false, ageMs: null, reason: "the worker has not reported in" };
  }
  const ageMs = Math.max(0, now.getTime() - mtime.getTime());
  if (ageMs > maxAgeMs) return { ok: false, ageMs, reason: `the worker last reported ${Math.round(ageMs / 1000)}s ago` };
  return { ok: true, ageMs };
}
