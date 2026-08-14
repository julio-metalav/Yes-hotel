/**
 * Contratos da fundação financeira V1.
 * Camada normalizada de fatos importados/projetados — não é livro-razão oficial.
 */

export type MoneyCents = number;

export type FinancialAccountCode = "sicredi_principal" | "sicredi_0911" | (string & {});

export type FinancialAccountKind = "bank" | "acquirer" | "psp" | "cash" | "other";

export type FinancialAccountStatus = "active" | "inactive";

export type FinancialSourceType =
  | "omie_revenue"
  | "omie_ar_ap"
  | "ofx_bank"
  | "hits_report"
  | "pagarme_export"
  | "stone_settlement"
  | "other";

export type FinancialImportStatus =
  | "uploaded"
  | "parsing"
  | "parsed"
  | "normalized"
  | "failed"
  | "superseded";

export type FinancialSourceSystem = "hits" | "omie" | "sicredi" | "stone" | "pagarme" | "manual";

export type FinancialSourceKind =
  | "hits_reservation"
  | "omie_invoice"
  | "omie_receivable"
  | "omie_payable"
  | "bank_credit"
  | "bank_debit"
  | "acquirer_settlement"
  | "psp_payment"
  | "other";

export type FinancialDirection = "credit" | "debit";

export type FinancialEntryType =
  | "receivable"
  | "payable"
  | "bank_tx"
  | "fee"
  | "tax"
  | "transfer"
  | "invoice"
  | "payment"
  | "other";

export type FinancialEntryLifecycle = "active" | "voided_by_reimport" | "ignored";

export type FinancialMatchStatus =
  | "suggested"
  | "auto_matched"
  | "confirmed"
  | "rejected"
  | "superseded";

export type FinancialMatchLegRole = "source" | "target";

export type FinancialFindingType =
  | "hits_without_omie"
  | "omie_without_hits"
  | "omie_without_bank"
  | "bank_without_omie"
  | "value_mismatch"
  | "duplicate_possible"
  | "date_mismatch"
  | "unidentified_credit"
  | "unidentified_debit"
  | "internal_transfer"
  | "partial_payment"
  | "payment_aggregation"
  | "possible_wrong_category"
  | "unbalanced_match_group"
  | "import_row_error_unresolved"
  | "hits_balance_vs_omie_open";

export type FinancialSignalClass =
  | "divergence"
  | "anomaly"
  | "requires_review"
  | "fraud_risk_signal";

export type FinancialFindingSeverity = "info" | "low" | "medium" | "high";

export type FinancialFindingStatus = "open" | "in_review" | "resolved" | "ignored" | "justified";

export type FinancialAiAnalysisStatus = "ok" | "timeout" | "provider_error" | "refused";

export type FinancialNameMatch =
  | "normalized_exact"
  | "token_sort"
  | "none"
  | "unknown";

/** Evidência determinística persistida em financial_reconciliation_groups.score_evidence. */
export type FinancialScoreEvidence = {
  amount_exact?: boolean;
  document_match?: boolean;
  date_distance_days?: number | null;
  name_match?: FinancialNameMatch;
  same_account?: boolean;
  direction_compatible?: boolean;
  external_id_match?: boolean;
  rule_id?: string;
};

export type FinancialReservationRef = {
  hits_id?: string | null;
  integration_id?: string | null;
  operacional_reserva_id?: string | null;
  management_reservation_id?: string | null;
};

export const FINANCIAL_FINDING_TYPES: readonly FinancialFindingType[] = [
  "hits_without_omie",
  "omie_without_hits",
  "omie_without_bank",
  "bank_without_omie",
  "value_mismatch",
  "duplicate_possible",
  "date_mismatch",
  "unidentified_credit",
  "unidentified_debit",
  "internal_transfer",
  "partial_payment",
  "payment_aggregation",
  "possible_wrong_category",
  "unbalanced_match_group",
  "import_row_error_unresolved",
  "hits_balance_vs_omie_open",
] as const;

export const FINANCIAL_SIGNAL_CLASSES: readonly FinancialSignalClass[] = [
  "divergence",
  "anomaly",
  "requires_review",
  "fraud_risk_signal",
] as const;

export const FORBIDDEN_FINDING_STATUSES = ["fraude_confirmada"] as const;

export const RAW_PAYLOAD_FORBIDDEN_KEYS = [
  "cpf",
  "cnpj",
  "cpf_cnpj",
  "document_number_full",
  "federal_registration",
  "federalRegistrationNumber",
  "docCpfCnpjPassport",
  "account_number",
  "agencia",
  "conta",
  "pan",
  "card_number",
  "pix_copia_e_cola",
  "pixCopiaECola",
] as const;

export const RAW_PAYLOAD_ALLOWED_KEYS = [
  "source_row",
  "document_number",
  "installment",
  "gross_amount_cents",
  "net_amount_cents",
  "fee_cents",
  "tax_cents",
  "open_amount_cents",
  "settled_amount_cents",
  "omie_side",
  "issue_date",
  "due_date",
  "settlement_date",
  "competence_date",
  "category_source",
  "fitid",
  "trntype",
  "description_redacted",
  "external_reference",
  "currency",
  "parser_version",
  "dtposted_raw",
  "timezone",
  "checknum",
  "refnum",
] as const;

export const SEEDED_FINANCIAL_ACCOUNT_CODES = ["sicredi_principal", "sicredi_0911"] as const;
