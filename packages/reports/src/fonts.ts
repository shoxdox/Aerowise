import { readFileSync } from "node:fs";

/**
 * Fonts embedded in every PDF Aerowise makes. The 14 standard PDF fonts (Helvetica, Times)
 * are not embedded, so a viewer without them draws a substitute at Helvetica's widths and
 * the letters land unevenly (STG-09). Liberation Sans and Serif are metric-compatible with
 * Helvetica and Times, so layouts are unchanged; they are under the SIL Open Font License
 * (fonts/LICENSE-OFL.txt). Only the glyphs used go into each file.
 */
export const FONTS = {
  regular: "Sans",
  bold: "Sans-Bold",
  italic: "Sans-Italic",
  /** A typed signature's script-like face. */
  signature: "Serif-Italic",
} as const;

const FILES: Record<(typeof FONTS)[keyof typeof FONTS], string> = {
  Sans: "LiberationSans-Regular.ttf",
  "Sans-Bold": "LiberationSans-Bold.ttf",
  "Sans-Italic": "LiberationSans-Italic.ttf",
  "Serif-Italic": "LiberationSerif-Italic.ttf",
};

const cache = new Map<string, Buffer>();

/** The bytes of one embedded font, read once. */
export function fontBytes(name: keyof typeof FILES): Buffer {
  let bytes = cache.get(name);
  if (!bytes) {
    bytes = readFileSync(new URL(`../fonts/${FILES[name]}`, import.meta.url));
    cache.set(name, bytes);
  }
  return bytes;
}

/** pdfkit options that make the embedded regular face the default, so no standard font is ever used. */
export const pdfkitFont = () => ({ font: fontBytes(FONTS.regular) as unknown as string });

/** Registers the embedded fonts on a pdfkit document under the names in FONTS. */
export function registerFonts(doc: PDFKit.PDFDocument): PDFKit.PDFDocument {
  for (const name of Object.keys(FILES) as (keyof typeof FILES)[]) doc.registerFont(name, fontBytes(name));
  return doc.font(FONTS.regular);
}
