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
  const layerCount = (layer: string) =>
    result.groups.filter((group) => group.kind === "many_to_one" && group.score_evidence.grouping_layer === layer).length;
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
    `groups N:1: ${s.aggregation_count} grupos / ${s.aggregation_entries} entries / ${formatCents(s.aggregation_cents)} (high ${s.aggregation_high_count}; suggested ${s.aggregation_suggested_count})`,
    `N:1 camadas: A pessoa+data ${layerCount("person_date")} / B pessoa+D+1 ${layerCount("person_window")} / C lote data ${layerCount("date_batch")} / D lote D+1 ${layerCount("window_batch")}`,
    `N:1 AR→crédito: ${s.aggregation_ar_count} / ${s.aggregation_ar_entries} entries / ${formatCents(s.aggregation_ar_cents)}`,
    `N:1 AP→débito: ${s.aggregation_ap_count} / ${s.aggregation_ap_entries} entries / ${formatCents(s.aggregation_ap_cents)}`,
    `grouping_search_limit: ${s.grouping_search_limit} (candidatos>${GROUPING_MAX_CANDIDATES} ${s.grouping_search_limit_candidates}; combinações ${s.grouping_search_limit_combinations}; tempo ${s.grouping_search_limit_time})`,
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
