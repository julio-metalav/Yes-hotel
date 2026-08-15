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

export const OMIE_SICREDI_RULE_VERSION = "omie_sicredi_v1.2";
export const RECON_PERIOD_START = "2026-01-01";
export const RECON_PERIOD_END = "2026-07-31";
export const MAX_DATE_WINDOW_DAYS = 2;
export const TRANSFER_WINDOW_DAYS = 1;
export const AGGREGATION_MAX_N = 8;
export const AGGREGATION_DATE_WINDOW_DAYS = 1;
export const GROUPING_MAX_CANDIDATES = 24;
export const GROUPING_MAX_COMBINATIONS = 8192;
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

export type PossibleAggregationWindow = "same_day" | "d1";
export type PossibleAggregationDirection = "ar_credit" | "ap_debit";

export type PossibleAggregationCandidate = {
  bank_entry_id: string;
  omie_entry_ids: string[];
  omie_count: number;
  amount_cents: number;
  amount_exact: boolean;
  date_window: PossibleAggregationWindow;
  unique_combination: boolean;
  candidate_count: number;
  search_limit: boolean;
  direction: PossibleAggregationDirection;
};

export type PossibleAggregationBucketStats = {
  bank_count: number;
  omie_entries: number;
  amount_cents: number;
  unique_count: number;
  ambiguous_count: number;
  search_limit: number;
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
  aggregation_entries: number;
  aggregation_high_count: number;
  aggregation_suggested_count: number;
  aggregation_ar_count: number;
  aggregation_ar_entries: number;
  aggregation_ar_cents: number;
  aggregation_ap_count: number;
  aggregation_ap_entries: number;
  aggregation_ap_cents: number;
  aggregation_a_count: number;
  aggregation_a_entries: number;
  aggregation_a_cents: number;
  aggregation_b_count: number;
  aggregation_b_entries: number;
  aggregation_b_cents: number;
  grouping_search_limit: number;
  grouping_search_limit_candidates: number;
  grouping_search_limit_combinations: number;
  transfer_ambiguous_cents: number;
  possible_agg_c_ar: PossibleAggregationBucketStats;
  possible_agg_d_ar: PossibleAggregationBucketStats;
  possible_agg_c_ap: PossibleAggregationBucketStats;
  possible_agg_d_ap: PossibleAggregationBucketStats;
  high_entries_consumed: number;
  high_ar_cents: number;
  high_ap_cents: number;
  high_omie_settled_coverage_pct: number;
  high_bank_credit_coverage_pct: number;
  high_bank_debit_coverage_pct: number;
  high_collision_count: number;
  high_amount_date_only_count: number;
  high_party_exact_normalized: number;
  high_party_token_exact: number;
  high_party_contains_safe: number;
  high_party_no_match: number;
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
  ambiguous: ReconGroup[];
  findings: ReconFinding[];
  possible_aggregations: PossibleAggregationCandidate[];
  stats: ReconStats;
  samples: ReconSample[];
};
