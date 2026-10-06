import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Where uploaded files live. Keys are opaque paths chosen by the API, always prefixed
 * with the organization id (both stores refuse any other key). Local disk is the default;
 * Cloudflare R2 (`R2Store`) is used when it is configured.
 */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Returns null when the object does not exist. */
  get(key: string): Promise<Buffer | null>;
  /** Deletes every file of one organization (its whole key prefix) and returns how many there were. */
  deleteOrganization?(organizationId: string): Promise<number>;
}

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An organization id, checked before it is used as a key prefix to delete. */
export function assertOrganizationId(organizationId: string) {
  if (!ORG_ID.test(organizationId)) throw new Error("Invalid organization id");
}

const ORG_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

/**
 * Every key starts with the organization's id, so one organization's files can never be
 * named under another's, and holds only plain path segments (no "..", no empty ones).
 */
export function assertOrganizationKey(key: string) {
  if (!ORG_KEY.test(key) || key.split("/").some((s) => s === "." || s === "..")) throw new Error("Invalid storage key");
}

export class LocalDiskStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string) {
    assertOrganizationKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(key: string, body: Buffer, _contentType?: string) {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    // Write then rename so a reader never sees a half-written file.
    const tmp = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async deleteOrganization(organizationId: string) {
    assertOrganizationId(organizationId);
    const dir = join(this.root, organizationId);
    let count = 0;
    for await (const key of this.keys()) if (key.startsWith(`${organizationId}/`)) count++;
    await rm(dir, { recursive: true, force: true });
    return count;
  }

  /** Every stored key, for copying the files elsewhere. Half-written temporary files are skipped. */
  async *keys(): AsyncGenerator<string> {
    async function* walk(dir: string): AsyncGenerator<string> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, e.name);
        if (e.isDirectory()) yield* walk(full);
        else if (e.isFile() && !e.name.endsWith(".tmp")) yield full;
      }
    }
    for await (const full of walk(this.root)) yield relative(this.root, full).split(sep).join("/");
  }
}

export * from "./r2.ts";
export * from "./copy.ts";
export * from "./env.ts";
export * from "./fake-s3.ts";
