import type {
  FinancialDirection,
  FinancialFindingType,
  FinancialMatchStatus,
  FinancialPartyMatch,
  FinancialScoreEvidence,
  FinancialSignalClass,
  FinancialSourceKind,
  FinancialSourceSystem,
} from "../types.ts";

export const OMIE_SICREDI_RULE_VERSION = "omie_sicredi_v1";
export const RECON_PERIOD_START = "2026-01-01";
export const RECON_PERIOD_END = "2026-07-31";
export const MAX_DATE_WINDOW_DAYS = 2;
export const TRANSFER_WINDOW_DAYS = 1;
export const AGGREGATION_MAX_N = 10;
export const AGGREGATION_DATE_WINDOW_DAYS = 1;
export const HIGH_SCORE_MIN = 90;
export const SUGGESTED_SCORE_MIN = 75;

export const YES_HOTEL_BANK_CODES = ["sicredi_principal", "sicredi_0911"] as const;
export type YesHotelBankCode = (typeof YES_HOTEL_BANK_CODES)[number];

export type ReconEntry = {
  id: string;
  account_id: string | null;
  account_code: string | null;
  source_system: FinancialSourceSystem;
  source_kind: FinancialSourceKind;
  source_import_id: string | null;
  source_record_id: string | null;
  direction: FinancialDirection;
  person_name: string | null;
  description: string | null;
  gross_amount_cents: number | null;
  settled_amount_cents: number | null;
  open_amount_cents: number | null;
  settlement_date: string;
};

export type PartyCompare = FinancialPartyMatch;

export type TransferConfidence = "high" | "ambiguous";

export type InternalTransferCandidate = {
  debit_entry_id: string;
  credit_entry_id: string;
  amount_cents: number;
  date_distance_days: number;
  debit_account: YesHotelBankCode;
  credit_account: YesHotelBankCode;
  description_compatible: boolean;
  counterpart_count: number;
  confidence: TransferConfidence;
  score_evidence: FinancialScoreEvidence;
};

export type MatchKind = "one_to_one" | "many_to_one";

export type MatchBand = "high" | "suggested" | "ambiguous";

export type ReconGroup = {
  id: string;
  kind: MatchKind;
  band: MatchBand;
  status: Extract<FinancialMatchStatus, "suggested" | "auto_matched">;
  rule_version: typeof OMIE_SICREDI_RULE_VERSION;
  confidence: number;
  matched_amount_cents: number;
  omie_entry_ids: string[];
  bank_entry_ids: string[];
  score_evidence: FinancialScoreEvidence;
};

export type ReconFinding = {
  id: string;
  finding_type: FinancialFindingType;
  signal_class: FinancialSignalClass;
  severity: "info" | "low" | "medium" | "high";
  entry_ids: string[];
  group_id: string | null;
  import_ids: string[];
  amount_cents: number;
  period_start: string;
  period_end: string;
  note: string;
};

export type ScoreHistogram = Record<string, number>;

export type ReconStats = {
  period_start: string;
  period_end: string;
  sicredi_count: number;
  sicredi_credit_count: number;
  sicredi_debit_count: number;
  sicredi_credit_cents: number;
  sicredi_debit_cents: number;
  omie_ar_count: number;
  omie_ap_count: number;
  omie_ar_settled_cents: number;
  omie_ap_settled_cents: number;
  transfer_count: number;
  transfer_high_count: number;
  transfer_ambiguous_count: number;
  transfer_cents: number;
  high_count: number;
  high_cents: number;
  suggested_count: number;
  suggested_cents: number;
  ambiguous_count: number;
  ambiguous_cents: number;
  aggregation_count: number;
  aggregation_cents: number;
  omie_ar_unmatched_count: number;
  omie_ar_unmatched_cents: number;
  omie_ap_unmatched_count: number;
  omie_ap_unmatched_cents: number;
  bank_credit_unmatched_count: number;
  bank_credit_unmatched_cents: number;
  bank_debit_unmatched_count: number;
  bank_debit_unmatched_cents: number;
  score_histogram: ScoreHistogram;
};

export type ReconSample = {
  category: string;
  entry_ids_masked: string[];
  amount_cents: number;
  score: number | null;
  party_match: PartyCompare | null;
  date_distance_days: number | null;
  source_record_id_masked: string | null;
};

export type ReconResult = {
  rule_version: typeof OMIE_SICREDI_RULE_VERSION;
  transfers: InternalTransferCandidate[];
  groups: ReconGroup[];
  findings: ReconFinding[];
  stats: ReconStats;
  samples: ReconSample[];
};
