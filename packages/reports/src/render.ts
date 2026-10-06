import PDFDocument from "pdfkit";
import type { ReportSnapshot } from "./snapshot.ts";

const ACCENT = "#1f6f5c";
const MUTED = "#5d6b66";
const FAIL = "#b42318";
const EMBEDDABLE = new Set(["image/jpeg", "image/png"]);

const when = (iso: string, timezone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/**
 * Draws a report PDF from its snapshot. `images` holds photo bytes by storage key; only
 * JPEG and PNG can be embedded, others are listed by name.
 */
export function renderReport(s: ReportSnapshot, images: Map<string, Buffer> = new Map()): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "LETTER",
    margin: 54,
    bufferPages: true,
    info: { Title: `Inspection report — ${s.site.address}`, Author: s.provider.name, Subject: `${s.audience} copy`, CreationDate: new Date(s.generatedAt) },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const width = doc.page.width - 108;
  const left = 54;

  // Header, with the company logo at the top right when it has one.
  const logo = s.provider.logoKey ? images.get(s.provider.logoKey) : undefined;
  if (logo) {
    try {
      doc.image(logo, left + width - 120, 40, { fit: [120, 48], align: "right" });
    } catch {
      // An image pdfkit cannot read is left out rather than failing the report.
    }
  }
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(18).text(s.provider.name, left, 54, { width: logo ? width - 130 : width });
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(9)
    .text([s.provider.address, s.provider.phone, s.provider.emergencyPhone ? `Emergency ${s.provider.emergencyPhone}` : null, s.provider.email].filter(Boolean).join("  ·  "));
  doc.moveDown(0.8);
  doc.fillColor("#000").font("Helvetica-Bold").fontSize(14).text(s.layout?.title ?? "Aerobic System Maintenance Inspection");
  doc.font("Helvetica").fontSize(10).fillColor(MUTED).text(s.audience === "customer" ? "Customer copy" : "Copy for the permitting authority");
  if (s.correction) {
    doc.moveDown(0.4);
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(FAIL)
      .text(`Corrected report, version ${s.correction.version}. Replaces report ${s.correction.supersedesReportId}.`);
    doc.font("Helvetica").fontSize(9).fillColor("#000").text(`Reason: ${s.correction.reason}`);
    if (s.correction.amendedFields.length) doc.text(`Corrected answers: ${s.correction.amendedFields.join(", ")}`);
  }
  doc.moveDown(0.8);

  const pair = (label: string, value: string | null | undefined) => {
    if (!value) return;
    const y = doc.y;
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(label, left, y, { width: 120 });
    const labelBottom = doc.y;
    doc.font("Helvetica").fontSize(10).fillColor("#000").text(value, left + 125, y, { width: width - 125 });
    // A label that wraps (a long credential name) must not run into the next row.
    doc.y = Math.max(doc.y, labelBottom);
    doc.moveDown(0.2);
  };
  const heading = (title: string) => {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(11).fillColor(ACCENT).text(title, left, doc.y);
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor("#d9dfdc").lineWidth(0.5).stroke();
    doc.moveDown(0.5);
  };

  heading("Site");
  pair("Customer", s.customer.name);
  pair("Address", s.site.address);
  pair("County", s.site.county);
  pair("Permit number", s.site.permitNumber);
  if (s.system) {
    pair("System", [s.system.manufacturer, s.system.model].filter(Boolean).join(" ") || null);
    pair("Serial", s.system.serial);
    pair("Disposal", s.system.disposalType);
    pair(s.system.conflict ? "Chlorination on record" : "Chlorination", s.system.chlorinationMethod);
    if (s.system.conflict) {
      const y = doc.y;
      doc.font("Helvetica").fontSize(9).fillColor(MUTED).text("Record differs", left, y, { width: 120 });
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(FAIL).text(s.system.conflict, left + 125, y, { width: width - 125 });
      doc.fillColor("#000").moveDown(0.2);
    }
  }

  heading("Visit");
  pair("Technician", s.technician.name);
  if (s.technician.credentials?.length) {
    for (const c of s.technician.credentials) pair(c.label, c.number);
  } else {
    pair("License", s.technician.license);
  }
  if (s.responsibleProvider) pair("Responsible provider", `${s.responsibleProvider.name}, ${s.responsibleProvider.label} ${s.responsibleProvider.number}`);
  pair("Arrived", when(s.inspection.arrivedAt, s.timezone));
  pair("Completed", when(s.inspection.completedAt, s.timezone));
  if (s.inspection.previousCompletedAt !== undefined) {
    pair("Previous inspection", s.inspection.previousCompletedAt ? when(s.inspection.previousCompletedAt, s.timezone) : "None on record in Aerowise");
  }
  if (s.audience === "authority" && s.inspection.completionGps) {
    pair("Location", `${s.inspection.completionGps.lat.toFixed(5)}, ${s.inspection.completionGps.lng.toFixed(5)}`);
  }
  pair("Access problem", s.inspection.accessIssue);
  if (s.inspection.validationStatus === "overridden") pair("Accepted by office", s.inspection.overrideReason);

  for (const section of s.sections) {
    heading(section.title);
    for (const row of section.rows) {
      if (doc.y > doc.page.height - 80) doc.addPage();
      const y = doc.y;
      doc.font("Helvetica").fontSize(10).fillColor("#000").text(row.label, left, y, { width: width * 0.55 });
      const labelBottom = doc.y;
      doc.font(row.failed ? "Helvetica-Bold" : "Helvetica").fillColor(row.failed ? FAIL : "#000").text(row.value, left + width * 0.58, y, { width: width * 0.42 });
      doc.y = Math.max(labelBottom, doc.y);
      doc.moveDown(0.25);
    }
  }

  if (s.responses) {
    heading("Owner complaints and monitoring notices");
    if (s.responses.length === 0) {
      doc.font("Helvetica").fontSize(10).fillColor("#000").text("None recorded in Aerowise.", left, doc.y);
    }
    for (const r of s.responses) {
      if (doc.y > doc.page.height - 100) doc.addPage();
      const kind = r.classification === "owner_complaint" ? "Owner complaint" : "Monitoring notice";
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(`${kind}, received ${when(r.receivedAt, s.timezone)}${r.carriedOver ? " (from an earlier period, still open)" : ""}`, left, doc.y);
      doc.font("Helvetica").fontSize(10).text(r.description);
      if (r.responseAction && r.respondedAt) doc.text(`Response (${when(r.respondedAt, s.timezone)}): ${r.responseAction}`);
      const resolved = r.responseAction && r.outcome === "resolved";
      doc
        .font(resolved ? "Helvetica" : "Helvetica-Bold")
        .fillColor(resolved ? "#000" : FAIL)
        .text(resolved ? "Status: resolved" : r.responseAction ? "Status: outstanding (not yet resolved)" : `Status: outstanding, no response recorded as of ${when(s.inspection.completedAt, s.timezone)}`);
      doc.fillColor("#000").moveDown(0.3);
    }
  }

  if (s.issues.length) {
    heading(s.audience === "customer" ? "Findings and recommendations" : "Findings");
    for (const issue of s.issues) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(`${issue.type} (${issue.severity})`, left, doc.y);
      if (issue.description) doc.font("Helvetica").fontSize(10).text(issue.description);
      doc.moveDown(0.3);
    }
  }

  if (s.photos.length) {
    heading("Photos");
    const size = (width - 12) / 2;
    let col = 0;
    for (const photo of s.photos) {
      const data = images.get(photo.storageKey);
      if (!data || !EMBEDDABLE.has(photo.contentType)) {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`${photo.label} (photo on file)`, left, doc.y);
        continue;
      }
      if (col === 0 && doc.y + size + 20 > doc.page.height - 54) doc.addPage();
      const x = left + col * (size + 12);
      const y = doc.y;
      try {
        doc.image(data, x, y, { fit: [size, size * 0.75], align: "center" });
      } catch {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(`${photo.label} (photo on file)`, x, y);
      }
      doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(photo.label, x, y + size * 0.75 + 2, { width: size });
      if (col === 1) doc.y = y + size * 0.75 + 16;
      else doc.y = y;
      col = 1 - col;
    }
    if (col === 1) doc.y += size * 0.75 + 16;
  }

  if (s.signature) {
    const sig = s.signature;
    heading("Maintenance provider signature");
    doc.font("Helvetica").fontSize(9.5).fillColor("#000").text(sig.statement, left, doc.y, { width });
    doc.moveDown(0.6);
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.font("Helvetica-Oblique").fontSize(14).text(`/s/ ${sig.typedName}`, left, doc.y);
    doc.moveTo(left, doc.y + 2).lineTo(left + 260, doc.y + 2).strokeColor("#000").lineWidth(0.5).stroke();
    doc.moveDown(0.5);
    pair("Signed by", sig.name);
    pair(sig.licenseLabel, sig.licenseNumber);
    pair("Signed", when(sig.signedAt, s.timezone));
    pair("Report signed", `Version ${sig.reportVersion}; unsigned copy SHA-256 ${sig.reportSha256}`);
  }

  // Footer on every page: what this document is and how to identify it.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.height - 36;
    doc.page.margins.bottom = 0;
    doc
      .font("Helvetica")
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        `Report ${s.reportId} · ${s.template.name} v${s.template.version}${s.layout ? ` · ${s.layout.jurisdictionKey} layout v${s.layout.rulesetVersion}` : ""} · generated ${when(s.generatedAt, s.timezone)} · page ${i - range.start + 1} of ${range.count}`,
        left,
        bottom,
        { width, align: "center", lineBreak: false },
      );
  }

  doc.end();
  return finished;
}
