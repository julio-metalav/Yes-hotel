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
  OMIE_SICREDI_RULE_VERSION,
  compareFinancialParty,
  descriptionLooksLikeTransfer,
  findInternalTransferCandidates,
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

console.log("\n=== Omie ↔ Sicredi recon V1 ===\n");

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
  assert.match(text, /rule_version: omie_sicredi_v1/);
  assert.doesNotMatch(text, /CLIENTE SINTETICO/);
  assert.doesNotMatch(text, /52998224725/);
  assert.equal(reconReportLeaksPii(text), false);
  ok("dry-run sem PII");
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
