import type ExcelJS from "exceljs";
import { parseOmieDate } from "./dates.ts";
import { parseOmieAmountToSignedCents, zeroOmieMoney, type OmieMoneyOk } from "./money.ts";
import { findOmieArApSheet, loadOmieWorkbook, sheetCell, sheetText } from "./workbook.ts";
import {
  OMIE_AR_AP_HEADERS,
  type OmieArApFact,
  type OmieArApIgnored,
  type OmieArApMoney,
  type OmieArApRowError,
  type OmieArApRowKind,
  type OmieArApSide,
  type OmieArApWorkbookTotals,
} from "./ar-ap-types.ts";

const NAME_MAX = 200;

export type OmieArApParseOk = {
  ok: true;
  sheet: string;
  physicalRows: number;
  facts: OmieArApFact[];
  ignored: OmieArApIgnored[];
  errors: OmieArApRowError[];
  workbookTotals: OmieArApWorkbookTotals | null;
};

export type OmieArApParseFatal = {
  ok: false;
  reason: "malformed_workbook" | "incompatible_headers" | "empty_workbook";
  message: string;
};

export type OmieArApParseResult = OmieArApParseOk | OmieArApParseFatal;

function moneyOrZero(raw: unknown): { ok: true; money: OmieMoneyOk } | { ok: false; reason: string } {
  if (raw == null || raw === "") return { ok: true, money: zeroOmieMoney() };
  const parsed = parseOmieAmountToSignedCents(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, money: parsed };
}

function sideHasValues(gross: unknown, tax: unknown, settled: unknown, open: unknown): boolean {
  return [gross, tax, settled, open].some((v) => v != null && v !== "");
}

function classifyRow(ws: ExcelJS.Worksheet, row: number): OmieArApRowKind {
  const a = sheetText(ws, row, 1);
  const b = sheetText(ws, row, 2);
  const c = sheetText(ws, row, 3);
  if (row === 1) return "title";
  if (row === 2 || row === 3) return "section";
  if (row === 4 || a === OMIE_AR_AP_HEADERS.person) return "header";
  if (/^total(\s+geral)?$/i.test(a)) return "total";
  const hasName = Boolean(a);
  const hasDate = Boolean(b);
  const hasAmount = [3, 4, 5, 6, 7, 8, 9, 10].some((col) => sheetCell(ws, row, col) != null);
  if (!hasName && !hasDate && !hasAmount && !c) return "empty";
  if (hasDate || hasAmount) return "data";
  return "unknown";
}

function headersMatch(ws: ExcelJS.Worksheet): boolean {
  return (
    sheetText(ws, 3, 3) === OMIE_AR_AP_HEADERS.arGroup &&
    sheetText(ws, 3, 7) === OMIE_AR_AP_HEADERS.apGroup &&
    sheetText(ws, 4, 1) === OMIE_AR_AP_HEADERS.person &&
    sheetText(ws, 4, 2) === OMIE_AR_AP_HEADERS.settlementDate &&
    sheetText(ws, 4, 3) === OMIE_AR_AP_HEADERS.arGross &&
    sheetText(ws, 4, 4) === OMIE_AR_AP_HEADERS.arTax &&
    sheetText(ws, 4, 5) === OMIE_AR_AP_HEADERS.arSettled &&
    sheetText(ws, 4, 6) === OMIE_AR_AP_HEADERS.arOpen &&
    sheetText(ws, 4, 7) === OMIE_AR_AP_HEADERS.apGross &&
    sheetText(ws, 4, 8) === OMIE_AR_AP_HEADERS.apTax &&
    sheetText(ws, 4, 9) === OMIE_AR_AP_HEADERS.apSettled &&
    sheetText(ws, 4, 10) === OMIE_AR_AP_HEADERS.apOpen
  );
}

function excerpt(message: string): string {
  return message.replace(/\d{5,}/g, "***").slice(0, 120);
}

function addError(errors: OmieArApRowError[], row: number, code: OmieArApRowError["code"], message: string) {
  errors.push({ row_number: row, code, message, raw_excerpt: excerpt(message) });
}

function buildFact(input: {
  physicalRow: number;
  side: OmieArApSide;
  personName: string;
  settlementDate: string;
  gross: OmieArApMoney;
  tax: OmieArApMoney;
  settled: OmieArApMoney;
  open: OmieArApMoney;
}): OmieArApFact {
  return {
    physicalRow: input.physicalRow,
    sourceRow: input.physicalRow * 10 + (input.side === "ar" ? 1 : 2),
    side: input.side,
    personName: input.personName,
    settlementDate: input.settlementDate,
    gross: input.gross,
    tax: input.tax,
    settled: input.settled,
    open: input.open,
  };
}

function parseSideMoney(
  errors: OmieArApRowError[],
  row: number,
  side: OmieArApSide,
  cells: { gross: unknown; tax: unknown; settled: unknown; open: unknown },
): { ok: true; gross: OmieMoneyOk; tax: OmieMoneyOk; settled: OmieMoneyOk; open: OmieMoneyOk } | { ok: false } {
  const gross = moneyOrZero(cells.gross);
  const tax = moneyOrZero(cells.tax);
  const settled = moneyOrZero(cells.settled);
  const open = moneyOrZero(cells.open);
  if (!gross.ok || !tax.ok || !settled.ok || !open.ok) {
    addError(errors, row, "invalid_amount", `valor ${side} inválido`);
    return { ok: false };
  }
  const expectedSign = side === "ar" ? 1 : -1;
  for (const part of [gross.money, tax.money, settled.money, open.money]) {
    if (part.signedCents !== 0 && Math.sign(part.signedCents) !== expectedSign) {
      addError(errors, row, "inconsistent_entry_type", `sinal ${side} incompatível com o bloco`);
      return { ok: false };
    }
  }
  return { ok: true, gross: gross.money, tax: tax.money, settled: settled.money, open: open.money };
}

function parseTotalMoney(raw: unknown): number | null {
  const parsed = parseOmieAmountToSignedCents(raw);
  return parsed.ok ? parsed.absCents : null;
}

export async function parseOmieArApWorkbook(bytes: Uint8Array): Promise<OmieArApParseResult> {
  let wb: ExcelJS.Workbook;
  try {
    wb = await loadOmieWorkbook(bytes);
  } catch {
    return { ok: false, reason: "malformed_workbook", message: "não foi possível ler o XLSX" };
  }
  const ws = findOmieArApSheet(wb);
  if (!ws || ws.rowCount < 5) {
    return { ok: false, reason: "empty_workbook", message: "planilha Omie AR/AP ausente ou vazia" };
  }
  if (!headersMatch(ws)) {
    return { ok: false, reason: "incompatible_headers", message: "cabeçalhos do pivot 4 não conferem com o contrato observado" };
  }

  const facts: OmieArApFact[] = [];
  const ignored: OmieArApIgnored[] = [];
  const errors: OmieArApRowError[] = [];
  let lastName = "";
  let workbookTotals: OmieArApWorkbookTotals | null = null;

  for (let r = 1; r <= ws.rowCount; r++) {
    const kind = classifyRow(ws, r);
    if (kind === "title" || kind === "section" || kind === "header" || kind === "empty") {
      ignored.push({ physicalRow: r, kind, reason: kind });
      continue;
    }
    if (kind === "total") {
      ignored.push({ physicalRow: r, kind, reason: "total_geral" });
      workbookTotals = {
        ar_gross_cents: parseTotalMoney(sheetCell(ws, r, 3)),
        ar_tax_cents: parseTotalMoney(sheetCell(ws, r, 4)),
        ar_settled_cents: parseTotalMoney(sheetCell(ws, r, 5)),
        ar_open_cents: parseTotalMoney(sheetCell(ws, r, 6)),
        ap_gross_cents: parseTotalMoney(sheetCell(ws, r, 7)),
        ap_tax_cents: parseTotalMoney(sheetCell(ws, r, 8)),
        ap_settled_cents: parseTotalMoney(sheetCell(ws, r, 9)),
        ap_open_cents: parseTotalMoney(sheetCell(ws, r, 10)),
      };
      continue;
    }
    if (kind !== "data") {
      addError(errors, r, "unsupported_row_shape", "linha fora do contrato pivot 4");
      continue;
    }

    const rawName = sheetText(ws, r, 1);
    if (rawName) lastName = rawName.slice(0, NAME_MAX);
    if (!lastName) {
      addError(errors, r, "missing_required_field", "cliente/fornecedor ausente");
      continue;
    }

    const date = parseOmieDate(sheetCell(ws, r, 2));
    if (!date.ok) {
      addError(errors, r, "invalid_date", "data de pagto/recbto inválida ou ausente");
      continue;
    }

    const arPresent = sideHasValues(sheetCell(ws, r, 3), sheetCell(ws, r, 4), sheetCell(ws, r, 5), sheetCell(ws, r, 6));
    const apPresent = sideHasValues(sheetCell(ws, r, 7), sheetCell(ws, r, 8), sheetCell(ws, r, 9), sheetCell(ws, r, 10));
    if (!arPresent && !apPresent) {
      addError(errors, r, "malformed_row", "linha sem valores AR nem AP");
      continue;
    }

    if (arPresent) {
      const money = parseSideMoney(errors, r, "ar", {
        gross: sheetCell(ws, r, 3),
        tax: sheetCell(ws, r, 4),
        settled: sheetCell(ws, r, 5),
        open: sheetCell(ws, r, 6),
      });
      if (money.ok) {
        facts.push(
          buildFact({
            physicalRow: r,
            side: "ar",
            personName: lastName,
            settlementDate: date.date,
            gross: money.gross,
            tax: money.tax,
            settled: money.settled,
            open: money.open,
          }),
        );
      }
    }
    if (apPresent) {
      const money = parseSideMoney(errors, r, "ap", {
        gross: sheetCell(ws, r, 7),
        tax: sheetCell(ws, r, 8),
        settled: sheetCell(ws, r, 9),
        open: sheetCell(ws, r, 10),
      });
      if (money.ok) {
        facts.push(
          buildFact({
            physicalRow: r,
            side: "ap",
            personName: lastName,
            settlementDate: date.date,
            gross: money.gross,
            tax: money.tax,
            settled: money.settled,
            open: money.open,
          }),
        );
      }
    }
  }

  if (facts.length === 0 && errors.length === 0) {
    return { ok: false, reason: "empty_workbook", message: "nenhum fato analítico no pivot 4" };
  }

  return {
    ok: true,
    sheet: ws.name,
    physicalRows: ws.rowCount,
    facts,
    ignored,
    errors,
    workbookTotals,
  };
}
