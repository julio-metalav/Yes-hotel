import type { FinancialDirection, FinancialEntryType, FinancialSourceKind } from "../../types.ts";

export const OMIE_AR_AP_PARSER_NAME = "omie_ar_ap";
export const OMIE_AR_AP_PARSER_VERSION = "omie_ar_ap@1.0.0";

export const OMIE_AR_AP_SHEET_PREFIX = "Contas por Cliente ou Forne";

export const OMIE_AR_AP_HEADERS = {
  person: "Cliente ou Fornecedor (Nome Fantasia)",
  settlementDate: "Data de Pagto ou Recbto (completa)",
  arGroup: "1. Contas a Receber",
  apGroup: "2. Contas a Pagar",
  totalsGroup: "Totais",
  arGross: "Soma de Valor da Conta",
  arTax: "Soma de Impostos Retidos",
  arSettled: "Soma de Pago ou Recebido",
  arOpen: "Soma de A Pagar ou Receber",
  apGross: "Soma de Valor da Conta",
  apTax: "Soma de Impostos Retidos",
  apSettled: "Soma de Pago ou Recebido",
  apOpen: "Soma de A Pagar ou Receber",
  knGross: "Valor da Conta",
  knTax: "Impostos Retidos",
  knSettled: "Pago ou Recebido",
  knOpen: "A Pagar ou Receber",
} as const;

export type OmieArApSide = "ar" | "ap";

export type OmieArApRowKind = "title" | "section" | "header" | "data" | "total" | "empty" | "unknown";

export type OmieArApRowErrorCode =
  | "invalid_amount"
  | "invalid_date"
  | "malformed_row"
  | "unsupported_row_shape"
  | "inconsistent_entry_type"
  | "missing_required_field"
  | "duplicate_source_record";

export type OmieArApFatalCode = "malformed_workbook" | "incompatible_headers" | "empty_workbook";

export type OmieArApMoney = {
  signedCents: number;
  absCents: number;
};

export type OmieArApFact = {
  physicalRow: number;
  sourceRow: number;
  side: OmieArApSide;
  personName: string;
  settlementDate: string;
  gross: OmieArApMoney;
  tax: OmieArApMoney;
  settled: OmieArApMoney;
  open: OmieArApMoney;
};

export type OmieArApIgnored = {
  physicalRow: number;
  kind: OmieArApRowKind;
  reason: string;
};

export type OmieArApNormalizedEntry = {
  source_system: "omie";
  source_kind: Extract<FinancialSourceKind, "omie_receivable" | "omie_payable">;
  direction: FinancialDirection;
  entry_type: Extract<FinancialEntryType, "receivable" | "payable">;
  account_id: null;
  source_record_id: null;
  source_row: number;
  person_name: string;
  document_number: null;
  installment: null;
  category_source: null;
  category_yes: null;
  description: string;
  gross_amount_cents: number;
  tax_cents: number;
  settled_amount_cents: number;
  open_amount_cents: number;
  net_amount_cents: null;
  issue_date: null;
  due_date: null;
  settlement_date: string;
  competence_date: null;
  payment_method: null;
  external_reference: null;
  raw_payload: Record<string, unknown>;
  normalized_hash: string;
};

export type OmieArApRowError = {
  row_number: number;
  code: OmieArApRowErrorCode;
  message: string;
  raw_excerpt: string;
};

export type OmieArApStats = {
  physical_rows: number;
  ignored_rows: number;
  entries: number;
  ar_count: number;
  ap_count: number;
  ar_gross_cents: number;
  ar_settled_cents: number;
  ar_open_cents: number;
  ar_tax_cents: number;
  ap_gross_cents: number;
  ap_settled_cents: number;
  ap_open_cents: number;
  ap_tax_cents: number;
  errors: number;
};

export type OmieArApWorkbookTotals = {
  ar_gross_cents: number | null;
  ar_settled_cents: number | null;
  ar_open_cents: number | null;
  ar_tax_cents: number | null;
  ap_gross_cents: number | null;
  ap_settled_cents: number | null;
  ap_open_cents: number | null;
  ap_tax_cents: number | null;
};

export type OmieArApImportOk = {
  ok: true;
  file_sha256: string;
  parser_name: typeof OMIE_AR_AP_PARSER_NAME;
  parser_version: typeof OMIE_AR_AP_PARSER_VERSION;
  sheet: string;
  period_start: string | null;
  period_end: string | null;
  workbook_totals: OmieArApWorkbookTotals | null;
  entries: OmieArApNormalizedEntry[];
  ignored: OmieArApIgnored[];
  errors: OmieArApRowError[];
  stats: OmieArApStats;
};

export type OmieArApImportFatal = {
  ok: false;
  file_sha256: string;
  parser_name: typeof OMIE_AR_AP_PARSER_NAME;
  parser_version: typeof OMIE_AR_AP_PARSER_VERSION;
  fatal: { code: OmieArApFatalCode; message: string };
  errors: OmieArApRowError[];
  stats: OmieArApStats;
};

export type OmieArApImportResult = OmieArApImportOk | OmieArApImportFatal;
