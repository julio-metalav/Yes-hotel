/**
 * Fundação financeira V1 — contratos de domínio + estrutura da migration.
 * Fixtures sintéticas. Sem I/O remoto. Sem PII real.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FINANCIAL_FINDING_TYPES,
  FINANCIAL_IMPORTS_BUCKET,
  FINANCIAL_SIGNAL_CLASSES,
  FORBIDDEN_FINDING_STATUSES,
  RAW_PAYLOAD_FORBIDDEN_KEYS,
  SEEDED_FINANCIAL_ACCOUNT_CODES,
  accountMaskIsSafe,
  assertRawPayloadMinimized,
  canReimportSameFile,
  findingStatusIsAllowed,
  hashPersonDocument,
  importProcessingIdentity,
  isRawPayloadMinimized,
  isSha256Hex,
  moneyCentsIsValid,
  rawPayloadHasForbiddenKey,
  scoreEvidenceIsStructured,
} from "../src/lib/financial/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = join(
  root,
  "supabase/migrations/20260814220000_financial_foundation_v1.sql",
);

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

console.log("\n=== Fundação financeira V1 ===\n");

const sql = readFileSync(migrationPath, "utf8");

{
  for (const table of [
    "financial_accounts",
    "financial_imports",
    "financial_import_row_errors",
    "financial_entries",
    "financial_reconciliation_groups",
    "financial_reconciliation_legs",
    "financial_audit_findings",
    "financial_ai_analyses",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  }
  ok("migration declara as 8 tabelas financial_*");
}

{
  assert.match(sql, /unique \(file_sha256, parser_version\)/);
  assert.match(sql, /file_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
  ok("identidade de import = (file_sha256, parser_version)");
}

{
  assert.match(sql, /sicredi_principal/);
  assert.match(sql, /sicredi_0911/);
  assert.match(sql, /'sicredi_0911',\s*'bank',\s*'Sicredi',\s*'0911'/);
  assert.doesNotMatch(sql, /'sicredi_principal'[^;]{0,80}'[0-9]{5,}'/);
  ok("seed Sicredi com máscara; sem número completo");
}

{
  assert.match(sql, /financial_admin_can_read/);
  assert.match(sql, /perfil_usuario = 'admin'/);
  assert.match(sql, /financial_accounts_select_admin/);
  assert.match(sql, /financial_entries_write_deny/);
  assert.match(sql, /grant select, insert, update, delete on public\.financial_entries to service_role/);
  assert.match(sql, /grant select on public\.financial_entries to authenticated/);
  ok("RLS admin-read + deny write authenticated + grant service_role");
}

{
  assert.match(sql, /bucket_id = 'financial-imports'/);
  assert.equal(FINANCIAL_IMPORTS_BUCKET, "financial-imports");
  assert.match(sql, /public = excluded\.public/);
  ok("bucket privado financial-imports");
}

{
  const statusCheck = sql.match(
    /financial_audit_findings[\s\S]+?status text not null default 'open'\s+check \(status in \(([^)]+)\)\)/,
  );
  assert.ok(statusCheck, "check de status de finding presente");
  assert.doesNotMatch(statusCheck[1], /fraude_confirmada/);
  assert.match(statusCheck[1], /'open'/);
  assert.match(sql, /fraud_risk_signal/);
  for (const status of FORBIDDEN_FINDING_STATUSES) {
    assert.equal(findingStatusIsAllowed(status), false);
  }
  ok("findings sem estado fraude_confirmada");
}

{
  assert.match(sql, /Não é livro-razão oficial|nao e livro-razao oficial|Não é livro-razão/i);
  assert.match(sql, /score_evidence jsonb not null/);
  assert.match(sql, /person_document_hash/);
  assert.match(sql, /raw_payload_no_pii_keys_check/);
  ok("contrato: fatos normalizados + evidência de score + PII minimizada");
}

{
  assert.doesNotMatch(sql, /alter table public\.operacional_/);
  assert.doesNotMatch(sql, /alter table public\.management_/);
  assert.doesNotMatch(sql, /alter table public\.crm_/);
  assert.doesNotMatch(sql, /alter table public\.operacional_cobrancas_pagarme/);
  assert.doesNotMatch(sql, /hits-gateway/);
  assert.doesNotMatch(sql, /hits-reservation-sync/);
  ok("migration não altera operacional/management/Pagar.me/HITS");
}

{
  assert.equal(isSha256Hex(SHA_A), true);
  assert.equal(isSha256Hex("xyz"), false);
  assert.equal(importProcessingIdentity(SHA_A, "omie_ar_ap@1.0.0"), `${SHA_A}:omie_ar_ap@1.0.0`);
  assert.notEqual(
    importProcessingIdentity(SHA_A, "1.0.0"),
    importProcessingIdentity(SHA_A, "1.1.0"),
  );
  assert.notEqual(
    importProcessingIdentity(SHA_A, "1.0.0"),
    importProcessingIdentity(SHA_B, "1.0.0"),
  );
  assert.throws(() => importProcessingIdentity("abc", "1.0.0"));
  ok("identidade de processamento versionada");
}

{
  assert.equal(canReimportSameFile({ existingParserVersions: ["1.0.0"], nextParserVersion: "1.0.0" }), false);
  assert.equal(canReimportSameFile({ existingParserVersions: ["1.0.0"], nextParserVersion: "1.1.0" }), true);
  assert.equal(canReimportSameFile({ existingParserVersions: [], nextParserVersion: "1.0.0" }), true);
  ok("reimport só com parser_version nova");
}

{
  assert.equal(accountMaskIsSafe(null), true);
  assert.equal(accountMaskIsSafe("0911"), true);
  assert.equal(accountMaskIsSafe("91"), true);
  assert.equal(accountMaskIsSafe("12345"), false);
  assert.equal(accountMaskIsSafe("12.345-6"), false);
  ok("máscara de conta rejeita número completo");
}

{
  const hash = hashPersonDocument("cpf", "52998224725");
  assert.equal(isSha256Hex(hash), true);
  assert.notEqual(hash, "52998224725");
  assert.equal(hash, hashPersonDocument("cpf", "529.982.247-25"));
  assert.throws(() => hashPersonDocument("cpf", "123"));
  ok("person_document_hash é SHA-256, não o documento");
}

{
  assert.equal(moneyCentsIsValid(0), true);
  assert.equal(moneyCentsIsValid(150050), true);
  assert.equal(moneyCentsIsValid(-1), false);
  assert.equal(moneyCentsIsValid(1.5), false);
  ok("valores em centavos inteiros não negativos");
}

{
  assert.equal(
    scoreEvidenceIsStructured({
      amount_exact: true,
      document_match: true,
      date_distance_days: 1,
      name_match: "normalized_exact",
    }),
    true,
  );
  assert.equal(scoreEvidenceIsStructured({ date_distance_days: -1 }), false);
  assert.equal(scoreEvidenceIsStructured({ name_match: "fuzzy_free" }), false);
  ok("score_evidence estruturado");
}

{
  assert.equal(isRawPayloadMinimized({ fitid: "X1", gross_amount_cents: 100 }), true);
  assert.equal(isRawPayloadMinimized({ cpf: "52998224725" }), false);
  assert.equal(rawPayloadHasForbiddenKey({ cnpj: "00" }), true);
  assert.throws(() => assertRawPayloadMinimized({ account_number: "123" }));
  for (const key of RAW_PAYLOAD_FORBIDDEN_KEYS) {
    assert.equal(rawPayloadHasForbiddenKey({ [key]: "x" }), true);
  }
  ok("raw_payload allowlist sem PII completo");
}

{
  assert.equal(FINANCIAL_FINDING_TYPES.includes("internal_transfer"), true);
  assert.equal(FINANCIAL_SIGNAL_CLASSES.includes("fraud_risk_signal"), true);
  assert.equal((FINANCIAL_FINDING_TYPES as readonly string[]).includes("fraude_confirmada"), false);
  assert.deepEqual([...SEEDED_FINANCIAL_ACCOUNT_CODES], ["sicredi_principal", "sicredi_0911"]);
  ok("enums de finding/conta alinhados ao SQL");
}

console.log(`\n${passed} testes ok\n`);
