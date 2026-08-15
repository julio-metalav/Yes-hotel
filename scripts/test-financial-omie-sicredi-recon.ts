/**
 * Reconciliação Omie ↔ Sicredi V1. Fixtures sintéticas. Sem I/O remoto. Sem PII real.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreEvidenceIsStructured } from "../src/lib/financial/index.ts";
import {
  GROUPING_MAX_CANDIDATES,
  OMIE_SICREDI_RULE_VERSION,
  compareFinancialParty,
  descriptionLooksLikeTransfer,
  findInternalTransferCandidates,
  findUniqueSubset,
  formatOmieSicrediDryRun,
  normalizeFinancialPartyName,
  reconReportLeaksPii,
  reconcileOmieSicredi,
  scoreOmieBankPair,
  type ReconEntry,
} from "../src/lib/financial/reconciliation/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function entry(partial: Partial<ReconEntry> & Pick<ReconEntry, "id" | "source_system" | "source_kind" | "direction">): ReconEntry {
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

console.log("\n=== Omie ↔ Sicredi recon V1.2 ===\n");

{
  assert.equal(normalizeFinancialPartyName("  João da Silva Ltda. "), "JOAO DA SILVA");
  assert.equal(normalizeFinancialPartyName("ACME S/A"), "ACME");
  assert.equal(normalizeFinancialPartyName("ACME S.A."), "ACME");
  assert.equal(normalizeFinancialPartyName("BETA ME"), "BETA");
  assert.equal(normalizeFinancialPartyName("GAMA EIRELI"), "GAMA");
  assert.equal(compareFinancialParty("João da Silva Ltda", "JOAO DA SILVA"), "exact_normalized");
  assert.equal(compareFinancialParty("Hotel Yes Centro", "YES CENTRO"), "token_exact");
  assert.equal(compareFinancialParty("ALFAFORNECEDOR", "PAGTO ALFAFORNECEDOR REF"), "contains_safe");
  assert.equal(compareFinancialParty("ALFA", "BETA"), "no_match");
  ok("normalização e comparação de nomes");
}

{
  const omie = entry({
    id: "o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE SINTETICO LTDA",
    settled_amount_cents: 125000,
    gross_amount_cents: 125000,
    settlement_date: "2026-03-10",
  });
  const bank = entry({
    id: "b1",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    person_name: null,
    description: "CLIENTE SINTETICO LTDA",
    gross_amount_cents: 125000,
    source_record_id: "FITID-AR-1",
    settlement_date: "2026-03-10",
  });
  const scored = scoreOmieBankPair(omie, bank);
  assert.ok(scored);
  assert.equal(scored.score, 100);
  assert.equal(scored.partyMatch, "exact_normalized");
  const result = reconcileOmieSicredi({ entries: [omie, bank] });
  assert.equal(result.stats.high_count, 1);
  assert.equal(result.stats.high_cents, 125000);
  assert.equal(result.groups[0]?.status, "auto_matched");
  assert.equal(result.groups[0]?.rule_version, OMIE_SICREDI_RULE_VERSION);
  assert.equal(scoreEvidenceIsStructured(result.groups[0]!.score_evidence), true);
  assert.equal(result.groups[0]!.score_evidence.amount_exact, true);
  assert.equal(result.groups[0]!.score_evidence.candidate_count, 1);
  ok("AR ↔ crédito exato mesmo dia");
}

{
  const omie = entry({
    id: "o2",
    source_system: "omie",
    source_kind: "omie_payable",
    direction: "debit",
    person_name: "FORNECEDOR SINTETICO",
    settled_amount_cents: 80000,
    gross_amount_cents: 80000,
    settlement_date: "2026-03-11",
  });
  const bank = entry({
    id: "b2",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "PAGTO FORNECEDOR SINTETICO",
    gross_amount_cents: 80000,
    source_record_id: "FITID-AP-1",
    settlement_date: "2026-03-11",
  });
  const result = reconcileOmieSicredi({ entries: [omie, bank] });
  assert.equal(result.stats.high_count, 1);
  assert.equal(result.groups[0]?.score_evidence.direction_match, true);
  ok("AP ↔ débito exato mesmo dia");
}

{
  const omie = entry({
    id: "o3",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE DELTA",
    settled_amount_cents: 50000,
    settlement_date: "2026-04-01",
  });
  const d1 = entry({
    id: "b3",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE DELTA",
    gross_amount_cents: 50000,
    settlement_date: "2026-04-02",
  });
  const r1 = reconcileOmieSicredi({ entries: [omie, d1] });
  assert.equal(r1.stats.high_count, 1);
  assert.equal(r1.groups[0]?.confidence, 93);
  const d2 = { ...d1, id: "b3b", settlement_date: "2026-04-03" };
  const r2 = reconcileOmieSicredi({ entries: [omie, d2] });
  assert.equal(r2.stats.suggested_count, 1);
  assert.equal(r2.groups[0]?.confidence, 85);
  ok("D+1 high; D+2 suggested");
}

{
  const omie = entry({
    id: "o4",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "NOME A",
    settled_amount_cents: 33000,
    settlement_date: "2026-05-01",
  });
  const bank = entry({
    id: "b4",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "PIX AVULSO",
    gross_amount_cents: 33000,
    settlement_date: "2026-05-01",
  });
  const result = reconcileOmieSicredi({ entries: [omie, bank] });
  assert.equal(result.stats.suggested_count, 1);
  assert.equal(result.groups[0]?.confidence, 75);
  ok("valor+data sem nome → suggested 75");
}

{
  const omie = entry({
    id: "o5",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "NOME B",
    settled_amount_cents: 21000,
    settlement_date: "2026-05-01",
  });
  const bank = entry({
    id: "b5",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "PIX AVULSO 2",
    gross_amount_cents: 21000,
    settlement_date: "2026-05-02",
  });
  const result = reconcileOmieSicredi({ entries: [omie, bank] });
  assert.equal(result.stats.high_count, 0);
  assert.equal(result.stats.suggested_count, 0);
  assert.equal(result.stats.omie_ar_unmatched_count, 1);
  ok("D+1 sem nome não reconcilia");
}

{
  const omie = entry({
    id: "o6",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE GAMA",
    settled_amount_cents: 90000,
    settlement_date: "2026-06-01",
  });
  const b1 = entry({
    id: "b6a",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE GAMA",
    gross_amount_cents: 90000,
    settlement_date: "2026-06-01",
  });
  const b2 = { ...b1, id: "b6b", source_record_id: "FITID-DUP" };
  const result = reconcileOmieSicredi({ entries: [omie, b1, b2] });
  assert.equal(result.stats.ambiguous_count, 1);
  assert.equal(result.stats.high_count, 0);
  assert.ok(result.findings.some((f) => f.finding_type === "duplicate_possible" && f.note === "ambiguous_match"));
  ok("dois candidatos iguais → ambiguous");
}

{
  const debit = entry({
    id: "t-d",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "TRANSFERENCIA ENTRE CONTAS",
    gross_amount_cents: 150000,
    settlement_date: "2026-02-10",
    source_record_id: "FITID-TR-D",
  });
  const credit = entry({
    id: "t-c",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_0911",
    description: "PIX TRANSFERENCIA",
    gross_amount_cents: 150000,
    settlement_date: "2026-02-10",
    source_record_id: "FITID-TR-C",
  });
  assert.equal(descriptionLooksLikeTransfer(debit.description), true);
  const pairs = findInternalTransferCandidates([debit, credit]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.confidence, "high");
  const omie = entry({
    id: "o-tr",
    source_system: "omie",
    source_kind: "omie_payable",
    direction: "debit",
    person_name: "NAO USAR TRANSF",
    settled_amount_cents: 150000,
    settlement_date: "2026-02-10",
  });
  const result = reconcileOmieSicredi({ entries: [debit, credit, omie] });
  assert.equal(result.stats.transfer_high_count, 1);
  assert.equal(result.stats.high_count, 0);
  assert.ok(result.findings.some((f) => f.finding_type === "internal_transfer"));
  assert.equal(result.stats.omie_ap_unmatched_count, 1);
  ok("transferência principal→0911 excluída do match Omie");
}

{
  const debit = entry({
    id: "t2-d",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_0911",
    description: "TED TRANSF",
    gross_amount_cents: 70000,
    settlement_date: "2026-02-11",
  });
  const credit = entry({
    id: "t2-c",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "TRANSFERENCIA",
    gross_amount_cents: 70000,
    settlement_date: "2026-02-12",
  });
  const result = reconcileOmieSicredi({ entries: [debit, credit] });
  assert.equal(result.stats.transfer_high_count, 1);
  assert.equal(result.transfers[0]?.date_distance_days, 1);
  ok("transferência 0911→principal D+1");
}

{
  const debit = entry({
    id: "t3-d",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "PIX TRANSF",
    gross_amount_cents: 40000,
    settlement_date: "2026-02-15",
  });
  const c1 = entry({
    id: "t3-c1",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_0911",
    description: "PIX TRANSF",
    gross_amount_cents: 40000,
    settlement_date: "2026-02-15",
  });
  const c2 = { ...c1, id: "t3-c2" };
  const result = reconcileOmieSicredi({ entries: [debit, c1, c2] });
  assert.ok(result.stats.transfer_ambiguous_count >= 1);
  assert.equal(result.stats.transfer_high_count, 0);
  ok("transferência ambígua com duas contrapartes");
}

{
  const o1 = entry({
    id: "agg-o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE LOTE",
    settled_amount_cents: 10000,
    settlement_date: "2026-07-01",
  });
  const o2 = { ...o1, id: "agg-o2", settled_amount_cents: 15000 };
  const bank = entry({
    id: "agg-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE LOTE",
    gross_amount_cents: 25000,
    settlement_date: "2026-07-01",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, bank] });
  assert.equal(result.stats.aggregation_count, 1);
  assert.equal(result.stats.aggregation_cents, 25000);
  assert.ok(result.findings.some((f) => f.finding_type === "payment_aggregation"));
  ok("2 Omie → 1 banco");
}

{
  const omie = entry({
    id: "one-o",
    source_system: "omie",
    source_kind: "omie_payable",
    direction: "debit",
    person_name: "FORN SPLIT",
    settled_amount_cents: 60000,
    settlement_date: "2026-07-02",
  });
  const b1 = entry({
    id: "one-b1",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "FORN SPLIT",
    gross_amount_cents: 30000,
    settlement_date: "2026-07-02",
  });
  const b2 = { ...b1, id: "one-b2" };
  const result = reconcileOmieSicredi({ entries: [omie, b1, b2] });
  assert.equal(result.stats.aggregation_count, 0);
  assert.equal(result.stats.high_count, 0);
  assert.equal(result.stats.omie_ap_unmatched_count, 1);
  ok("1 Omie → múltiplos banco permanece conservador");
}

{
  const omie = entry({
    id: "u-o",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "SEM BANCO",
    settled_amount_cents: 11111,
    settlement_date: "2026-03-01",
  });
  const bank = entry({
    id: "u-b",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "OUTRO",
    gross_amount_cents: 22222,
    settlement_date: "2026-03-01",
  });
  const result = reconcileOmieSicredi({ entries: [omie, bank] });
  assert.equal(result.stats.omie_ar_unmatched_count, 1);
  assert.equal(result.stats.bank_debit_unmatched_count, 1);
  assert.ok(result.findings.some((f) => f.finding_type === "omie_without_bank"));
  assert.ok(result.findings.some((f) => f.finding_type === "bank_without_omie"));
  ok("unmatched Omie e banco");
}

{
  const omie = entry({
    id: "p-o",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "PARCIAL",
    settled_amount_cents: 40000,
    open_amount_cents: 10000,
    gross_amount_cents: 50000,
    settlement_date: "2026-03-20",
  });
  const bank = entry({
    id: "p-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "PARCIAL",
    gross_amount_cents: 40000,
    settlement_date: "2026-03-20",
  });
  const result = reconcileOmieSicredi({ entries: [omie, bank] });
  assert.equal(result.stats.high_count, 1);
  assert.ok(result.findings.some((f) => f.finding_type === "partial_payment"));
  ok("partial_payment quando open > 0");
}

{
  const omie = entry({
    id: "vm-o",
    source_system: "omie",
    source_kind: "omie_payable",
    direction: "debit",
    person_name: "FORNECEDOR MISMATCH",
    settled_amount_cents: 99000,
    settlement_date: "2026-03-21",
  });
  const bank = entry({
    id: "vm-b",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "FORNECEDOR MISMATCH",
    gross_amount_cents: 88000,
    settlement_date: "2026-03-21",
  });
  const result = reconcileOmieSicredi({ entries: [omie, bank] });
  assert.equal(result.stats.high_count, 0);
  assert.ok(result.findings.some((f) => f.finding_type === "value_mismatch"));
  ok("value_mismatch com identidade forte e valor diferente");
}

{
  const omie = entry({
    id: "det-o",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "DET",
    settled_amount_cents: 1000,
    settlement_date: "2026-01-15",
  });
  const bank = entry({
    id: "det-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "DET",
    gross_amount_cents: 1000,
    settlement_date: "2026-01-15",
  });
  const a = reconcileOmieSicredi({ entries: [omie, bank] });
  const b = reconcileOmieSicredi({ entries: [bank, omie] });
  assert.deepEqual(a.stats, b.stats);
  assert.deepEqual(
    a.groups.map((g) => g.id),
    b.groups.map((g) => g.id),
  );
  assert.deepEqual(
    a.findings.map((f) => f.id),
    b.findings.map((f) => f.id),
  );
  ok("determinismo e idempotência lógica");
}

{
  const result = reconcileOmieSicredi({
    entries: [
      entry({
        id: "rep-o",
        source_system: "omie",
        source_kind: "omie_receivable",
        direction: "credit",
        person_name: "CLIENTE SINTETICO",
        settled_amount_cents: 1000,
        settlement_date: "2026-01-02",
      }),
    ],
  });
  const text = formatOmieSicrediDryRun(result);
  assert.match(text, /rule_version: omie_sicredi_v1\.2/);
  assert.doesNotMatch(text, /CLIENTE SINTETICO/);
  assert.doesNotMatch(text, /52998224725/);
  assert.equal(reconReportLeaksPii(text), false);
  ok("dry-run sem PII");
}

{
  const debit = entry({
    id: "nk-d",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "MOVIMENTO INTERNO",
    gross_amount_cents: 88000,
    settlement_date: "2026-02-20",
  });
  const credit = entry({
    id: "nk-c",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_0911",
    description: "CREDITO CONTA",
    gross_amount_cents: 88000,
    settlement_date: "2026-02-20",
  });
  const result = reconcileOmieSicredi({ entries: [debit, credit] });
  assert.equal(result.stats.transfer_high_count, 1);
  assert.equal(result.transfers[0]?.score_evidence.memo_transfer_signal, false);
  assert.equal(result.transfers[0]?.score_evidence.unique_counterpart, true);
  ok("transferência high sem keyword no MEMO");
}

{
  const debit = entry({
    id: "nk2-d",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "MOVIMENTO A",
    gross_amount_cents: 44000,
    settlement_date: "2026-02-21",
  });
  const c1 = entry({
    id: "nk2-c1",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_0911",
    description: "MOVIMENTO B",
    gross_amount_cents: 44000,
    settlement_date: "2026-02-21",
  });
  const c2 = { ...c1, id: "nk2-c2", description: "MOVIMENTO C" };
  const result = reconcileOmieSicredi({ entries: [debit, c1, c2] });
  assert.equal(result.stats.transfer_high_count, 0);
  assert.ok(result.stats.transfer_ambiguous_count >= 1);
  ok("transferência sem keyword com 2 candidatos → ambiguous");
}

{
  const o1 = entry({
    id: "mix-o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE A",
    settled_amount_cents: 10000,
    settlement_date: "2026-07-10",
  });
  const o2 = entry({
    id: "mix-o2",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE B",
    settled_amount_cents: 15000,
    settlement_date: "2026-07-10",
  });
  const bank = entry({
    id: "mix-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "LOTE DIA",
    gross_amount_cents: 25000,
    settlement_date: "2026-07-10",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, bank] });
  assert.equal(result.stats.aggregation_count, 0);
  assert.equal(result.stats.omie_ar_unmatched_count, 2);
  assert.equal(result.stats.bank_credit_unmatched_count, 1);
  assert.equal(result.stats.possible_agg_c_ar.unique_count, 1);
  assert.equal(result.stats.possible_agg_c_ar.omie_entries, 2);
  assert.equal(result.possible_aggregations[0]?.unique_combination, true);
  ok("2 AR pessoas diferentes → diagnóstico C, sem match oficial");
}

{
  const rows = [1, 2, 3].map((n) =>
    entry({
      id: `three-o${n}`,
      source_system: "omie",
      source_kind: "omie_receivable",
      direction: "credit",
      person_name: "CLIENTE TRIO",
      settled_amount_cents: 10000 * n,
      settlement_date: "2026-07-11",
    }),
  );
  const bank = entry({
    id: "three-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE TRIO",
    gross_amount_cents: 60000,
    settlement_date: "2026-07-11",
  });
  const result = reconcileOmieSicredi({ entries: [...rows, bank] });
  assert.equal(result.stats.aggregation_count, 1);
  assert.equal(result.stats.aggregation_entries, 3);
  ok("3 AR → 1 crédito");
}

{
  const o1 = entry({
    id: "apg-o1",
    source_system: "omie",
    source_kind: "omie_payable",
    direction: "debit",
    person_name: "FORN LOTE",
    settled_amount_cents: 30000,
    settlement_date: "2026-07-12",
  });
  const o2 = { ...o1, id: "apg-o2", settled_amount_cents: 20000 };
  const bank = entry({
    id: "apg-b",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "FORN LOTE",
    gross_amount_cents: 50000,
    settlement_date: "2026-07-12",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, bank] });
  assert.equal(result.stats.aggregation_ap_count, 1);
  assert.equal(result.stats.aggregation_ap_cents, 50000);
  ok("2 AP → 1 débito");
}

{
  const o1 = entry({
    id: "win-o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE JANELA",
    settled_amount_cents: 12000,
    settlement_date: "2026-07-13",
  });
  const o2 = { ...o1, id: "win-o2", settled_amount_cents: 8000, settlement_date: "2026-07-14" };
  const bank = entry({
    id: "win-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE JANELA",
    gross_amount_cents: 20000,
    settlement_date: "2026-07-14",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, bank] });
  assert.equal(result.stats.aggregation_count, 1);
  assert.equal(result.groups.find((g) => g.kind === "many_to_one")?.score_evidence.grouping_layer, "person_window");
  ok("grupo N:1 em janela D+1");
}

{
  const o1 = entry({
    id: "ambg-o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE AMB",
    settled_amount_cents: 10000,
    settlement_date: "2026-07-15",
  });
  const o2 = { ...o1, id: "ambg-o2" };
  const o3 = { ...o1, id: "ambg-o3" };
  const bank = entry({
    id: "ambg-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE AMB",
    gross_amount_cents: 20000,
    settlement_date: "2026-07-15",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, o3, bank] });
  assert.equal(result.stats.aggregation_count, 0);
  assert.ok(result.stats.ambiguous_count >= 1);
  ok("duas combinações possíveis → ambiguous");
}

{
  const rows = Array.from({ length: 9 }, (_, i) =>
    entry({
      id: `n9-o${i}`,
      source_system: "omie",
      source_kind: "omie_receivable",
      direction: "credit",
      person_name: "CLIENTE NOVE",
      settled_amount_cents: 1000,
      settlement_date: "2026-07-16",
    }),
  );
  const bank = entry({
    id: "n9-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE NOVE",
    gross_amount_cents: 9000,
    settlement_date: "2026-07-16",
  });
  const result = reconcileOmieSicredi({ entries: [...rows, bank] });
  assert.equal(result.stats.aggregation_count, 0);
  ok("N > 8 não agrupa a soma total");
}

{
  const omieHigh = entry({
    id: "reuse-o",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE REUSO",
    settled_amount_cents: 50000,
    settlement_date: "2026-07-17",
  });
  const extra = { ...omieHigh, id: "reuse-o2", settled_amount_cents: 20000, person_name: "OUTRO REUSO" };
  const bankHigh = entry({
    id: "reuse-bh",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE REUSO",
    gross_amount_cents: 50000,
    settlement_date: "2026-07-17",
  });
  const bankLot = entry({
    id: "reuse-bl",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "LOTE",
    gross_amount_cents: 70000,
    settlement_date: "2026-07-17",
  });
  const result = reconcileOmieSicredi({ entries: [omieHigh, extra, bankHigh, bankLot] });
  assert.equal(result.stats.high_count, 1);
  assert.equal(result.stats.aggregation_count, 0);
  ok("entry já usada em high não é reutilizada no N:1");
}

{
  const o1 = entry({
    id: "cent-o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE CENT",
    settled_amount_cents: 10000,
    settlement_date: "2026-07-18",
  });
  const o2 = { ...o1, id: "cent-o2", settled_amount_cents: 10001 };
  const bank = entry({
    id: "cent-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE CENT",
    gross_amount_cents: 20000,
    settlement_date: "2026-07-18",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, bank] });
  assert.equal(result.stats.aggregation_count, 0);
  ok("lote com centavo diferente não agrupa");
}

{
  const pool = Array.from({ length: GROUPING_MAX_CANDIDATES + 1 }, (_, i) =>
    entry({
      id: `lim-o${i}`,
      source_system: "omie",
      source_kind: "omie_receivable",
      direction: "credit",
      person_name: "LIMITE",
      settled_amount_cents: 100,
      settlement_date: "2026-07-19",
    }),
  );
  const search = findUniqueSubset(pool, 200);
  assert.equal(search.status, "limit");
  if (search.status === "limit") assert.equal(search.reason, "candidates");
  const again = findUniqueSubset(pool, 200);
  assert.deepEqual(search, again);
  ok("limite de busca de agrupamento");
}

{
  const o1 = entry({
    id: "steal-c-o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE SUG",
    settled_amount_cents: 10000,
    settlement_date: "2026-07-20",
  });
  const o2 = entry({
    id: "steal-c-o2",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "OUTRO LOTE",
    settled_amount_cents: 15000,
    settlement_date: "2026-07-20",
  });
  const bankSug = entry({
    id: "steal-c-bs",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "PIX AVULSO",
    gross_amount_cents: 10000,
    settlement_date: "2026-07-20",
  });
  const bankLot = entry({
    id: "steal-c-bl",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "LOTE DIA",
    gross_amount_cents: 25000,
    settlement_date: "2026-07-20",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, bankSug, bankLot] });
  assert.equal(result.stats.suggested_count, 1);
  assert.equal(result.stats.aggregation_count, 0);
  assert.equal(result.groups[0]?.omie_entry_ids.includes("steal-c-o1"), true);
  assert.equal(result.stats.omie_ar_unmatched_count, 1);
  ok("1:1 suggested existente não é roubado por lote C");
}

{
  const o1 = entry({
    id: "steal-d-o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE SUG D",
    settled_amount_cents: 10000,
    settlement_date: "2026-07-21",
  });
  const o2 = entry({
    id: "steal-d-o2",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "OUTRO D1",
    settled_amount_cents: 8000,
    settlement_date: "2026-07-22",
  });
  const bankSug = entry({
    id: "steal-d-bs",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "PIX AVULSO D",
    gross_amount_cents: 10000,
    settlement_date: "2026-07-21",
  });
  const bankLot = entry({
    id: "steal-d-bl",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "LOTE D1",
    gross_amount_cents: 18000,
    settlement_date: "2026-07-22",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, bankSug, bankLot] });
  assert.equal(result.stats.suggested_count, 1);
  assert.equal(result.stats.aggregation_count, 0);
  assert.equal(result.stats.omie_ar_unmatched_count, 1);
  ok("1:1 suggested existente não é roubado por lote D");
}

{
  const o1 = entry({
    id: "cd-o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "LOTE C1",
    settled_amount_cents: 4000,
    settlement_date: "2026-07-23",
  });
  const o2 = entry({
    id: "cd-o2",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "LOTE C2",
    settled_amount_cents: 6000,
    settlement_date: "2026-07-23",
  });
  const bank = entry({
    id: "cd-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "DEPOSITO LOTE",
    gross_amount_cents: 10000,
    settlement_date: "2026-07-23",
  });
  const beforeUnmatched = 3;
  const result = reconcileOmieSicredi({ entries: [o1, o2, bank] });
  assert.equal(result.stats.aggregation_count, 0);
  assert.equal(result.groups.filter((g) => g.kind === "many_to_one").length, 0);
  assert.equal(result.stats.omie_ar_unmatched_count + result.stats.bank_credit_unmatched_count, beforeUnmatched);
  assert.equal(result.possible_aggregations.some((row) => row.unique_combination && row.date_window === "same_day"), true);
  ok("C/D somente diagnóstico e não consome entries");
}

{
  const o1 = entry({
    id: "amb1-o",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "CLIENTE AMB1",
    settled_amount_cents: 77000,
    settlement_date: "2026-07-24",
  });
  const b1 = entry({
    id: "amb1-b1",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "CLIENTE AMB1",
    gross_amount_cents: 77000,
    settlement_date: "2026-07-24",
  });
  const b2 = { ...b1, id: "amb1-b2" };
  const result = reconcileOmieSicredi({ entries: [o1, b1, b2] });
  assert.equal(result.stats.suggested_count, 0);
  assert.equal(result.stats.high_count, 0);
  assert.equal(result.stats.omie_ar_unmatched_count, 1);
  assert.equal(result.stats.bank_credit_unmatched_count, 2);
  ok("ambiguous 1:1 não é consumido");
}

{
  const o1 = entry({
    id: "diag-ap-o1",
    source_system: "omie",
    source_kind: "omie_payable",
    direction: "debit",
    person_name: "FORN A",
    settled_amount_cents: 3000,
    settlement_date: "2026-07-25",
  });
  const o2 = entry({
    id: "diag-ap-o2",
    source_system: "omie",
    source_kind: "omie_payable",
    direction: "debit",
    person_name: "FORN B",
    settled_amount_cents: 7000,
    settlement_date: "2026-07-25",
  });
  const bank = entry({
    id: "diag-ap-b",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "LOTE AP",
    gross_amount_cents: 10000,
    settlement_date: "2026-07-25",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, bank] });
  assert.equal(result.stats.aggregation_ap_count, 0);
  assert.equal(result.stats.possible_agg_c_ap.unique_count, 1);
  assert.equal(result.stats.possible_agg_c_ap.amount_cents, 10000);
  assert.equal(result.stats.omie_ap_unmatched_count, 2);
  ok("possible_aggregation report AP");
}

{
  const o1 = entry({
    id: "diag-d-o1",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "AR D1 A",
    settled_amount_cents: 5000,
    settlement_date: "2026-07-26",
  });
  const o2 = entry({
    id: "diag-d-o2",
    source_system: "omie",
    source_kind: "omie_receivable",
    direction: "credit",
    person_name: "AR D1 B",
    settled_amount_cents: 9000,
    settlement_date: "2026-07-27",
  });
  const bank = entry({
    id: "diag-d-b",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_principal",
    description: "LOTE D1 AR",
    gross_amount_cents: 14000,
    settlement_date: "2026-07-27",
  });
  const result = reconcileOmieSicredi({ entries: [o1, o2, bank] });
  assert.equal(result.stats.aggregation_count, 0);
  assert.equal(result.stats.possible_agg_d_ar.unique_count, 1);
  assert.equal(result.stats.possible_agg_c_ar.unique_count, 0);
  assert.equal(result.stats.omie_ar_unmatched_count, 2);
  ok("possible_aggregation report AR D+1");
}

{
  const a = findUniqueSubset(
    [
      entry({
        id: "det-s1",
        source_system: "omie",
        source_kind: "omie_receivable",
        direction: "credit",
        person_name: "DET SUB",
        settled_amount_cents: 100,
        settlement_date: "2026-07-28",
      }),
      entry({
        id: "det-s2",
        source_system: "omie",
        source_kind: "omie_receivable",
        direction: "credit",
        person_name: "DET SUB",
        settled_amount_cents: 200,
        settlement_date: "2026-07-28",
      }),
    ],
    300,
  );
  const b = findUniqueSubset(
    [
      entry({
        id: "det-s2",
        source_system: "omie",
        source_kind: "omie_receivable",
        direction: "credit",
        person_name: "DET SUB",
        settled_amount_cents: 200,
        settlement_date: "2026-07-28",
      }),
      entry({
        id: "det-s1",
        source_system: "omie",
        source_kind: "omie_receivable",
        direction: "credit",
        person_name: "DET SUB",
        settled_amount_cents: 100,
        settlement_date: "2026-07-28",
      }),
    ],
    300,
  );
  assert.equal(a.status, "unique");
  assert.deepEqual(a, b);
  ok("deterministic search sem timeout");
}

{
  const tmp = join(root, "tmp", "omie-sicredi-recon");
  mkdirSync(tmp, { recursive: true });
  const file = join(tmp, "entries.json");
  writeFileSync(
    file,
    JSON.stringify([
      entry({
        id: "cli-o",
        source_system: "omie",
        source_kind: "omie_receivable",
        direction: "credit",
        person_name: "CLIENTE SINTETICO",
        settled_amount_cents: 2500,
        settlement_date: "2026-01-03",
      }),
    ]),
  );
  const tsxCli = join(root, "node_modules/tsx/dist/cli.mjs");
  const dry = spawnSync(
    process.execPath,
    [tsxCli, "scripts/reconcile-financial-omie-sicredi.ts", "--from-json", file, "--dry-run"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.match(dry.stdout, /persistido: NÃO/);
  const persist = spawnSync(
    process.execPath,
    [tsxCli, "scripts/reconcile-financial-omie-sicredi.ts", "--from-json", file, "--persist"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(persist.status, 0);
  assert.match(persist.stderr + persist.stdout, /Persistência recusada/i);
  ok("CLI dry-run; persistência recusada");
}

console.log(`\n${passed} testes ok\n`);
