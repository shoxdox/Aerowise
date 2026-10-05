import { describe, expect, it } from "vitest";
import { addressKey, analyzeImport, applySavedColumns, detectColumns, headerKey, mappingScore, normalizeDate, normalizePhone, savedColumns, summarize } from "./imports.ts";

describe("detectColumns", () => {
  it("matches common headers whatever their spelling", () => {
    const headers = ["Client Name", "Service Address", "City", "Zip", "Permit #", "Cell Phone", "E-mail", "Make", "S/N", "Start Date", "Expiration Date", "Last Service"];
    expect(detectColumns(headers, [])).toEqual({
      customerName: 0,
      addressLine1: 1,
      city: 2,
      postalCode: 3,
      permitNumber: 4,
      phone: 5,
      email: 6,
      manufacturer: 7,
      serial: 8,
      contractStart: 9,
      contractEnd: 10,
      lastInspection: 11,
    });
  });

  it("uses first and last name only when there is no full name column", () => {
    expect(detectColumns(["First Name", "Last Name", "Address", "Town"], [])).toMatchObject({ firstName: 0, lastName: 1, addressLine1: 2, city: 3 });
    expect(detectColumns(["Name", "First", "Last"], [])).toEqual({ customerName: 0 });
  });

  it("recognizes unlabeled email, phone and ZIP columns by their values", () => {
    const sample = [
      ["a@x.com", "512-555-0100", "78701", "x"],
      ["b@y.org", "(512) 555 0101", "78702", "y"],
      ["c@z.net", "5125550102", "78703", "z"],
    ];
    expect(detectColumns(["Col A", "Col B", "Col C", "Col D"], sample)).toEqual({ email: 0, phone: 1, postalCode: 2 });
  });
});

describe("normalizers", () => {
  it("formats US phone numbers and rejects the rest", () => {
    expect(normalizePhone("+1 512.555.0100")).toBe("(512) 555-0100");
    expect(normalizePhone("555-0100")).toBeNull();
  });

  it("reads ISO and US dates and rejects impossible ones", () => {
    expect(normalizeDate("2026-03-01")).toBe("2026-03-01");
    expect(normalizeDate("3/1/26")).toBe("2026-03-01");
    expect(normalizeDate("2/30/2026")).toBeNull();
    expect(normalizeDate("next week")).toBeNull();
  });

  it("matches the same address however it was typed", () => {
    expect(addressKey("12 Oak Road", "Austin")).toBe(addressKey("12 oak rd.", " AUSTIN "));
  });
});

describe("analyzeImport", () => {
  const mapping = { customerName: 0, phone: 1, addressLine1: 2, city: 3, permitNumber: 4, planName: 5, contractStart: 6 };
  const existing = {
    customers: [{ id: "c1", displayName: "Ann Lee", phones: ["(512) 555-0100"], emails: [] }],
    sites: [{ id: "s1", addressLine1: "1 Main St", city: "Austin", permitNumber: "P-9" }],
    plans: [{ name: "Annual Aerobic", termMonths: 12, visitsPerTerm: 3 }],
    today: "2026-03-01",
  };
  const rows = (raws: string[][]) => raws.map((raw, i) => ({ rowNo: i + 2, raw, include: null }));

  it("flags errors, duplicates and warnings, and groups a customer's sites", () => {
    const out = analyzeImport(
      rows([
        ["Ann Lee", "512-555-0100", "9 Elm Rd", "Austin", "", "annual aerobic", "2026-04-01"],
        ["Bo Diaz", "512-555-0111", "1 Main Street", "Austin", "", "", ""],
        ["Cy Moss", "", "", "Austin", "", "", ""],
        ["Di Fox", "512-555-0122", "5 Pine Ln", "Austin", "P-1", "", ""],
        ["Di Fox", "512-555-0122", "5 Pine Lane", "Austin", "", "", ""],
        ["Di Fox", "512-555-0122", "6 Pine Ln", "Austin", "p-9", "", ""],
        ["Ed Ray", "12345", "7 Oak Dr", "Austin", "", "Gold", ""],
      ]),
      mapping,
      existing,
    );
    expect(out.map((r) => r.status)).toEqual(["ready", "duplicate", "error", "ready", "duplicate", "duplicate", "warning"]);
    expect(out[0]).toMatchObject({ existingCustomer: { id: "c1" }, record: { planName: "Annual Aerobic", contractStart: "2026-04-01" } });
    expect(out[1]!.duplicateOf).toMatchObject({ kind: "site", siteId: "s1" });
    expect(out[2]!.messages).toEqual(["No service address"]);
    expect(out[4]!.duplicateOf).toMatchObject({ kind: "row", rowNo: 5 });
    expect(out[5]!.duplicateOf).toMatchObject({ kind: "site", siteId: "s1" });
    expect(out[5]!.customerKey).toBe(out[3]!.customerKey);
    expect(out[6]!.messages).toEqual(['Phone "12345" is not a 10-digit US number and was left out', 'No active plan named "Gold"; no contract will be created']);
    expect(summarize(out)).toEqual({ rows: 7, ready: 2, warning: 1, duplicate: 3, error: 1, included: 3 });
  });

  it("settles contract dates from the plan and reads the last inspection", () => {
    const m = { customerName: 0, addressLine1: 1, city: 2, planName: 3, contractStart: 4, contractEnd: 5, lastInspection: 6 };
    const out = analyzeImport(
      rows([
        // Only an end date: the start is worked out from the 12-month term.
        ["A", "1 A St", "Austin", "Annual Aerobic", "", "3/20/2026", "2025-12-01"],
        // Both dates disagree with the term: the end wins.
        ["B", "2 B St", "Austin", "Annual Aerobic", "2025-06-01", "2026-09-30", "2026-01-15"],
        // Started long ago with no last inspection.
        ["C", "3 C St", "Austin", "Annual Aerobic", "2025-06-01", "", ""],
        // Already ended.
        ["D", "4 D St", "Austin", "Annual Aerobic", "", "2026-01-31", ""],
        // A last inspection with no contract, and one in the future.
        ["E", "5 E St", "Austin", "", "", "", "2026-01-01"],
        ["F", "6 F St", "Austin", "Annual Aerobic", "2026-02-01", "", "2026-04-01"],
        ["G", "7 G St", "Austin", "Annual Aerobic", "", "soon", ""],
      ]),
      m,
      existing,
    );
    expect(out[0]).toMatchObject({ status: "ready", record: { contractStart: "2025-03-21", contractEnd: "2026-03-20", lastInspection: "2025-12-01" } });
    expect(out[1]!.record).toMatchObject({ contractStart: "2025-10-01", contractEnd: "2026-09-30" });
    expect(out[1]!.messages).toEqual(["Contract start 2025-06-01 does not fit a 12-month plan ending 2026-09-30; the contract starts 2025-10-01"]);
    expect(out[2]!.record).toMatchObject({ contractStart: "2025-06-01", contractEnd: "2026-05-31" });
    // Notes about today's date leave the row ready.
    expect(out[2]).toMatchObject({ status: "ready", messages: [], notes: ["No last inspection date; visits due since the contract started will show as overdue"] });
    expect(out[3]).toMatchObject({ status: "ready" });
    expect(out[3]!.notes).toEqual(["Contract ended on 2026-01-31; it is imported for renewal and its visits are not scheduled"]);
    expect(out[4]!.messages).toEqual(["Last inspection is only used with a contract; no visits are scheduled from it"]);
    expect(out[5]!.record.lastInspection).toBeNull();
    expect(out[5]!.messages).toEqual(["Last inspection 2026-04-01 is in the future and was left out"]);
    expect(out[6]!.messages).toEqual(['Contract end "soon" is not a date', "No contract start or end date; no contract will be created"]);
  });

  it("lets the user include a duplicate but never an error", () => {
    const out = analyzeImport(
      [
        { rowNo: 2, raw: ["Bo", "", "1 Main St", "Austin"], include: true },
        { rowNo: 3, raw: ["", "", "2 Main St", "Austin"], include: true },
      ],
      mapping,
      existing,
    );
    expect(out.map((r) => [r.status, r.include])).toEqual([["duplicate", true], ["error", false]]);
  });
});

describe("saved column choices", () => {
  const headers = ["Owner", "Where", "Town", "Other"];
  const saved = savedColumns(headers, { customerName: 0, addressLine1: 1, city: 2 });

  it("are kept by header name", () => {
    expect(saved).toEqual([
      { field: "customerName", header: "Owner" },
      { field: "addressLine1", header: "Where" },
      { field: "city", header: "Town" },
    ]);
    expect(headerKey(["Owner", " where ", "TOWN", "Other"])).toBe(headerKey(headers));
    expect(headerKey(["Where", "Owner", "Town", "Other"])).not.toBe(headerKey(headers));
  });

  it("replace detection for the same layout, fields left out included", () => {
    expect(applySavedColumns(headers, { customerName: 0, city: 2, accessNotes: 3 }, saved, true)).toEqual({ customerName: 0, addressLine1: 1, city: 2 });
  });

  it("win over detection for another layout and leave the rest to it", () => {
    const other = ["Where", "Notes", "Owner", "City"];
    const detected = { accessNotes: 1, customerName: 2, city: 3 };
    expect(applySavedColumns(other, detected, saved, false)).toEqual({ addressLine1: 0, accessNotes: 1, customerName: 2, city: 3 });
    // A saved header that is now a different field's column takes that column over.
    expect(applySavedColumns(["Town", "Owner"], { city: 0, customerName: 1 }, [{ field: "county", header: "Town" }], false)).toEqual({ county: 0, customerName: 1 });
  });

  it("do not mix a full name with first and last names", () => {
    const split = [
      { field: "firstName", header: "First" },
      { field: "lastName", header: "Last" },
    ] as const;
    expect(applySavedColumns(["Account", "First", "Last"], { customerName: 0 }, [...split], false)).toEqual({ firstName: 1, lastName: 2 });
    expect(applySavedColumns(["Name", "First"], { firstName: 1 }, [{ field: "customerName", header: "Name" }], false)).toEqual({ customerName: 0 });
  });

  it("pick the sheet that looks like a customer list", () => {
    expect(mappingScore({ customerName: 0, addressLine1: 1, city: 2 })).toBe(3);
    expect(mappingScore({ firstName: 0, city: 2 })).toBe(2);
    expect(mappingScore({ accessNotes: 0 })).toBe(0);
  });
});
