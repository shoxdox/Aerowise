import fontkit from "@pdf-lib/fontkit";
import { degrees, PDFDocument, rgb } from "pdf-lib";
import { fontBytes, FONTS } from "./fonts.ts";

export const DEMO_WATERMARK = "DEMO - FICTIONAL DATA - NOT FILED";

/**
 * Stamps every page of a demo company's PDF as fictional when it is downloaded: a faint
 * diagonal mark across the page and a line along the bottom. The stored file (and its hash)
 * is left as made; only the copy handed out carries the mark.
 */
export async function watermarkPdf(pdf: Uint8Array, text: string = DEMO_WATERMARK): Promise<Buffer> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  // Embedded (not standard Helvetica) so every viewer spaces the mark evenly.
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes(FONTS.bold), { subset: true });
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.min(width, height) / 14;
    const w = font.widthOfTextAtSize(text, size);
    // Centered on the page's diagonal.
    const angle = Math.atan2(height, width);
    page.drawText(text, {
      x: width / 2 - (w / 2) * Math.cos(angle) + (size / 2) * Math.sin(angle),
      y: height / 2 - (w / 2) * Math.sin(angle) - (size / 2) * Math.cos(angle),
      size,
      font,
      color: rgb(0.85, 0.1, 0.1),
      opacity: 0.18,
      rotate: degrees((angle * 180) / Math.PI),
    });
    page.drawText(text, { x: 24, y: 10, size: 8, font, color: rgb(0.85, 0.1, 0.1) });
  }
  // Without object streams, so every object (fonts included) stays readable at the top level.
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
