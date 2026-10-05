import { LocalDiskStore, type ObjectStore } from "./index.ts";
import { R2Store } from "./r2.ts";

const R2_KEYS = ["R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

/**
 * File storage as the environment configures it: Cloudflare R2 when all four R2 settings
 * are present, local disk (FILE_STORAGE_DIR) otherwise. Some but not all R2 settings is a
 * mistake, and refused, so files never silently land on a server's disk.
 */
export function storeFromEnv(env: Record<string, string | undefined>): ObjectStore {
  const missing = R2_KEYS.filter((k) => !env[k]);
  if (missing.length === 0) {
    return new R2Store({
      accountId: env.R2_ACCOUNT_ID!,
      bucket: env.R2_BUCKET!,
      accessKeyId: env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
      endpoint: env.R2_ENDPOINT || undefined,
    });
  }
  if (missing.length < R2_KEYS.length) throw new Error(`R2 is partly configured; missing ${missing.join(", ")}`);
  return new LocalDiskStore(env.FILE_STORAGE_DIR ?? ".data/files");
}
