import { planMigrations } from "@aerowise/db";
import { describe, expect, it } from "vitest";

const f = (name: string, sha256 = `sha-${name}`) => ({ name, sha256 });

describe("migration plan", () => {
  it("applies new files in order and records checksums for files applied before they were kept", () => {
    const plan = planMigrations([f("0002_b.sql"), f("0001_a.sql"), f("0003_c.sql")], [{ name: "0001_a.sql", checksum: null }]);
    expect(plan.apply).toEqual(["0002_b.sql", "0003_c.sql"]);
    expect(plan.backfill).toEqual([f("0001_a.sql")]);
  });

  it("refuses an applied file that was edited, or that is gone", () => {
    expect(() => planMigrations([f("0001_a.sql", "changed")], [{ name: "0001_a.sql", checksum: "sha-0001_a.sql" }])).toThrow(/changed after it was applied/);
    expect(() => planMigrations([], [{ name: "0001_a.sql", checksum: "sha-0001_a.sql" }])).toThrow(/file is missing/);
  });

  it("refuses two files that share a number, except the numbers shared before the check existed", () => {
    // 0028 and 0030 were shared by the files already applied everywhere; a fresh database applies them all.
    expect(planMigrations([f("0028_a.sql"), f("0028_b.sql"), f("0030_c.sql")], []).apply).toEqual(["0028_a.sql", "0028_b.sql", "0030_c.sql"]);
    expect(() => planMigrations([f("0061_x.sql"), f("0061_y.sql")], [])).toThrow(/share the number 0061/);
    expect(() => planMigrations([f("0061_x.sql"), f("0061_y.sql")], [{ name: "0061_x.sql", checksum: "sha-0061_x.sql" }])).toThrow(/share the number 0061/);
  });
});
