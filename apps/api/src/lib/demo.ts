import type { Database } from "@aerowise/db";
import { watermarkPdf } from "@aerowise/reports";
import type { ObjectStore } from "@aerowise/storage";
import { demoCheck, type DemoCheck } from "@aerowise/tasks";

const checks = new WeakMap<Database, DemoCheck>();

/**
 * A stored file as handed out for download or viewing. A demo company's PDFs (reports,
 * invoices, agreements, filing packages) come out stamped as fictional and not filed; the
 * stored file and its hash stay as made. Keys start with the organization id.
 */
export async function readForDownload(db: Database, store: ObjectStore, key: string): Promise<Buffer | null> {
  const data = await store.get(key);
  if (!data || data.subarray(0, 5).toString("latin1") !== "%PDF-") return data;
  let isDemo = checks.get(db);
  if (!isDemo) checks.set(db, (isDemo = demoCheck(db)));
  const org = key.split("/")[0]!;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(org)) return data;
  return (await isDemo(org)) ? watermarkPdf(data) : data;
}
