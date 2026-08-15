/**
 * Revisão financeira Omie ↔ Sicredi (PR F).
 * DTO sanitizado, KPIs, paginação, engine read-only. Sem I/O remoto.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OMIE_SICREDI_RULE_VERSION,
  assertReviewDtoSafe,
  buildAnalysisLists,
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
  summarizeScoreEvidence,
  type ReconEntry,
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
  assert.ok((kpis.unmatched_omie_count ?? 0) >= 1);
  assertReviewDtoSafe({ lists, kpis });
  ok("suggested/ambiguous/unmatched read-only via engine");
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
  ok("edge function admin-only, read-only, reutiliza engine");
}

console.log(`\n${passed} checks OK\n`);
