import { readdirSync, readFileSync } from "node:fs";
import { CALL_SHEET_SHARED_QUESTION, DEMO_WATERMARK, renderCallSheet, renderCoverSheet, renderReport, watermarkPdf, type ReportSnapshot } from "@aerowise/reports";
import { describe, expect, it } from "vitest";
import { pdfFonts, pdfText } from "./pdf-text.ts";

// STG-09: PDFs used the 14 standard fonts, which are never embedded, so a viewer without
// Helvetica drew a substitute at Helvetica's widths and the letters landed unevenly.

const snapshot: ReportSnapshot = {
  audience: "customer",
  reportId: "10f09c74-fd30-4b00-9d2d-720ca68aa68c",
  generatedAt: "2026-10-05T23:25:00Z",
  timezone: "America/Chicago",
  provider: { name: "Hill Country Aerobic Services (your demo)", phone: "(512) 555-0100", email: "office@example.com", address: "100 Example Pkwy, Dripping Springs, TX 78620" },
  customer: { name: "Maria Salinas" },
  site: { address: "3449 Cedar Ridge Rd, Blanco, TX 78606", county: "Example County", permitNumber: "DEMO-010066" },
  system: { manufacturer: "Acme Aerobic", model: "AA-750", serial: "SN215136", disposalType: "drip", chlorinationMethod: "tablet" },
  technician: { name: "Tess Tech", license: "MT-DEMO-0001" },
  inspection: {
    id: "8a0b5a43-2a8e-4c51-9a0d-2b1f8f0d1c11",
    arrivedAt: "2026-10-05T19:00:00Z",
    completedAt: "2026-10-05T19:40:00Z",
    arrivalGps: null,
    completionGps: null,
    validationStatus: "valid",
    overrideReason: null,
    accessIssue: null,
  },
  template: { id: "aerobic", name: "Aerobic maintenance inspection", version: 2 },
  sections: [
    {
      title: "Aeration",
      rows: [
        { label: "Aerator", value: "Pass", failed: false },
        { label: "Air pressure", value: "4.5 psi", failed: false },
        { label: "Diffuser", value: "Fail", failed: true },
      ],
    },
  ],
  issues: [],
  photos: [],
};

const callSheet = {
  authorityName: "Fixture County (fictional)",
  key: "tx-fixture-draft",
  statusLabel: "Draft",
  verified: false,
  version: 1,
  versionInForce: 1,
  sourcesCheckedOn: "2026-01-10",
  requirementEffective: { date: "2020-01-01", basis: "FICTIONAL order" },
  sources: [{ title: "FICTIONAL fixture source", url: "https://tx-fixture-draft.example/rules", retrievedOn: "2026-01-10" }],
  open: [{ text: "FICTIONAL: whether the authority accepts reports by email", state: "Open", evidence: [] }],
  acceptance: [{ text: "Report format", state: "Published rule only", evidence: ["2026-01-10, Published rule (published rule or form): Answers part of it. The form lists email."] }],
  sharedQuestion: CALL_SHEET_SHARED_QUESTION,
  generatedOn: "2026-10-07",
  generatedAt: "2026-10-07T02:00:00Z",
  preparedBy: "Test Admin",
};

const STANDARD = /^(Helvetica|Times|Courier|Symbol|ZapfDingbats)/;

describe("generated PDFs", () => {
  it("embed every font they use, so spacing is the same in every viewer", async () => {
    const pdfs = {
      report: await renderReport(snapshot),
      coverSheet: await renderCoverSheet({ title: "Cover sheet", formReference: "FICTIONAL form", fields: [{ label: "Permit", value: null, required: true }], instructions: null, packageReference: "pkg", generatedAt: "2026-10-05T23:25:00Z" }),
      callSheet: await renderCallSheet(callSheet),
      watermarked: await watermarkPdf(await renderReport(snapshot)),
    };
    for (const [name, pdf] of Object.entries(pdfs)) {
      const fonts = pdfFonts(pdf);
      expect(fonts.length, name).toBeGreaterThan(0);
      expect(fonts.filter((f) => STANDARD.test(f.name.replace(/^[A-Z]{6}\+/, ""))), name).toEqual([]);
      expect(fonts.filter((f) => !f.embedded), name).toEqual([]);
    }
    // The text still reads back as written.
    expect(pdfText(pdfs.report)).toContain("Hill Country Aerobic Services (your demo)");
    expect(pdfText(pdfs.watermarked)).toContain(DEMO_WATERMARK);
  });

  it("draw the same report the same way twice", async () => {
    expect((await renderReport(snapshot)).equals(await renderReport(snapshot))).toBe(true);
  });

  it("never name a standard font in the PDF builders", () => {
    const dir = new URL("../../../packages/reports/src/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "fonts.ts")) {
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(/"(Helvetica|Times|Courier)[^"]*"|StandardFonts/);
    }
  });
});
