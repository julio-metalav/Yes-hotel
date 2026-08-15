import { GROUPING_MAX_CANDIDATES, type ReconResult, type ReconSample } from "./types.ts";

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole},${frac}`;
}

const PII_LEAK_RE =
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/;

export function reconReportLeaksPii(text: string): boolean {
  return PII_LEAK_RE.test(text);
}

function sampleLine(sample: ReconSample): string {
  return `  - ids=${sample.entry_ids_masked.join(",")} valor=${formatCents(sample.amount_cents)} score=${sample.score ?? "-"} party=${sample.party_match ?? "-"} d=${sample.date_distance_days ?? "-"} fitid=${sample.source_record_id_masked ?? "-"}`;
}

export function formatOmieSicrediDryRun(result: ReconResult): string {
  const s = result.stats;
  const lines = [
    `rule_version: ${result.rule_version}`,
    `período: ${s.period_start} → ${s.period_end}`,
    `Sicredi considerado: ${s.sicredi_count} (créditos ${s.sicredi_credit_count}/${formatCents(s.sicredi_credit_cents)}; débitos ${s.sicredi_debit_count}/${formatCents(s.sicredi_debit_cents)})`,
    `Omie AR: ${s.omie_ar_count} settled ${formatCents(s.omie_ar_settled_cents)}`,
    `Omie AP: ${s.omie_ap_count} settled ${formatCents(s.omie_ap_settled_cents)}`,
    `transferências internas: ${s.transfer_count} (high ${s.transfer_high_count}/${formatCents(s.transfer_cents)}; ambíguas ${s.transfer_ambiguous_count}/${formatCents(s.transfer_ambiguous_cents)})`,
    `matches 1:1 high: ${s.high_count} / ${formatCents(s.high_cents)}`,
    `matches 1:1 suggested: ${s.suggested_count} / ${formatCents(s.suggested_cents)}`,
    `matches ambiguous: ${s.ambiguous_count} / ${formatCents(s.ambiguous_cents)}`,
    `groups N:1 oficiais: ${s.aggregation_count} (A ${s.aggregation_a_count}/${s.aggregation_a_entries} entries/${formatCents(s.aggregation_a_cents)}; B ${s.aggregation_b_count}/${s.aggregation_b_entries} entries/${formatCents(s.aggregation_b_cents)})`,
    `N:1 AR→crédito: ${s.aggregation_ar_count} / ${s.aggregation_ar_entries} entries / ${formatCents(s.aggregation_ar_cents)}`,
    `N:1 AP→débito: ${s.aggregation_ap_count} / ${s.aggregation_ap_entries} entries / ${formatCents(s.aggregation_ap_cents)}`,
    `grouping_search_limit A/B: ${s.grouping_search_limit} (candidatos>${GROUPING_MAX_CANDIDATES} ${s.grouping_search_limit_candidates}; combinações ${s.grouping_search_limit_combinations})`,
    `possible C AR: bancos ${s.possible_agg_c_ar.bank_count} omie ${s.possible_agg_c_ar.omie_entries} unique ${s.possible_agg_c_ar.unique_count} amb ${s.possible_agg_c_ar.ambiguous_count} valor ${formatCents(s.possible_agg_c_ar.amount_cents)}`,
    `possible D AR: bancos ${s.possible_agg_d_ar.bank_count} omie ${s.possible_agg_d_ar.omie_entries} unique ${s.possible_agg_d_ar.unique_count} amb ${s.possible_agg_d_ar.ambiguous_count} valor ${formatCents(s.possible_agg_d_ar.amount_cents)}`,
    `possible C AP: bancos ${s.possible_agg_c_ap.bank_count} omie ${s.possible_agg_c_ap.omie_entries} unique ${s.possible_agg_c_ap.unique_count} amb ${s.possible_agg_c_ap.ambiguous_count} valor ${formatCents(s.possible_agg_c_ap.amount_cents)}`,
    `possible D AP: bancos ${s.possible_agg_d_ap.bank_count} omie ${s.possible_agg_d_ap.omie_entries} unique ${s.possible_agg_d_ap.unique_count} amb ${s.possible_agg_d_ap.ambiguous_count} valor ${formatCents(s.possible_agg_d_ap.amount_cents)}`,
    `high entries consumidas: ${s.high_entries_consumed} (colisões ${s.high_collision_count})`,
    `high AR ${formatCents(s.high_ar_cents)} / high AP ${formatCents(s.high_ap_cents)} / cobertura Omie settled ${s.high_omie_settled_coverage_pct}%`,
    `cobertura banco high: créditos ${s.high_bank_credit_coverage_pct}% / débitos ${s.high_bank_debit_coverage_pct}%`,
    `high party_match: exact ${s.high_party_exact_normalized} token ${s.high_party_token_exact} contains ${s.high_party_contains_safe} no_match ${s.high_party_no_match} (só valor+data ${s.high_amount_date_only_count})`,
    `Omie AR sem banco: ${s.omie_ar_unmatched_count} / ${formatCents(s.omie_ar_unmatched_cents)}`,
    `Omie AP sem banco: ${s.omie_ap_unmatched_count} / ${formatCents(s.omie_ap_unmatched_cents)}`,
    `banco créditos sem Omie: ${s.bank_credit_unmatched_count} / ${formatCents(s.bank_credit_unmatched_cents)}`,
    `banco débitos sem Omie: ${s.bank_debit_unmatched_count} / ${formatCents(s.bank_debit_unmatched_cents)}`,
    `score 0-74: ${s.score_histogram["0-74"] ?? 0}`,
    `score 75-89: ${s.score_histogram["75-89"] ?? 0}`,
    `score 90-100: ${s.score_histogram["90-100"] ?? 0}`,
    `findings: ${result.findings.length}`,
    `persistido: NÃO`,
  ];
  const byCategory = new Map<string, ReconSample[]>();
  for (const sample of result.samples) {
    const list = byCategory.get(sample.category) ?? [];
    list.push(sample);
    byCategory.set(sample.category, list);
  }
  for (const [category, list] of byCategory) {
    lines.push(`amostra ${category}:`);
    for (const sample of list) lines.push(sampleLine(sample));
  }
  return lines.join("\n");
}
