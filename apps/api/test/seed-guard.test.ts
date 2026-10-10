import { createPlatformAdmin, DEMO_ORG_NAME, DEMO_PLATFORM_ADMIN, seed } from "@aerowise/db";
import { describe, expect, it } from "vitest";
import { createOrg, setupTestApp } from "./helpers.ts";

const ctx = setupTestApp();

describe("the development seed", () => {
  it("refuses a database that already holds a real company, whatever NODE_ENV says", async () => {
    await createOrg(ctx.db, "Real Septic Co");
    await expect(seed(ctx.db)).rejects.toThrow(/already holds a company that is not a demo/);
    expect(await ctx.db.selectFrom("organizations").select("name").where("name", "=", DEMO_ORG_NAME).executeTakeFirst()).toBeUndefined();
    expect(await ctx.db.selectFrom("platformAdmins").selectAll().execute()).toEqual([]);
  });

  it("adds no admin with a published password beside one made with the CLI", async () => {
    await createPlatformAdmin(ctx.db, { name: "Founder", email: "founder@example.com", password: "a real password here" });
    const logged: string[] = [];
    await seed(ctx.db, (m) => logged.push(m));
    expect(logged).toContain("platform admins already exist; the development admin is not added");
    const admins = await ctx.db.selectFrom("platformAdmins").select("email").orderBy("email").execute();
    expect(admins.map((a) => a.email)).toEqual(["founder@example.com"]);
    expect(admins.some((a) => a.email === DEMO_PLATFORM_ADMIN.email)).toBe(false);
  }, 60_000);
});
