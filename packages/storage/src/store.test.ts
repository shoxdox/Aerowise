import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeS3 } from "./fake-s3.ts";
import { copyStore, LocalDiskStore, R2Store, storeFromEnv, type ObjectStore } from "./index.ts";

const ORG = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const r2 = (s3 = new FakeS3()) => new R2Store({ accountId: "acct", bucket: "aerowise-test", accessKeyId: "test-access-key", secretAccessKey: "secret", endpoint: "https://r2.test", fetch: s3.fetch });
const disk = () => new LocalDiskStore(mkdtempSync(join(tmpdir(), "aw-store-")));

const stores: [string, () => ObjectStore][] = [
  ["local disk", disk],
  ["R2 (S3 API)", () => r2()],
];

describe.each(stores)("%s", (_name, make) => {
  it("stores and reads back the exact bytes, and answers null for a missing key", async () => {
    const store = make();
    const body = Buffer.from([0xff, 0xd8, 0, 1, 2, 0xff, 0xd9]);
    await store.put(`${ORG}/inspections/i1/photo-1.jpg`, body, "image/jpeg");
    expect((await store.get(`${ORG}/inspections/i1/photo-1.jpg`))!.equals(body)).toBe(true);
    expect(await store.get(`${ORG}/inspections/i1/nope.jpg`)).toBeNull();
  });

  it("deletes every file of one organization and nothing of another", async () => {
    const store = make();
    for (const key of [`${ORG}/a.pdf`, `${ORG}/reports/r1.pdf`, `${ORG}/reports/r2.pdf`, `${ORG}/exports/e.zip`, `${OTHER}/a.pdf`]) await store.put(key, Buffer.from(key), "application/pdf");
    expect(await store.deleteOrganization!(ORG)).toBe(4);
    expect(await store.get(`${ORG}/reports/r1.pdf`)).toBeNull();
    expect(await store.get(`${ORG}/exports/e.zip`)).toBeNull();
    expect((await store.get(`${OTHER}/a.pdf`))!.toString()).toBe(`${OTHER}/a.pdf`);
    expect(await store.deleteOrganization!(ORG)).toBe(0);
    await expect(store.deleteOrganization!("../etc")).rejects.toThrow("Invalid organization id");
  });

  it("replaces an object written again under the same key", async () => {
    const store = make();
    await store.put(`${ORG}/a.pdf`, Buffer.from("one"), "application/pdf");
    await store.put(`${ORG}/a.pdf`, Buffer.from("two"), "application/pdf");
    expect((await store.get(`${ORG}/a.pdf`))!.toString()).toBe("two");
  });

  it("keeps organizations apart and refuses keys not prefixed by an organization id", async () => {
    const store = make();
    await store.put(`${ORG}/reports/r.pdf`, Buffer.from("mine"), "application/pdf");
    expect(await store.get(`${OTHER}/reports/r.pdf`)).toBeNull();
    for (const bad of ["reports/r.pdf", `${ORG}`, `${ORG}/../${OTHER}/r.pdf`, `${ORG}//r.pdf`, `/${ORG}/r.pdf`, `${ORG}/a b.pdf`, "not-a-uuid/r.pdf"]) {
      await expect(store.put(bad, Buffer.from("x"), "text/plain"), bad).rejects.toThrow("Invalid storage key");
      await expect(store.get(bad), bad).rejects.toThrow("Invalid storage key");
    }
  });
});

describe("R2Store", () => {
  it("signs each request for the bucket and puts the organization first in the object key", async () => {
    const s3 = new FakeS3();
    await r2(s3).put(`${ORG}/inspections/i1/p.jpg`, Buffer.from("x"), "image/jpeg");
    expect(s3.requests).toEqual([{ method: "PUT", path: `/aerowise-test/${ORG}/inspections/i1/p.jpg` }]);
    expect(s3.objects.get(`${ORG}/inspections/i1/p.jpg`)!.contentType).toBe("image/jpeg");
  });

  it("fails loudly when the bucket refuses (wrong credentials)", async () => {
    const s3 = new FakeS3("aerowise-test", "someone-else");
    await expect(r2(s3).put(`${ORG}/a.pdf`, Buffer.from("x"), "application/pdf")).rejects.toThrow(/R2 refused to store .* 403/);
    await expect(r2(s3).get(`${ORG}/a.pdf`)).rejects.toThrow(/403/);
  });
});

describe("storeFromEnv", () => {
  const r2Env = { R2_ACCOUNT_ID: "acct", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s" };
  it("uses R2 when all four settings are present, local disk when none are", () => {
    expect(storeFromEnv(r2Env)).toBeInstanceOf(R2Store);
    expect(storeFromEnv({ FILE_STORAGE_DIR: "/tmp/x" })).toBeInstanceOf(LocalDiskStore);
  });
  it("refuses a partial R2 configuration and names what is missing", () => {
    expect(() => storeFromEnv({ ...r2Env, R2_SECRET_ACCESS_KEY: "", R2_BUCKET: undefined })).toThrow("R2 is partly configured; missing R2_BUCKET, R2_SECRET_ACCESS_KEY");
  });
});

describe("copying local files to R2", () => {
  it("copies every file, verifies each by SHA-256, skips stray files, and is safe to run again", async () => {
    const from = disk();
    await from.put(`${ORG}/inspections/i1/p.jpg`, Buffer.from("photo"), "image/jpeg");
    await from.put(`${OTHER}/reports/r.pdf`, Buffer.from("%PDF"), "application/pdf");
    // A half-written temporary file and a file outside any organization.
    const root = (from as unknown as { root: string }).root;
    writeFileSync(join(root, ORG, "inspections", "i1", "p.jpg.123.tmp"), "partial");
    await mkdir(join(root, "stray"), { recursive: true });
    writeFileSync(join(root, "stray", "x.txt"), "x");

    const s3 = new FakeS3();
    const to = r2(s3);
    const dry = await copyStore(from, to, { dryRun: true });
    expect(dry).toMatchObject({ copied: 2, mismatched: [] });
    expect(s3.objects.size).toBe(0);

    const first = await copyStore(from, to);
    expect(first).toEqual({ copied: 2, alreadyThere: 0, mismatched: [], skipped: ["stray/x.txt"] });
    expect(s3.objects.get(`${OTHER}/reports/r.pdf`)).toMatchObject({ contentType: "application/pdf" });
    expect((await to.get(`${ORG}/inspections/i1/p.jpg`))!.toString()).toBe("photo");

    const again = await copyStore(from, to);
    expect(again).toMatchObject({ copied: 0, alreadyThere: 2, mismatched: [] });
  });

  it("reports a file that does not read back the same", async () => {
    const from = disk();
    await from.put(`${ORG}/a.pdf`, Buffer.from("original"), "application/pdf");
    const s3 = new FakeS3();
    const broken: ObjectStore = { put: (k: string, b: Buffer, t: string) => r2(s3).put(k, Buffer.concat([b, Buffer.from("!")]), t), get: (k: string) => r2(s3).get(k) };
    expect((await copyStore(from, broken)).mismatched).toEqual([`${ORG}/a.pdf`]);
  });
});
