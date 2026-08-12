/**
 * Provenance FNRH v2 no confirm + lock pós-confirmação vs HITS.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildConfirmFieldProvenance,
  isFnrhLockedAgainstHitsPrefill,
  mergeFieldProvenance,
  preferFieldOrigin,
  shouldApplySuggestedValue,
} from "../src/lib/domain/yes-hotel/fnrh-field-provenance.ts";

const KEYS = [
  "hospede_nome",
  "documento_numero",
  "email",
  "telefone",
  "cep",
] as const;

function ok(label: string) {
  console.log(`  ok — ${label}`);
}

// 1. HITS preenche nome → provenance hits
{
  const merged = mergeFieldProvenance({}, { hospede_nome: "hits" });
  assert.equal(merged.hospede_nome, "hits");
  ok("1. HITS preenche nome → hits");
}

// 2. OCR preenche documento → ocr
{
  const merged = mergeFieldProvenance({ hospede_nome: "hits" }, { documento_numero: "ocr" });
  assert.equal(merged.documento_numero, "ocr");
  assert.equal(merged.hospede_nome, "hits");
  ok("2. OCR preenche documento → ocr");
}

// 3. usuário corrige nome → manual
{
  const finalMap = buildConfirmFieldProvenance({
    existing: { hospede_nome: "hits", documento_numero: "ocr" },
    previousValues: { hospede_nome: "MARIA HITS", documento_numero: "123" },
    submittedBody: { hospede_nome: "Maria Corrigida", documento_numero: "123" },
    fieldKeys: KEYS,
  });
  assert.equal(finalMap.hospede_nome, "manual");
  assert.equal(finalMap.documento_numero, "ocr");
  ok("3. usuário corrige nome → manual");
}

// 4. confirm preserva manual
{
  const finalMap = buildConfirmFieldProvenance({
    existing: { hospede_nome: "manual", documento_numero: "ocr" },
    previousValues: { hospede_nome: "Maria", documento_numero: "123" },
    submittedBody: { hospede_nome: "Maria", documento_numero: "123" },
    fieldKeys: KEYS,
  });
  assert.equal(finalMap.hospede_nome, "manual");
  ok("4. confirm preserva manual");
}

// 5. confirm preserva ocr em campo não alterado
{
  const finalMap = buildConfirmFieldProvenance({
    existing: { documento_numero: "ocr", hospede_nome: "hits" },
    previousValues: { documento_numero: "52998224725", hospede_nome: "ANA" },
    submittedBody: {
      documento_numero: "52998224725",
      hospede_nome: "ANA",
      email: "novo@example.com",
    },
    fieldKeys: KEYS,
  });
  assert.equal(finalMap.documento_numero, "ocr");
  assert.equal(finalMap.hospede_nome, "hits");
  assert.equal(finalMap.email, "manual");
  ok("5. confirm preserva ocr não alterado");
}

// 6. hits não sobrescreve manual
{
  assert.equal(preferFieldOrigin("manual", "hits"), "manual");
  assert.equal(
    shouldApplySuggestedValue({
      currentValue: "Manual",
      currentOrigin: "manual",
      suggestedOrigin: "hits",
    }),
    false,
  );
  const merged = mergeFieldProvenance({ hospede_nome: "manual" }, { hospede_nome: "hits" });
  assert.equal(merged.hospede_nome, "manual");
  ok("6. hits não sobrescreve manual");
}

// 7. FNRH confirmada não é atualizada depois por sync/prefill HITS
{
  assert.equal(
    isFnrhLockedAgainstHitsPrefill({ dataConfirmed: true, status: "rascunho" }),
    true,
  );
  assert.equal(
    isFnrhLockedAgainstHitsPrefill({
      dataConfirmed: false,
      status: "confirmado_hospede",
    }),
    true,
  );
  assert.equal(
    isFnrhLockedAgainstHitsPrefill({
      dataConfirmed: false,
      status: "rascunho",
      lifecycleStatus: "completed",
    }),
    true,
  );
  assert.equal(
    isFnrhLockedAgainstHitsPrefill({
      dataConfirmed: false,
      status: "rascunho",
      lifecycleStatus: "draft",
    }),
    false,
  );
  const getSrc = readFileSync(resolve("supabase/functions/fnrh-get/index.ts"), "utf8");
  assert.match(getSrc, /isFnrhLockedAgainstHitsPrefill/);
  const syncRepo = readFileSync(
    resolve("src/lib/infrastructure/supabase/yes-hotel/supabase-reservation-sync-repository.ts"),
    "utf8",
  );
  assert.doesNotMatch(syncRepo, /fnrh_hospedes/);
  ok("7. FNRH confirmada bloqueada contra HITS + sync sem fnrh_hospedes");
}

// 8. mapa final não fica vazio indevidamente
{
  const finalMap = buildConfirmFieldProvenance({
    existing: { hospede_nome: "hits", documento_numero: "ocr", cep: "manual" },
    previousValues: {
      hospede_nome: "ANA",
      documento_numero: "123",
      cep: "79002000",
    },
    submittedBody: {
      hospede_nome: "ANA",
      documento_numero: "123",
      cep: "79002000",
    },
    fieldKeys: KEYS,
  });
  assert.ok(Object.keys(finalMap).length >= 3);
  assert.notDeepEqual(finalMap, {});
  ok("8. mapa final não fica vazio");
}

// Edge confirm persiste field_provenance
{
  const submit = readFileSync(resolve("supabase/functions/fnrh-submit/index.ts"), "utf8");
  assert.match(submit, /buildConfirmFieldProvenance/);
  assert.match(submit, /field_provenance:\s*input\.fieldProvenance/);
  ok("confirm v2 persiste field_provenance");
}

// Painel: cabeçalho sem origem duplicada; Situação única
{
  const panel = readFileSync(resolve("ui/checkin-operacional-mvp.js"), "utf8");
  assert.match(panel, /ID \$\{idShort\}/);
  assert.match(panel, /Situação atual/);
  assert.match(panel, /buildOrigemComercialHtml/);
  assert.match(panel, /buildSituacaoAcaoTopoHtml/);
  ok("painel Ver: cabeçalho + Situação única + origem dedicada");
}

console.log("\nPASS test-fnrh-provenance-confirm\n");
