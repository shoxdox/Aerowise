import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { MAX_IMPORT_ROWS } from "@aerowise/domain";
import { HttpError, unprocessable } from "./errors.ts";

export interface ParsedSheet {
  /** The worksheet's name, or "Sheet 1" for a CSV file. */
  name: string;
  headers: string[];
  /** Data rows with their row number in the file (the header is row 1 when it is first). */
  rows: { rowNo: number; raw: string[] }[];
}

const CSV_SHEET = "Sheet 1";
const isBlank = (cells: string[]) => cells.every((c) => c.trim() === "");

function finish(name: string, lines: { rowNo: number; cells: string[] }[]): ParsedSheet {
  const data = lines.filter((l) => !isBlank(l.cells));
  const [header, ...rows] = data;
  if (!header) throw unprocessable("The file has no rows");
  if (rows.length === 0) throw unprocessable("The file has a header row but no data");
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(422, "too_many_rows", `${name === CSV_SHEET ? "The file" : `Sheet "${name}"`} has ${rows.length} rows; split it into files of at most ${MAX_IMPORT_ROWS}`);
  const width = Math.max(header.cells.length, ...rows.map((r) => r.cells.length));
  const pad = (cells: string[]) => Array.from({ length: width }, (_, i) => (cells[i] ?? "").trim());
  return {
    name,
    headers: pad(header.cells).map((h, i) => h || `Column ${i + 1}`),
    rows: rows.map((r) => ({ rowNo: r.rowNo, raw: pad(r.cells) })),
  };
}

function parseCsv(bytes: Buffer): ParsedSheet[] {
  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parse(bytes, {
      bom: true,
      info: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
      delimiter: [",", ";", "\t"],
    }) as unknown as typeof records;
  } catch (err) {
    throw unprocessable(`The file could not be read as CSV: ${(err as Error).message}`);
  }
  return [finish(CSV_SHEET, records.map((r) => ({ rowNo: r.info.lines, cells: r.record })))];
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((t) => t.text).join("");
    if ("text" in value) return String(value.text);
    if ("result" in value) return cellText(value.result as ExcelJS.CellValue);
    if ("error" in value) return "";
  }
  return String(value);
}

async function parseXlsx(bytes: Buffer): Promise<ParsedSheet[]> {
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch (err) {
    throw unprocessable(`The file could not be read as an Excel workbook: ${(err as Error).message}`);
  }
  const sheets: ParsedSheet[] = [];
  let firstProblem: HttpError | null = null;
  for (const ws of book.worksheets) {
    if (ws.actualRowCount === 0) continue;
    const lines: { rowNo: number; cells: string[] }[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      // row.values is 1-based.
      (row.values as ExcelJS.CellValue[]).forEach((v, i) => {
        if (i > 0) cells[i - 1] = cellText(v);
      });
      lines.push({ rowNo: row.number, cells: Array.from(cells, (c) => c ?? "") });
    });
    try {
      sheets.push(finish(ws.name, lines));
    } catch (err) {
      // A sheet with only a title or a header (instructions, an empty template) is skipped;
      // a sheet that is too long is not, so the limit cannot be dodged.
      if (!(err instanceof HttpError) || err.code === "too_many_rows") throw err;
      firstProblem ??= err;
    }
  }
  if (sheets.length === 0) throw firstProblem ?? unprocessable("The workbook has no rows");
  return sheets;
}

/**
 * Reads every sheet of an .xlsx file that has a header and data, or a comma, semicolon or
 * tab separated file as one sheet.
 */
export async function parseSpreadsheet(filename: string, bytes: Buffer): Promise<ParsedSheet[]> {
  const zip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (/\.xls$/i.test(filename)) throw unprocessable("Old .xls files are not supported; save the sheet as .xlsx or CSV");
  if (zip || /\.xlsx$/i.test(filename)) return parseXlsx(bytes);
  return parseCsv(bytes);
}
