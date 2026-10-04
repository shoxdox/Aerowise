import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Where uploaded files live. Keys are opaque paths chosen by the API, always prefixed
 * with the organization id. Local disk is the default; an S3-compatible store can be
 * added behind this interface without touching the routes.
 */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Returns null when the object does not exist. */
  get(key: string): Promise<Buffer | null>;
}

export class LocalDiskStore implements ObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string) {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(key: string, body: Buffer) {
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
}
