/**
 * Decisão humana de conciliação. Fixtures sintéticas. Sem I/O remoto. Sem PII real.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyReviewDecisions,
  buildConfirmMatchPlan,
  buildInternalTransferPlan,
  buildReviewOnlyPlan,
  collectConservativeCandidates,
  explainEvidence,
  isDecideAction,
  reconcileOmieSicredi,
  sameDecision,
  suggestedReviewKey,
  uiStatusLabel,
  unmatchedReviewKey,
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
    account_id: null,
    account_code: partial.account_code ?? null,
    source_import_id: "imp-1",
    source_record_id: null,
    person_name: partial.person_name ?? null,
    description: partial.description ?? null,
    gross_amount_cents: partial.gross_amount_cents ?? null,
    settled_amount_cents: partial.settled_amount_cents ?? null,
    open_amount_cents: 0,
    settlement_date: partial.settlement_date ?? "2026-03-10",
    ...partial,
  };
}

console.log("\n=== Decisão humana Omie ↔ Sicredi ===\n");

{
  assert.equal(isDecideAction("confirm_match"), true);
  assert.equal(isDecideAction("analysis"), false);
  assert.equal(uiStatusLabel("confirmed"), "human_confirmed");
  assert.equal(uiStatusLabel("auto_matched"), "auto_matched");
  assert.equal(uiStatusLabel("rejected"), "human_rejected");
  ok("actions e labels de status sem reinterpretar auto_matched");
}

{
  assert.equal(
    explainEvidence(93, { amount_exact: true, date_distance_days: 0, party_match: "token_exact" }),
    "Valor exato, mesma data e nome compatível",
  );
  assert.equal(
    explainEvidence(75, { amount_exact: true, date_distance_days: 0, party_match: "no_match" }),
    "Valor e data coincidem; nome não confirmado",
  );
  ok("evidência traduzida sem score cru");
}

const omie = entry({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  source_system: "omie",
  source_kind: "omie_receivable",
  direction: "credit",
  person_name: "HOTEL YES CENTRO ALFA",
  settled_amount_cents: 150000,
  settlement_date: "2026-03-10",
});
const bank = entry({
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  source_system: "sicredi",
  source_kind: "bank_credit",
  direction: "credit",
  account_code: "sicredi_principal",
  description: "YES CENTRO ALFA",
  gross_amount_cents: 150000,
  settlement_date: "2026-03-10",
});
const nearBank = entry({
  id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  source_system: "sicredi",
  source_kind: "bank_credit",
  direction: "credit",
  account_code: "sicredi_principal",
  description: "YES CENTRO ALFA",
  gross_amount_cents: 151000,
  settlement_date: "2026-03-10",
});

{
  const plan = buildConfirmMatchPlan({
    review_type: "suggested",
    omie,
    bank,
    used_entry_ids: new Set(),
    existing_group_keys: new Set(),
    existing_review_keys: new Set(),
  });
  assert.equal(plan.group_status, "confirmed");
  assert.equal(plan.match_method, "one_to_one");
  assert.equal(plan.confidence, 93);
  assert.equal(plan.review_key, suggestedReviewKey(omie.id, bank.id));
  assert.throws(
    () =>
      buildConfirmMatchPlan({
        review_type: "suggested",
        omie,
        bank,
        used_entry_ids: new Set([omie.id]),
        existing_group_keys: new Set(),
        existing_review_keys: new Set(),
      }),
    /já pertence/,
  );
  assert.throws(
    () =>
      buildConfirmMatchPlan({
        review_type: "unmatched_omie",
        omie,
        bank: nearBank,
        used_entry_ids: new Set(),
        existing_group_keys: new Set(),
        existing_review_keys: new Set(),
      }),
    /valor exato/,
  );
  ok("admin confirma suggested; entry usada e valor próximo bloqueiam");
}

{
  const reject = buildReviewOnlyPlan({
    action: "reject_suggestion",
    review_type: "suggested",
    omie_entry_id: omie.id,
    bank_entry_id: bank.id,
  });
  assert.equal(reject.status, "rejected");
  const lists = applyReviewDecisions(
    {
      suggested: [{ id: "s1", amount_cents: 150000, omie_entry_id: omie.id, bank_entry_id: bank.id }],
      ambiguous: [],
      unmatched_omie: [],
      unmatched_bank: [],
      possible_aggregation: [],
    },
    [
      {
        review_key: reject.review_key,
        review_type: "suggested",
        status: "rejected",
        action: "reject_suggestion",
        omie_entry_id: omie.id,
        bank_entry_id: bank.id,
        candidate_entry_ids: [],
        resulting_group_id: null,
      },
    ],
  );
  assert.equal(lists.suggested.length, 0);
  assert.equal(sameDecision({ ...reject, resulting_group_id: null }, reject), true);
  ok("rejeitar suggested impede reaparecer; idempotência da mesma decisão");
}

{
  const none = buildReviewOnlyPlan({
    action: "reject_ambiguous",
    review_type: "ambiguous",
    omie_entry_id: omie.id,
    candidate_entry_ids: [bank.id, nearBank.id],
  });
  const lists = applyReviewDecisions(
    {
      suggested: [],
      ambiguous: [{ id: "a1", amount_cents: 150000, omie_entry_id: omie.id, bank_entry_id: bank.id }],
      unmatched_omie: [],
      unmatched_bank: [],
      possible_aggregation: [],
    },
    [
      {
        review_key: none.review_key,
        review_type: "ambiguous",
        status: "rejected",
        action: "reject_ambiguous",
        omie_entry_id: omie.id,
        bank_entry_id: null,
        candidate_entry_ids: [bank.id, nearBank.id],
        resulting_group_id: null,
      },
    ],
  );
  assert.equal(lists.ambiguous.length, 0);
  ok("ambiguous nenhum destes some da fila");
}

{
  const keep = buildReviewOnlyPlan({
    action: "mark_unmatched",
    review_type: "unmatched_omie",
    omie_entry_id: omie.id,
  });
  assert.equal(keep.status, "kept_unmatched");
  assert.equal(keep.review_key, unmatchedReviewKey(omie.id));
  const candidates = collectConservativeCandidates(omie, [bank, nearBank]);
  assert.equal(candidates.some((row) => row.entry_id === bank.id && row.amount_exact), true);
  assert.equal(candidates.some((row) => row.entry_id === nearBank.id && row.diagnostic_only), true);
  ok("unmatched: valor exato matchável; próximo só diagnóstico");
}

{
  const debit = entry({
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
    source_system: "sicredi",
    source_kind: "bank_debit",
    direction: "debit",
    account_code: "sicredi_principal",
    description: "TRANSF",
    gross_amount_cents: 5000,
    settlement_date: "2026-03-10",
  });
  const credit = entry({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
    source_system: "sicredi",
    source_kind: "bank_credit",
    direction: "credit",
    account_code: "sicredi_0911",
    description: "TRANSF",
    gross_amount_cents: 5000,
    settlement_date: "2026-03-10",
  });
  const plan = buildInternalTransferPlan({
    debit,
    credit,
    pool: [debit, credit],
    used_entry_ids: new Set(),
    existing_group_keys: new Set(),
  });
  assert.equal(plan.match_method, "internal_transfer");
  assert.equal(plan.group_status, "confirmed");
  ok("transferência interna só se a regra high autorizar");
}

{
  const result = reconcileOmieSicredi({ entries: [omie, bank] });
  assert.equal(result.stats.high_count, 1);
  assert.equal(result.groups[0]?.status, "auto_matched");
  ok("601-equivalente: high automático continua auto_matched; confirmação humana usa confirmed");
}

{
  const sql = readFileSync(join(root, "supabase/migrations/20260815020822_financial_reconciliation_reviews.sql"), "utf8");
  assert.match(sql, /create table if not exists public\.financial_reconciliation_reviews/);
  assert.match(sql, /unique \(review_key\)/);
  assert.match(sql, /grant select, insert on public.financial_reconciliation_reviews to service_role/);
  assert.doesNotMatch(sql, /grant select, insert, update, delete on public.financial_reconciliation_reviews/);
  assert.match(sql, /revoke insert, update, delete, truncate/);
  const decide = readFileSync(join(root, "supabase/functions/financial-recon-decide/index.ts"), "utf8");
  assert.match(decide, /ensureAdminCaller/);
  assert.match(decide, /Acesso restrito a admin/);
  assert.doesNotMatch(decide, /body\.actor_user_id/);
  assert.doesNotMatch(decide, /body\.score/);
  assert.doesNotMatch(decide, /raw_payload/);
  assert.match(decide, /financial_entries_updated: false/);
  ok("migration append-only; actor/score no servidor; sem PII");
}

console.log(`\n${passed} testes ok\n`);
