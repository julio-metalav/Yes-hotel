import ExcelJS from "exceljs";
import { OMIE_AR_AP_SHEET_PREFIX } from "./ar-ap-types.ts";

export type OmieCellValue = string | number | Date | null;

export function excelCellValue(cell: ExcelJS.Cell): OmieCellValue {
  const v = cell.value;
  if (v == null || v === "") return null;
  if (typeof v === "number" || typeof v === "string" || v instanceof Date) return v;
  if (typeof v === "object" && v && "result" in v) {
    const r = (v as ExcelJS.CellFormulaValue).result;
    if (r == null) return null;
    if (typeof r === "number" || typeof r === "string" || r instanceof Date) return r;
    return null;
  }
  if (typeof v === "object" && v && "richText" in v) {
    return (v as ExcelJS.CellRichTextValue).richText.map((p) => p.text).join("");
  }
  if (typeof v === "object" && v && "text" in v) {
    return String((v as ExcelJS.CellHyperlinkValue).text ?? "");
  }
  return null;
}

export async function loadOmieWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(bytes));
  return wb;
}

export function findOmieArApSheet(wb: ExcelJS.Workbook): ExcelJS.Worksheet | null {
  return (
    wb.worksheets.find((ws) => ws.name.startsWith(OMIE_AR_AP_SHEET_PREFIX)) ??
    wb.worksheets[0] ??
    null
  );
}

export function sheetCell(ws: ExcelJS.Worksheet, row: number, col: number): OmieCellValue {
  return excelCellValue(ws.getRow(row).getCell(col));
}

export function sheetText(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = sheetCell(ws, row, col);
  return typeof v === "string" ? v.trim() : "";
}
