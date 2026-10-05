import { createHash } from "node:crypto";
import type { LocalDiskStore, ObjectStore } from "./index.ts";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export interface CopyReport {
  copied: number;
  alreadyThere: number;
  /** Keys whose copy did not read back with the same SHA-256 (or could not be read at all). */
  mismatched: string[];
  skipped: string[];
}

/**
 * Copies every file from local disk to another store, then reads each one back and
 * compares SHA-256 hashes. Safe to run again: a file already there with the same hash is
 * not rewritten. Keys that are not organization-prefixed are skipped and listed.
 */
export async function copyStore(from: LocalDiskStore, to: ObjectStore, opts: { dryRun?: boolean; log?: (line: string) => void } = {}): Promise<CopyReport> {
  const log = opts.log ?? (() => {});
  const report: CopyReport = { copied: 0, alreadyThere: 0, mismatched: [], skipped: [] };
  for await (const key of from.keys()) {
    let source: Buffer | null;
    try {
      source = await from.get(key);
    } catch {
      report.skipped.push(key);
      log(`skip ${key} (not an organization file)`);
      continue;
    }
    if (!source) continue;
    const hash = sha256(source);
    const existing = await to.get(key);
    if (existing && sha256(existing) === hash) {
      report.alreadyThere++;
      continue;
    }
    if (opts.dryRun) {
      log(`would copy ${key} (${source.length} bytes)`);
      report.copied++;
      continue;
    }
    await to.put(key, source, contentTypeOf(key));
    const back = await to.get(key);
    if (!back || sha256(back) !== hash) {
      report.mismatched.push(key);
      log(`MISMATCH ${key}`);
    } else {
      report.copied++;
      log(`copied ${key} sha256=${hash}`);
    }
  }
  return report;
}

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  eml: "message/rfc822",
  json: "application/json",
};

/** Local disk keeps no content type, so it comes from the extension. Downloads set their own type anyway. */
export const contentTypeOf = (key: string) => TYPES[key.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
