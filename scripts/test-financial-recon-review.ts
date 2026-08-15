/**
 * Revisão financeira Omie ↔ Sicredi (PR F).
 * DTO sanitizado, KPIs, paginação, engine read-only. Sem I/O remoto.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANALYSIS_ENTRY_COLUMNS,
  ANALYSIS_ENTRY_SELECT,
  ANALYSIS_SOURCE_KINDS,
  OMIE_SICREDI_HIGH_PERSIST_EXPECT,
  OMIE_SICREDI_LIVE_ANALYSIS_EXPECT,
  OMIE_SICREDI_RULE_VERSION,
  REVIEW_ALLOWED_ACTIONS,
  assertReviewDtoSafe,
  buildAnalysisLists,
  collectOneToOneCandidates,
  filterAnalysisRows,
  kpisFromPersisted,
  maskFitid,
  maskPersonName,
  mergeAnalysisKpis,
  normalizeReviewFilters,
  paginateRows,
  redactDescription,
  reconcileOmieSicredi,
  reviewDtoLeaksSensitive,
  sanitizePersistedDetail,
  sanitizePersistedListRow,
  scoreOmieBankPair,
  summarizeScoreEvidence,
  type ReconEntry,
  type ReconResult,
} from "../src/lib/financial/reconciliation/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function entry(
  partial: Partial<ReconEntry> & Pick<ReconEntry, "id" | "source_system" | "source_kind" | "direction">,
): ReconEntry {
  return {
    account_id: partial.account_id ?? null,
    account_code: partial.account_code ?? null,
    source_import_id: partial.source_import_id ?? "imp-1",
    source_record_id: partial.source_record_id ?? null,
    person_name: partial.person_name ?? null,
    description: partial.description ?? null,
    gross_amount_cents: partial.gross_amount_cents ?? null,
    settled_amount_cents: partial.settled_amount_cents ?? null,
    open_amount_cents: partial.open_amount_cents ?? 0,
    settlement_date: partial.settlement_date ?? "2026-03-10",
    ...partial,
  };
}

console.log("\n=== Revisão financeira Omie ↔ Sicredi ===\n");

{
  assert.equal(maskPersonName("CLIENTE SINTETICO LTDA"), "C*** S***");
  assert.equal(maskFitid("FITID123456"), "FITI…");
  const redacted = redactDescription("PAGTO FORNECEDOR 12345678900 REF MARCO");
  assert.ok(redacted && redacted.includes("…"));
  assert.ok(!redacted.includes("12345678900"));
  assert.ok((redacted?.length ?? 0) <= 29);
  ok("máscaras de pessoa, FITID e descrição");
}

{
  const summary = summarizeScoreEvidence({
    amount_exact: true,
    date_distance_days: 1,
    party_match: "token_exact",
    candidate_count: 1,
    rule_id: OMIE_SICREDI_RULE_VERSION,
  });
  assert.deepEqual(summary, [
    "valor exato",
    "D+1",
    "party_match token_exact",
    "candidate_count 1",
    `rule_version ${OMIE_SICREDI_RULE_VERSION}`,
  ]);
  ok("score_evidence resumido sem MEMO");
}

{
  const filters = normalizeReviewFilters({
    view: "suggested",
    page: 2,
    page_size: 10,
    defaultStart: "2026-01-01",
    defaultEnd: "2026-07-31",
  });
  assert.equal(filters.view, "suggested");
  assert.equal(filters.page, 2);
  assert.equal(filters.period_start, "2026-01-01");
  const page = paginateRows(["a", "b", "c", "d"], 2, 2);
  assert.deepEqual(page.rows, ["c", "d"]);
  assert.equal(page.total, 4);
  ok("filtros e paginação server-side");
}

{
  const omie = entry({
    id: "11111111-1111-4111-8111-111111111111",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "HOTEL YES CENTRO LTDA",
    settled_amount_cents: 150000,
    gross_amount_cents: 150000,
    settlement_date: "2026-03-10",
  });
  const bank = entry({
    id: "22222222-2222-4222-8222-222222222222",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    source_record_id: "ABCD9999FITID",
    description: "CRED HOTEL YES CENTRO 000123456789",
    person_name: "YES CENTRO",
    gross_amount_cents: 150000,
    settlement_date: "2026-03-10",
  });
  const row = sanitizePersistedListRow({
    id: "group-1",
    match_method: "one_to_one",
    status: "auto_matched",
    confidence: 93,
    matched_amount_cents: 150000,
    score_evidence: {
      amount_exact: true,
      date_distance_days: 0,
      party_match: "token_exact",
      candidate_count: 1,
    },
    rule_version: OMIE_SICREDI_RULE_VERSION,
    omie,
    bank,
    debit: null,
    credit: null,
  });
  assert.equal(row.kind, "AR");
  assert.equal(row.status, "auto_matched");
  assert.equal(row.persisted, true);
  assert.ok(row.evidence_summary.includes("valor exato"));
  assert.ok(row.evidence_summary.includes("D0"));
  assert.ok(!JSON.stringify(row).includes("HOTEL YES CENTRO LTDA"));
  assert.ok(!JSON.stringify(row).includes("000123456789"));
  assertReviewDtoSafe(row);
  ok("lista high sanitizada");
}

{
  const debit = entry({
    id: "d1",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "TRANSF ENTRE CONTAS",
    gross_amount_cents: 10000,
  });
  const credit = entry({
    id: "c1",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_0911",
    description: "TRANSF ENTRE CONTAS",
    gross_amount_cents: 10000,
  });
  const detail = sanitizePersistedDetail({
    id: "tr-1",
    match_method: "internal_transfer",
    status: "auto_matched",
    confidence: 100,
    matched_amount_cents: 10000,
    score_evidence: { amount_exact: true, date_distance_days: 0, memo_transfer_signal: true },
    rule_version: OMIE_SICREDI_RULE_VERSION,
    created_at: "2026-08-14T00:00:00Z",
    omie: null,
    bank: null,
    debit,
    credit,
  });
  assert.equal(detail.kind, "internal_transfer");
  assert.equal(detail.omie, null);
  assert.ok(detail.transfer_debit);
  assert.ok(detail.transfer_credit);
  assert.notEqual(detail.kind, "AR");
  assert.notEqual(detail.kind, "AP");
  ok("transferência interna separada de receita/despesa");
}

{
  const omieHigh = entry({
    id: "o-high",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE ALFA LTDA",
    settled_amount_cents: 200000,
    gross_amount_cents: 200000,
    settlement_date: "2026-03-10",
  });
  const bankHigh = entry({
    id: "b-high",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    person_name: "CLIENTE ALFA",
    description: "CRED CLIENTE ALFA",
    gross_amount_cents: 200000,
    settlement_date: "2026-03-10",
  });
  const omieSug = entry({
    id: "o-sug",
    source_system: "omie",
    source_kind: "omie_payable",
    direction: "debit",
    person_name: "FORNECEDOR BETA",
    settled_amount_cents: 80000,
    gross_amount_cents: 80000,
    settlement_date: "2026-03-11",
  });
  const bankSug = entry({
    id: "b-sug",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "PAGTO DIVERSO",
    gross_amount_cents: 80000,
    settlement_date: "2026-03-11",
  });
  const omieOpen = entry({
    id: "o-open",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE GAMA",
    settled_amount_cents: 50000,
    gross_amount_cents: 50000,
    settlement_date: "2026-03-20",
  });
  const bankOpen = entry({
    id: "b-open",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_0911",
    description: "CRED DESCONHECIDO",
    gross_amount_cents: 33000,
    settlement_date: "2026-03-21",
  });
  const result = reconcileOmieSicredi({
    entries: [omieHigh, bankHigh, omieSug, bankSug, omieOpen, bankOpen],
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
  });
  const lists = buildAnalysisLists(result, [omieHigh, bankHigh, omieSug, bankSug, omieOpen, bankOpen]);
  assert.ok(result.stats.high_count >= 1);
  assert.ok(result.stats.suggested_count >= 1);
  assert.ok(lists.suggested.length === result.stats.suggested_count);
  assert.ok(lists.suggested.every((row) => row.persisted === false));
  assert.ok(lists.unmatched_omie.some((row) => row.label === "Não conciliado"));
  assert.ok(lists.unmatched_bank.some((row) => row.label === "Não conciliado"));
  const filtered = filterAnalysisRows(lists.unmatched_bank, {
    origin: "sicredi",
    direction: "credit",
    account_code: "sicredi_0911",
  });
  assert.ok(filtered.length >= 1);
  const kpis = mergeAnalysisKpis(
    kpisFromPersisted({
      omie_ar_count: 2,
      omie_ar_cents: 250000,
      omie_ap_count: 1,
      omie_ap_cents: 80000,
      sicredi_credit_count: 2,
      sicredi_credit_cents: 233000,
      sicredi_debit_count: 1,
      sicredi_debit_cents: 80000,
      high_count: result.stats.high_count,
      high_cents: result.stats.high_cents,
      transfer_count: 0,
      transfer_cents: 0,
      persisted_findings: 0,
    }),
    result.stats,
  );
  assert.equal(kpis.suggested_count, result.stats.suggested_count);
  assert.equal(kpis.high_count, result.stats.high_count);
  assert.equal(kpis.high_recomputed_count, result.stats.high_count);
  assert.equal(kpis.high_unpersisted_count, 0);
  assert.ok((kpis.unmatched_omie_count ?? 0) >= 1);
  assertReviewDtoSafe({ lists, kpis });
  ok("suggested/ambiguous/unmatched read-only via engine");
}

{
  const live = OMIE_SICREDI_LIVE_ANALYSIS_EXPECT;
  const persisted = OMIE_SICREDI_HIGH_PERSIST_EXPECT;
  assert.equal(persisted.high_count, 601);
  assert.equal(live.high_persisted_count, 601);
  assert.equal(live.high_recomputed_count, 601);
  assert.equal(live.high_unpersisted_count, 0);
  assert.equal(live.high_recomputed_count - live.high_persisted_count, 0);
  assert.equal(live.suggested_count, 819);
  assert.equal(live.ambiguous_count, 20);
  const kpis = mergeAnalysisKpis(
    kpisFromPersisted({
      omie_ar_count: 928,
      omie_ar_cents: 0,
      omie_ap_count: 1220,
      omie_ap_cents: 0,
      sicredi_credit_count: 0,
      sicredi_credit_cents: 0,
      sicredi_debit_count: 0,
      sicredi_debit_cents: 0,
      high_count: live.high_persisted_count,
      high_cents: live.high_persisted_cents,
      transfer_count: live.transfer_high_count,
      transfer_cents: live.transfer_cents,
      persisted_findings: 0,
    }),
    {
      high_count: live.high_recomputed_count,
      high_cents: live.high_recomputed_cents,
      suggested_count: live.suggested_count,
      suggested_cents: live.suggested_cents,
      ambiguous_count: live.ambiguous_count,
      ambiguous_cents: live.ambiguous_cents,
      omie_ar_unmatched_count: live.omie_ar_unmatched_count,
      omie_ar_unmatched_cents: live.omie_ar_unmatched_cents,
      omie_ap_unmatched_count: live.omie_ap_unmatched_count,
      omie_ap_unmatched_cents: live.omie_ap_unmatched_cents,
      bank_credit_unmatched_count: live.bank_credit_unmatched_count,
      bank_credit_unmatched_cents: live.bank_credit_unmatched_cents,
      bank_debit_unmatched_count: live.bank_debit_unmatched_count,
      bank_debit_unmatched_cents: live.bank_debit_unmatched_cents,
      possible_agg_c_ar: { bank_count: 0, omie_entries: 0, amount_cents: 0, unique_count: 0, ambiguous_count: 0, search_limit: 0 },
      possible_agg_d_ar: { bank_count: 0, omie_entries: 0, amount_cents: 0, unique_count: 0, ambiguous_count: 0, search_limit: 0 },
      possible_agg_c_ap: { bank_count: 0, omie_entries: 0, amount_cents: 0, unique_count: 0, ambiguous_count: 0, search_limit: 0 },
      possible_agg_d_ap: { bank_count: 0, omie_entries: 0, amount_cents: 0, unique_count: 0, ambiguous_count: 0, search_limit: 0 },
    } as Parameters<typeof mergeAnalysisKpis>[1],
  );
  assert.equal(kpis.high_count, 601);
  assert.equal(kpis.high_recomputed_count, 601);
  assert.equal(kpis.high_unpersisted_count, 0);
  ok("contrato live 601 persistido = recomputado; delta 0");
}

{
  const dirty = { raw_payload: { memo: "x" }, person_name: "JOAO 123.456.789-00" };
  assert.ok(reviewDtoLeaksSensitive(dirty).includes("raw_payload"));
  ok("detector bloqueia raw_payload e PII");
}

{
  const edge = readFileSync(join(root, "supabase/functions/financial-recon-review/index.ts"), "utf8");
  assert.match(edge, /ensureAdminCaller/);
  assert.match(edge, /Acesso restrito a admin/);
  assert.match(edge, /reconcileOmieSicredi/);
  assert.match(edge, /read_only: true/);
  assert.doesNotMatch(edge, /\.insert\(/);
  assert.doesNotMatch(edge, /\.update\(/);
  assert.doesNotMatch(edge, /\.delete\(/);
  assert.doesNotMatch(edge, /\.upsert\(/);
  assert.doesNotMatch(edge, /persist-high/);
  assert.match(edge, /Use POST/);
  assert.match(edge, /from "\.\.\/\.\.\/\.\.\/src\/lib\/financial\/reconciliation\/engine\.ts"/);
  assert.match(edge, /ANALYSIS_ENTRY_SELECT/);
  assert.match(edge, /\.gte\("settlement_date"/);
  assert.match(edge, /\.lte\("settlement_date"/);
  assert.match(edge, /source_kind/);
  assert.match(edge, /includePossibleAggregations/);
  assert.match(edge, /includeReportExtras: false/);
  assert.match(edge, /possible_aggregations/);
  assert.match(edge, /filters\.view === "possible_aggregation"/);
  assert.doesNotMatch(edge, /raw_payload/);
  assert.ok(!ANALYSIS_ENTRY_SELECT.includes("metadata"));
  assert.ok(!ANALYSIS_ENTRY_COLUMNS.includes("open_amount_cents" as never));
  assert.ok(ANALYSIS_SOURCE_KINDS.includes("omie_receivable"));
  assert.ok(REVIEW_ALLOWED_ACTIONS.includes("possible_aggregations"));
  ok("edge function admin-only, read-only, reutiliza engine");
}

function logicalCore(result: ReconResult) {
  return {
    high: [result.stats.high_count, result.stats.high_cents],
    transfer: [result.stats.transfer_high_count, result.stats.transfer_cents],
    suggested: [result.stats.suggested_count, result.stats.suggested_cents],
    ambiguous: [result.stats.ambiguous_count, result.stats.ambiguous_cents],
    unmatched: [
      result.stats.omie_ar_unmatched_count,
      result.stats.omie_ar_unmatched_cents,
      result.stats.omie_ap_unmatched_count,
      result.stats.omie_ap_unmatched_cents,
      result.stats.bank_credit_unmatched_count,
      result.stats.bank_credit_unmatched_cents,
      result.stats.bank_debit_unmatched_count,
      result.stats.bank_debit_unmatched_cents,
    ],
    group_ids: result.groups.map((group) => group.id),
    ambiguous_ids: result.ambiguous.map((group) => group.id),
  };
}

function bruteForceCandidates(omieEntries: ReconEntry[], bankEntries: ReconEntry[]) {
  const out: Array<{ omieId: string; bankId: string; score: number }> = [];
  for (const omie of omieEntries) {
    for (const bank of bankEntries) {
      const scored = scoreOmieBankPair(omie, bank);
      if (!scored || !scored.amountExact) continue;
      out.push({ omieId: omie.id, bankId: bank.id, score: scored.score });
    }
  }
  return out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return `${a.omieId}|${a.bankId}`.localeCompare(`${b.omieId}|${b.bankId}`);
  });
}

{
  const omie = [
    entry({
      id: "o1",
      source_system: "omie",
      source_kind: "omie_receivable",
      direction: "credit",
      person_name: "ALFA LTDA",
      settled_amount_cents: 10000,
      settlement_date: "2026-03-10",
    }),
    entry({
      id: "o2",
      source_system: "omie",
      source_kind: "omie_payable",
      direction: "debit",
      person_name: "BETA LTDA",
      settled_amount_cents: 20000,
      settlement_date: "2026-03-11",
    }),
    entry({
      id: "o3",
      source_system: "omie",
      source_kind: "omie_receivable",
      direction: "credit",
      person_name: "GAMA",
      settled_amount_cents: 33300,
      settlement_date: "2026-03-12",
    }),
  ];
  const bank = [
    entry({
      id: "b1",
      source_system: "sicredi",
      source_kind: "bank_credit",
      direction: "credit",
      person_name: "ALFA",
      description: "CRED ALFA LTDA",
      gross_amount_cents: 10000,
      settlement_date: "2026-03-10",
    }),
    entry({
      id: "b2",
      source_system: "sicredi",
      source_kind: "bank_debit",
      direction: "debit",
      description: "PAGTO BETA",
      gross_amount_cents: 20000,
      settlement_date: "2026-03-12",
    }),
    entry({
      id: "b3",
      source_system: "sicredi",
      source_kind: "bank_credit",
      direction: "credit",
      description: "CRED OUTRO",
      gross_amount_cents: 99900,
      settlement_date: "2026-03-12",
    }),
  ];
  const indexed = collectOneToOneCandidates(omie, bank, new Set()).map((row) => ({
    omieId: row.omie.id,
    bankId: row.bank.id,
    score: row.score,
  }));
  assert.deepEqual(indexed, bruteForceCandidates(omie, bank));
  ok("índice 1:1 produz os mesmos candidatos e a mesma ordem");
}

{
  const entries = [
    entry({
      id: "o-high",
      source_system: "omie",
      source_kind: "omie_receivable",
      direction: "credit",
      person_name: "CLIENTE ALFA LTDA",
      settled_amount_cents: 200000,
      settlement_date: "2026-03-10",
    }),
    entry({
      id: "b-high",
      source_system: "sicredi",
      source_kind: "bank_credit",
      direction: "credit",
      person_name: "CLIENTE ALFA",
      description: "CRED CLIENTE ALFA",
      gross_amount_cents: 200000,
      settlement_date: "2026-03-10",
    }),
    entry({
      id: "o-sug",
      source_system: "omie",
      source_kind: "omie_payable",
      direction: "debit",
      person_name: "FORNECEDOR BETA",
      settled_amount_cents: 80000,
      settlement_date: "2026-03-11",
    }),
    entry({
      id: "b-sug",
      source_system: "sicredi",
      source_kind: "bank_debit",
      direction: "debit",
      description: "PAGTO DIVERSO",
      gross_amount_cents: 80000,
      settlement_date: "2026-03-11",
    }),
    entry({
      id: "o-open",
      source_system: "omie",
      source_kind: "omie_receivable",
      direction: "credit",
      person_name: "CLIENTE GAMA",
      settled_amount_cents: 50000,
      settlement_date: "2026-03-20",
    }),
    entry({
      id: "b-open",
      source_system: "sicredi",
      source_kind: "bank_credit",
      direction: "credit",
      description: "CRED DESCONHECIDO",
      gross_amount_cents: 33000,
      settlement_date: "2026-03-21",
    }),
    entry({
      id: "o-c1",
      source_system: "omie",
      source_kind: "omie_receivable",
      direction: "credit",
      person_name: "LOTE C",
      settled_amount_cents: 10000,
      settlement_date: "2026-03-15",
    }),
    entry({
      id: "o-c2",
      source_system: "omie",
      source_kind: "omie_receivable",
      direction: "credit",
      person_name: "LOTE C",
      settled_amount_cents: 15000,
      settlement_date: "2026-03-15",
    }),
    entry({
      id: "b-c",
      source_system: "sicredi",
      source_kind: "bank_credit",
      direction: "credit",
      description: "CRED LOTE",
      gross_amount_cents: 25000,
      settlement_date: "2026-03-15",
    }),
  ];
  const full = reconcileOmieSicredi({
    entries,
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
  });
  const analysis = reconcileOmieSicredi({
    entries,
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    includePossibleAggregations: false,
    includeReportExtras: false,
  });
  const diagnostics = reconcileOmieSicredi({
    entries,
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    includePossibleAggregations: true,
    includeReportExtras: false,
  });
  assert.deepEqual(logicalCore(analysis), logicalCore(full));
  assert.deepEqual(logicalCore(diagnostics), logicalCore(full));
  assert.equal(analysis.findings.length, 0);
  assert.equal(analysis.samples.length, 0);
  assert.equal(analysis.possible_aggregations.length, 0);
  assert.deepEqual(diagnostics.possible_aggregations, full.possible_aggregations);
  const listsFull = buildAnalysisLists(full, entries);
  const listsAnalysis = buildAnalysisLists(analysis, entries);
  assert.equal(listsAnalysis.suggested.length, listsFull.suggested.length);
  assert.equal(listsAnalysis.ambiguous.length, listsFull.ambiguous.length);
  assert.equal(listsAnalysis.unmatched_omie.length, listsFull.unmatched_omie.length);
  assert.equal(listsAnalysis.unmatched_bank.length, listsFull.unmatched_bank.length);
  assert.equal(listsAnalysis.possible_aggregation.length, 0);
  assert.equal(listsFull.unmatched_omie.length, listsAnalysis.unmatched_omie.length);
  ok("analysis sem C/D/findings preserva suggested/ambiguous/unmatched");
}

{
  const outside = entry({
    id: "o-out",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "FORA",
    settled_amount_cents: 11100,
    settlement_date: "2025-12-31",
  });
  const inside = entry({
    id: "o-in",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "DENTRO",
    settled_amount_cents: 22200,
    settlement_date: "2026-02-01",
  });
  const result = reconcileOmieSicredi({
    entries: [outside, inside],
    periodStart: "2026-01-01",
    periodEnd: "2026-07-31",
  });
  assert.equal(result.stats.omie_ar_count, 1);
  assert.equal(result.stats.omie_ar_settled_cents, 22200);
  ok("filtro de período usa a mesma semântica V1.2 (string >= / <=)");
}

{
  const first = reconcileOmieSicredi({
    entries: [
      entry({
        id: "o-d",
        source_system: "omie",
        source_kind: "omie_receivable",
        direction: "credit",
        person_name: "DELTA",
        settled_amount_cents: 44000,
        settlement_date: "2026-04-01",
      }),
      entry({
        id: "b-d",
        source_system: "sicredi",
        source_kind: "bank_credit",
        direction: "credit",
        person_name: "DELTA",
        description: "CRED DELTA",
        gross_amount_cents: 44000,
        settlement_date: "2026-04-01",
      }),
    ],
    periodStart: "2026-01-01",
    periodEnd: "2026-07-31",
  });
  const second = reconcileOmieSicredi({
    entries: [
      entry({
        id: "b-d",
        source_system: "sicredi",
        source_kind: "bank_credit",
        direction: "credit",
        person_name: "DELTA",
        description: "CRED DELTA",
        gross_amount_cents: 44000,
        settlement_date: "2026-04-01",
      }),
      entry({
        id: "o-d",
        source_system: "omie",
        source_kind: "omie_receivable",
        direction: "credit",
        person_name: "DELTA",
        settled_amount_cents: 44000,
        settlement_date: "2026-04-01",
      }),
    ],
    periodStart: "2026-01-01",
    periodEnd: "2026-07-31",
  });
  assert.deepEqual(logicalCore(first), logicalCore(second));
  ok("determinismo: mesma entrada em ordem diferente");
}

console.log(`\n${passed} checks OK\n`);
