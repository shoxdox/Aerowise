import { resolve } from "node:path";
import { copyStore, LocalDiskStore, R2Store, storeFromEnv } from "./index.ts";

// pnpm files:copy-to-r2 [--dry-run]
// Copies every file under FILE_STORAGE_DIR to the R2 bucket in R2_* and checks each by
// SHA-256. Safe to run again. Run it with the same environment as the API.
const dryRun = process.argv.includes("--dry-run");
const target = storeFromEnv(process.env);
if (!(target instanceof R2Store)) {
  console.error("R2 is not configured: set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.");
  process.exit(1);
}
// pnpm runs this from packages/storage; a relative directory means relative to where it was started.
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), process.env.FILE_STORAGE_DIR ?? ".data/files");
console.log(`${dryRun ? "Checking" : "Copying"} ${dir} to R2 bucket ${process.env.R2_BUCKET}`);
const report = await copyStore(new LocalDiskStore(dir), target, { dryRun, log: (l) => console.log(l) });
console.log(
  `${dryRun ? "Would copy" : "Copied and verified"} ${report.copied}; already there with the same SHA-256: ${report.alreadyThere}; ` +
    `skipped (not an organization file): ${report.skipped.length}; mismatched: ${report.mismatched.length}`,
);
if (report.mismatched.length) {
  console.error(`These did not read back the same; run again before switching over:\n${report.mismatched.join("\n")}`);
  process.exit(2);
}
