import type { FinancialDirection, FinancialSourceKind } from "../../types.ts";

export type AccountResolutionMethod = "mask" | "operator_hint" | "fingerprint";

export type OfxAccountFingerprint = {
  bank_id: string | null;
  branch_fingerprint: string | null;
  account_last4: string | null;
  account_type: string | null;
};

export const OFX_PARSER_NAME = "ofx_sicredi";
export const OFX_PARSER_VERSION = "ofx@1.0.0";

export const SICREDI_BANK_IDS = ["748"] as const;

export type OfxRowErrorCode =
  | "invalid_amount"
  | "invalid_date"
  | "missing_required_field"
  | "duplicate_source_record"
  | "account_unresolved"
  | "malformed_transaction";

export type OfxFatalCode =
  | "malformed_ofx"
  | "account_unresolved"
  | "account_fingerprint_mismatch"
  | "empty_banktranlist"
  | "duplicate_import";

export type OfxAccountHint = {
  code: string;
  account_mask: string | null;
  institution: string | null;
  ofx_fingerprint?: OfxAccountFingerprint | null;
};

export type OfxBankAccount = {
  bankId: string | null;
  branchId: string | null;
  acctId: string | null;
  acctType: string | null;
  acctIdLast4: string | null;
};

export type OfxBalance = {
  amountCents: number | null;
  asOfDate: string | null;
  rawAmount: string | null;
};

export type OfxStmtTrn = {
  sourceRow: number;
  trntype: string | null;
  dtposted: string | null;
  dtuser: string | null;
  trnamt: string | null;
  fitid: string | null;
  checknum: string | null;
  refnum: string | null;
  name: string | null;
  memo: string | null;
};

export type OfxDocument = {
  currency: string | null;
  periodStartRaw: string | null;
  periodEndRaw: string | null;
  account: OfxBankAccount;
  transactions: OfxStmtTrn[];
  ledgerBal: OfxBalance | null;
  availBal: OfxBalance | null;
};

export type OfxNormalizedEntry = {
  source_system: "sicredi";
  source_kind: Extract<FinancialSourceKind, "bank_credit" | "bank_debit">;
  direction: FinancialDirection;
  entry_type: "bank_tx";
  account_code: string;
  source_record_id: string | null;
  source_row: number;
  external_reference: string | null;
  person_name: string | null;
  description: string;
  gross_amount_cents: number;
  net_amount_cents: number;
  settlement_date: string;
  payment_method: null;
  raw_payload: Record<string, unknown>;
  normalized_hash: string;
};

export type OfxRowError = {
  row_number: number;
  code: OfxRowErrorCode;
  message: string;
  raw_excerpt: string;
};

export type OfxDryRunStats = {
  transactions: number;
  credits_count: number;
  credits_cents: number;
  debits_count: number;
  debits_cents: number;
  missing_fitid: number;
  errors: number;
};

export type OfxImportOk = {
  ok: true;
  file_sha256: string;
  parser_name: typeof OFX_PARSER_NAME;
  parser_version: typeof OFX_PARSER_VERSION;
  account_code: string;
  account_resolution: AccountResolutionMethod;
  currency: string | null;
  period_start: string | null;
  period_end: string | null;
  ledger_balance: OfxBalance | null;
  avail_balance: OfxBalance | null;
  entries: OfxNormalizedEntry[];
  errors: OfxRowError[];
  stats: OfxDryRunStats;
};

export type OfxImportFatal = {
  ok: false;
  file_sha256: string;
  parser_name: typeof OFX_PARSER_NAME;
  parser_version: typeof OFX_PARSER_VERSION;
  account_code: null;
  fatal: { code: OfxFatalCode; message: string };
  errors: OfxRowError[];
  stats: OfxDryRunStats;
};

export type OfxImportResult = OfxImportOk | OfxImportFatal;
