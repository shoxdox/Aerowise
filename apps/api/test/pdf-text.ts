import { inflateSync } from "node:zlib";

/** Every stream in a PDF, inflated where it is compressed (including object streams). */
function streams(pdf: Buffer): string[] {
  const text = pdf.toString("latin1");
  const out: string[] = [];
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) continue;
    const raw = pdf.subarray(start, end);
    try {
      out.push(inflateSync(raw).toString("latin1"));
    } catch {
      out.push(raw.toString("latin1"));
    }
  }
  return out;
}

const hexToText = (hex: string) => String.fromCodePoint(...(hex.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16)));

/** A ToUnicode CMap: glyph code (hex) to text. Handles bfchar and both bfrange forms. */
function cmap(stream: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of stream.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, code, uni] of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(code!.toUpperCase(), hexToText(uni!));
  }
  for (const block of stream.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, rest] of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const from = parseInt(lo!, 16);
      const to = parseInt(hi!, 16);
      const width = lo!.length;
      const list = rest!.startsWith("[") ? [...rest!.matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]!) : null;
      for (let c = from; c <= to; c++) {
        const code = c.toString(16).toUpperCase().padStart(width, "0");
        if (list) {
          const u = list[c - from];
          if (u) map.set(code, hexToText(u));
        } else {
          const base = parseInt(rest!.slice(1, -1), 16);
          map.set(code, String.fromCodePoint(base + (c - from)));
        }
      }
    }
  }
  return map;
}

interface PdfObject {
  body: string;
  stream: string | null;
}

/** The PDF's top-level objects by number, with streams inflated. Object streams are not read. */
function objects(pdf: Buffer): Map<number, PdfObject> {
  const text = pdf.toString("latin1");
  const out = new Map<number, PdfObject>();
  for (const m of text.matchAll(/(\d+) 0 obj\b([\s\S]*?)endobj/g)) {
    const body = m[2]!;
    const at = /stream\r?\n/.exec(body);
    let stream: string | null = null;
    if (at) {
      const start = m.index! + m[0].indexOf(body) + at.index + at[0].length;
      const end = text.indexOf("endstream", start);
      const raw = pdf.subarray(start, end);
      try {
        stream = inflateSync(raw).toString("latin1");
      } catch {
        stream = raw.toString("latin1");
      }
    }
    out.set(Number(m[1]), { body: at ? body.slice(0, at.index) : body, stream });
  }
  return out;
}

/**
 * The text drawn in a PDF, decoded through each font's ToUnicode map: embedded fonts draw
 * glyph ids, not letters, so searching the raw content for a phrase finds nothing. Each
 * text object becomes one line. Enough for tests, not a general PDF reader.
 */
export function pdfText(pdf: Buffer): string {
  const objs = objects(pdf);
  // Font object number -> its ToUnicode map.
  const unicode = new Map<number, Map<string, string>>();
  for (const [num, o] of objs) {
    const ref = /\/ToUnicode\s+(\d+) 0 R/.exec(o.body);
    if (/\/Type\s*\/Font\b/.test(o.body) && ref) {
      const s = objs.get(Number(ref[1]))?.stream;
      if (s) unicode.set(num, cmap(s));
    }
  }
  // Resource name (F1, F-0-0…) -> font object number, from every page's font dictionary.
  const fontNames = new Map<string, number>();
  const addPairs = (dict: string) => {
    for (const [, name, num] of dict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+) 0 R/g)) fontNames.set(name!, Number(num));
  };
  for (const o of objs.values()) {
    for (const m of o.body.matchAll(/\/Font\s*<<([^>]*)>>/g)) addPairs(m[1]!);
    for (const m of o.body.matchAll(/\/Font\s+(\d+) 0 R/g)) addPairs(objs.get(Number(m[1]))?.body ?? "");
  }
  const lines: string[] = [];
  for (const o of objs.values()) {
    if (!o.stream || o.stream.includes("begincmap")) continue;
    let map: Map<string, string> | undefined;
    let line = "";
    for (const t of o.stream.matchAll(/\/([^\s/<>[\]()]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>|\b(BT|ET)\b/g)) {
      if (t[1]) map = unicode.get(fontNames.get(t[1]) ?? -1);
      else if (t[3]) {
        if (line) lines.push(line);
        line = "";
      } else if (t[2] !== undefined && map) line += (t[2].toUpperCase().match(/.{4}/g) ?? []).map((c) => map!.get(c) ?? "").join("");
    }
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

/** Each font a PDF uses, and whether its glyphs are embedded in the file. */
export function pdfFonts(pdf: Buffer): { name: string; embedded: boolean }[] {
  // Objects may sit in compressed object streams (pdf-lib), so look there too.
  const text = [pdf.toString("latin1"), ...streams(pdf)].join("\n");
  const names = [...new Set([...text.matchAll(/\/BaseFont\s*\/([^\s/<>[\]()]+)/g)].map((m) => m[1]!))];
  // A font is embedded when the descriptor naming it carries a font file.
  const embedded = new Set<string>();
  for (const m of text.matchAll(/\/FontName\s*\/([^\s/<>[\]()]+)/g)) {
    const open = text.lastIndexOf("<<", m.index);
    const close = text.indexOf(">>", m.index);
    if (/\/FontFile[23]?\b/.test(text.slice(open, close))) embedded.add(m[1]!);
  }
  return names.map((name) => ({ name, embedded: embedded.has(name) }));
}
