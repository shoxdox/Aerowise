import { FakeS3, R2Store } from "@aerowise/storage";
import { describe, expect, it } from "vitest";
import { client, setupTestApp } from "./helpers.ts";
import { JPEG, payload, photoUrl, setup } from "./inspection-helpers.ts";

const ctx = setupTestApp();
// This file's app keeps its files in R2 (an S3-compatible bucket in memory) instead of local disk.
const s3 = new FakeS3();
ctx.store = new R2Store({ accountId: "acct", bucket: "aerowise-test", accessKeyId: "test-access-key", secretAccessKey: "secret", endpoint: "https://r2.test", fetch: s3.fetch });

describe("files in R2", () => {
  it("round-trips a technician's photo through the bucket, under the organization's prefix, served only by signed link", async () => {
    const s = await setup(ctx);
    const other = await setup(ctx, "Org B");
    const insp = (await s.techApi.put("/inspections/sync", payload(s))).json();
    const photo = (await s.techApi.putImage(photoUrl(insp.clientId, 1), JPEG, { "x-photo-key": "overview" })).json();

    const keys = [...s3.objects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^${s.org.id}/inspections/${insp.id}/`));
    expect(s3.objects.get(keys[0]!)!.body.equals(JPEG)).toBe(true);

    const res = await client(ctx.app).get(photo.url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.rawPayload.equals(JPEG)).toBe(true);

    // Another organization's signed-in user cannot read it by id.
    expect((await other.api.get(`/inspections/${insp.id}`)).statusCode).toBe(404);
    expect((await s.api.get(`/inspections/${insp.id}`)).statusCode).toBe(200);
  });
});
