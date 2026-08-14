/**
 * Parser OFX Sicredi + hardening de grants. Fixtures sintéticas. Sem I/O remoto. Sem PII real.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canReimportSameFile, isRawPayloadMinimized } from "../src/lib/financial/index.ts";
import {
  DEFAULT_SICREDI_ACCOUNT_HINTS,
  OFX_DEFAULT_TIMEZONE,
  OFX_PARSER_VERSION,
  buildDryRunReport,
  dryRunReportLeaksPii,
  formatDryRunReport,
  normalizeOfxImport,
  ofxFingerprintsMatch,
  ofxNormalizedHash,
  parseOfxAmountToSignedCents,
  parseOfxDateTime,
  parseOfxDocument,
  parseOfxFingerprint,
  resolveOfxAccount,
  sha256HexOfBytes,
} from "../src/lib/financial/import/ofx/index.ts";
import {
  SYNTHETIC_0911_OK,
  SYNTHETIC_PRINCIPAL_OK,
  buildSyntheticOfx,
} from "./fixtures/ofx/synthetic.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const grantsPath = join(root, "supabase/migrations/20260814233000_financial_grants_revoke_authenticated.sql");
const foundationPath = join(root, "supabase/migrations/20260814220000_financial_foundation_v1.sql");

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function run(text: string, expectedAccount?: string) {
  return normalizeOfxImport({
    bytes: bytesOf(text),
    expectedAccountCode: expectedAccount,
    knownAccounts: DEFAULT_SICREDI_ACCOUNT_HINTS,
  });
}

console.log("\n=== OFX Sicredi V1 ===\n");

{
  const grants = readFileSync(grantsPath, "utf8");
  const foundation = readFileSync(foundationPath, "utf8");
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
    assert.match(grants, new RegExp(`revoke insert, update, delete, truncate on public\\.${table} from authenticated`));
    assert.match(grants, new RegExp(`grant select on public\\.${table} to authenticated`));
    assert.match(grants, new RegExp(`grant select, insert, update, delete on public\\.${table} to service_role`));
  }
  assert.doesNotMatch(grants, /create table if not exists public\.financial_/);
  assert.match(foundation, /create table if not exists public\.financial_entries/);
  ok("RLS grants hardening versionado (REVOKE authenticated, SELECT permanece)");
}

{
  const credit = parseOfxAmountToSignedCents("1234.56");
  const debit = parseOfxAmountToSignedCents("-1234.56");
  assert.equal(credit.ok && credit.signedCents, 123456);
  assert.equal(debit.ok && debit.signedCents, -123456);
  assert.equal(parseOfxAmountToSignedCents("").ok, false);
  assert.equal(parseOfxAmountToSignedCents("abc").ok, false);
  assert.equal(parseOfxAmountToSignedCents("1.234").ok, false);
  assert.equal(parseOfxAmountToSignedCents("1,23").ok, false);
  assert.equal(parseOfxAmountToSignedCents("0").ok, false);
  assert.equal(parseOfxAmountToSignedCents("1.2.3").ok, false);
  ok("valores: crédito/débito/centavos; rejeita vazio, precisão e inválido");
}

{
  const withTz = parseOfxDateTime("20260814123000[-3:BRT]");
  const dateOnly = parseOfxDateTime("20260814");
  const noTz = parseOfxDateTime("20260814123000");
  assert.equal(withTz.ok && withTz.date, "2026-08-14");
  assert.equal(withTz.ok && withTz.offsetHours, -3);
  assert.equal(dateOnly.ok && dateOnly.date, "2026-08-14");
  assert.equal(noTz.ok && noTz.timezone, OFX_DEFAULT_TIMEZONE);
  assert.equal(parseOfxDateTime("20261399").ok, false);
  assert.equal(parseOfxDateTime("ontem").ok, false);
  ok("datas: timezone, sem timezone, YYYYMMDD; rejeita inválida");
}

{
  const result = run(SYNTHETIC_PRINCIPAL_OK, "sicredi_principal");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("esperado ok");
  assert.equal(result.parser_version, OFX_PARSER_VERSION);
  assert.equal(result.account_code, "sicredi_principal");
  assert.equal(result.entries.length, 2);
  const credit = result.entries[0]!;
  const debit = result.entries[1]!;
  assert.equal(credit.direction, "credit");
  assert.equal(credit.source_kind, "bank_credit");
  assert.equal(credit.gross_amount_cents, 123456);
  assert.equal(credit.net_amount_cents, 123456);
  assert.equal(credit.settlement_date, "2026-01-15");
  assert.equal(credit.source_record_id, "FIT-CRED-1");
  assert.equal(credit.external_reference, "REF-1");
  assert.match(credit.description, /FORNECEDOR SINTETICO/);
  assert.match(credit.description, /CREDITO TESTE/);
  assert.equal(debit.direction, "debit");
  assert.equal(debit.source_kind, "bank_debit");
  assert.equal(debit.gross_amount_cents, 1000);
  assert.equal(debit.settlement_date, "2026-01-16");
  assert.equal(isRawPayloadMinimized(credit.raw_payload), true);
  assert.equal("account_number" in credit.raw_payload, false);
  assert.equal(result.ledger_balance?.amountCents, 100000);
  ok("crédito, débito, NAME/MEMO, FITID, raw_payload allowlist, saldo só no import");
}

{
  const result = run(SYNTHETIC_0911_OK);
  assert.equal(result.ok && result.account_code, "sicredi_0911");
  ok("conta 0911 resolvida pela máscara OFX, sem nome de arquivo");
}

{
  const noFitid = buildSyntheticOfx({
    acctId: "00004321",
    transactions: [
      { dtposted: "20260301", trnamt: "10.00", name: "A" },
      { dtposted: "20260301", trnamt: "10.00", name: "A" },
    ],
  });
  const result = run(noFitid, "sicredi_principal");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("esperado ok");
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]!.source_record_id, null);
  assert.equal(result.entries[1]!.source_record_id, null);
  assert.equal(result.entries[0]!.normalized_hash, result.entries[1]!.normalized_hash);
  assert.notEqual(result.entries[0]!.source_row, result.entries[1]!.source_row);
  assert.equal(result.stats.missing_fitid, 2);
  ok("duas txs legítimas iguais no mesmo dia convivem; hash não elimina");
}

{
  const dup = buildSyntheticOfx({
    acctId: "00004321",
    transactions: [
      { dtposted: "20260302", trnamt: "20.00", fitid: "DUP-1", name: "A" },
      { dtposted: "20260303", trnamt: "21.00", fitid: "DUP-1", name: "B" },
    ],
  });
  const result = run(dup, "sicredi_principal");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("esperado ok");
  assert.equal(result.entries.length, 1);
  assert.equal(result.errors[0]?.code, "duplicate_source_record");
  ok("FITID duplicado no arquivo vira row error");
}

{
  const badAmt = buildSyntheticOfx({
    acctId: "00004321",
    transactions: [
      { dtposted: "20260304", trnamt: "abc", fitid: "BAD-AMT" },
      { dtposted: "20260305", trnamt: "5.00", fitid: "OK-AMT", name: "OK" },
    ],
  });
  const result = run(badAmt, "sicredi_principal");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("esperado ok");
  assert.equal(result.entries.length, 1);
  assert.equal(result.errors[0]?.code, "invalid_amount");
  ok("valor inválido não aborta as demais transações");
}

{
  const badDate = buildSyntheticOfx({
    acctId: "00004321",
    transactions: [{ dtposted: "20261340", trnamt: "5.00", fitid: "BAD-DT" }],
  });
  const result = run(badDate, "sicredi_principal");
  assert.equal(result.ok && result.errors[0]?.code, "invalid_date");
  ok("data inválida vira row error");
}

{
  const missing = buildSyntheticOfx({
    acctId: "00004321",
    transactions: [{ dtposted: "", trnamt: "", name: "VAZIO" }],
  });
  const parsed = parseOfxDocument(missing);
  assert.equal(parsed.ok, true);
  const result = run(missing, "sicredi_principal");
  assert.equal(result.ok && result.errors.some((e) => e.code === "missing_required_field"), true);
  ok("campo obrigatório ausente");
}

{
  const malformed = run("isto nao e ofx", "sicredi_principal");
  assert.equal(malformed.ok, false);
  if (malformed.ok) throw new Error("esperado fatal");
  assert.equal(malformed.fatal.code, "malformed_ofx");
  const emptyList = run(buildSyntheticOfx({ acctId: "00004321", transactions: [], omitBankTranList: true }), "sicredi_principal");
  assert.equal(emptyList.ok, false);
  ok("OFX malformado / BANKTRANLIST ausente falha o import inteiro");
}

{
  const unresolved = run(SYNTHETIC_PRINCIPAL_OK);
  assert.equal(unresolved.ok, false);
  if (unresolved.ok) throw new Error("esperado fatal");
  assert.equal(unresolved.fatal.code, "account_unresolved");
  const clash = run(SYNTHETIC_0911_OK, "sicredi_principal");
  assert.equal(clash.ok, false);
  const hinted0911 = run(
    buildSyntheticOfx({
      acctId: "00007777",
      transactions: [{ dtposted: "20260308", trnamt: "9.00", fitid: "HINT-1", name: "HINT" }],
    }),
    "sicredi_0911",
  );
  assert.equal(hinted0911.ok && hinted0911.account_code, "sicredi_0911");
  assert.equal(hinted0911.ok && hinted0911.account_resolution, "operator_hint");
  ok("conta não resolvida ou hint em máscara alheia falha; hint 0911 sem last4 0911 é explícito");
}

{
  const a = ofxNormalizedHash({
    sourceSystem: "sicredi",
    accountCode: "sicredi_principal",
    settlementDate: "2026-01-15",
    amountCents: 123456,
    direction: "credit",
    description: "FORNECEDOR SINTETICO | CREDITO TESTE",
    externalReference: "REF-1",
  });
  const b = ofxNormalizedHash({
    sourceSystem: "sicredi",
    accountCode: "sicredi_principal",
    settlementDate: "2026-01-15",
    amountCents: 123456,
    direction: "credit",
    description: "FORNECEDOR SINTETICO | CREDITO TESTE",
    externalReference: "REF-1",
  });
  const c = ofxNormalizedHash({
    sourceSystem: "sicredi",
    accountCode: "sicredi_principal",
    settlementDate: "2026-01-16",
    amountCents: 123456,
    direction: "credit",
    description: "FORNECEDOR SINTETICO | CREDITO TESTE",
    externalReference: "REF-1",
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
  ok("normalized_hash determinístico");
}

{
  const once = sha256HexOfBytes(bytesOf(SYNTHETIC_PRINCIPAL_OK));
  const twice = sha256HexOfBytes(bytesOf(SYNTHETIC_PRINCIPAL_OK));
  assert.equal(once, twice);
  assert.equal(OFX_PARSER_VERSION, "ofx@1.0.0");
  assert.equal(canReimportSameFile({ existingParserVersions: [OFX_PARSER_VERSION], nextParserVersion: OFX_PARSER_VERSION }), false);
  assert.equal(canReimportSameFile({ existingParserVersions: [OFX_PARSER_VERSION], nextParserVersion: "ofx@1.0.1" }), true);
  ok("parser_version e identidade (sha256, parser_version)");
}

{
  const result = run(SYNTHETIC_PRINCIPAL_OK, "sicredi_principal");
  const report = formatDryRunReport(buildDryRunReport("sicredi-jan26-sintetico.ofx", result));
  assert.match(report, /parser: ofx@1\.0\.0/);
  assert.match(report, /conta: sicredi_principal/);
  assert.doesNotMatch(report, /00004321/);
  assert.doesNotMatch(report, /FORNECEDOR SINTETICO/);
  assert.doesNotMatch(report, /CREDITO TESTE/);
  assert.doesNotMatch(report, /<OFX/);
  assert.doesNotMatch(report, /52998224725/);
  assert.equal(dryRunReportLeaksPii(report), false);
  ok("dry-run sintético sem vazar PII/OFX bruto");
}

{
  const resolved = resolveOfxAccount({
    ofx: { bankId: "748", branchId: "1", acctId: "xx0911", acctType: "CHECKING", acctIdLast4: "0911" },
    knownAccounts: DEFAULT_SICREDI_ACCOUNT_HINTS,
  });
  assert.equal(resolved.ok && resolved.code, "sicredi_0911");
  assert.equal(resolved.ok && resolved.method, "mask");
  const foreign = resolveOfxAccount({
    ofx: { bankId: "001", branchId: null, acctId: "1", acctType: null, acctIdLast4: "0001" },
    expectedCode: "sicredi_principal",
    knownAccounts: DEFAULT_SICREDI_ACCOUNT_HINTS,
  });
  assert.equal(foreign.ok, false);
  ok("resolução de conta fail-closed; BANKID não-Sicredi rejeitado");
}

{
  const tmp = join(root, "tmp", "financial-ofx-dry-run");
  mkdirSync(tmp, { recursive: true });
  const file = join(tmp, "sicredi-principal-sintetico.ofx");
  writeFileSync(file, SYNTHETIC_PRINCIPAL_OK);
  const tsxCli = join(root, "node_modules/tsx/dist/cli.mjs");
  const cli = spawnSync(
    process.execPath,
    [tsxCli, "scripts/import-financial-ofx.ts", "--file", file, "--account", "sicredi_principal", "--dry-run"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /transações: 2/);
  assert.match(cli.stdout, /créditos: 1/);
  assert.match(cli.stdout, /débitos: 1/);
  assert.doesNotMatch(cli.stdout, /00004321/);
  assert.doesNotMatch(cli.stdout, /<STMTTRN/);
  const persist = spawnSync(
    process.execPath,
    [tsxCli, "scripts/import-financial-ofx.ts", "--file", file, "--account", "sicredi_principal", "--persist"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(persist.status, 0);
  assert.match(persist.stderr + persist.stdout, /Persistência recusada/i);
  ok("CLI dry-run sintético; persistência recusada");
}

{
  const fpA = { bank_id: "748", branch_fingerprint: null, account_last4: "4321", account_type: "CHECKING" };
  const fpB = { bank_id: "748", branch_fingerprint: null, account_last4: "7777", account_type: "CHECKING" };
  assert.equal(ofxFingerprintsMatch(fpA, fpA), true);
  assert.equal(ofxFingerprintsMatch(fpA, fpB), false);
  assert.equal(parseOfxFingerprint({ ofx: { bank_id: "748", account_last4: "4321", account_type: "CHECKING" } })?.account_last4, "4321");
  assert.equal(parseOfxFingerprint({ ofx: { account_number: "123", account_last4: "4321" } }), null);
  const hinted = [
    { code: "sicredi_principal", account_mask: null, institution: "Sicredi", ofx_fingerprint: fpA },
    { code: "sicredi_0911", account_mask: "0911", institution: "Sicredi", ofx_fingerprint: fpB },
  ];
  const okMatch = normalizeOfxImport({
    bytes: bytesOf(SYNTHETIC_PRINCIPAL_OK),
    expectedAccountCode: "sicredi_principal",
    knownAccounts: hinted,
    requireFingerprint: true,
  });
  assert.equal(okMatch.ok && okMatch.account_resolution, "fingerprint");
  const wrongHint = normalizeOfxImport({
    bytes: bytesOf(SYNTHETIC_PRINCIPAL_OK),
    expectedAccountCode: "sicredi_0911",
    knownAccounts: hinted,
    requireFingerprint: true,
  });
  assert.equal(wrongHint.ok, false);
  if (wrongHint.ok) throw new Error("esperado mismatch");
  assert.equal(wrongHint.fatal.code, "account_fingerprint_mismatch");
  const missing = normalizeOfxImport({
    bytes: bytesOf(SYNTHETIC_PRINCIPAL_OK),
    expectedAccountCode: "sicredi_principal",
    knownAccounts: DEFAULT_SICREDI_ACCOUNT_HINTS,
    requireFingerprint: true,
  });
  assert.equal(missing.ok, false);
  ok("fingerprint: match, hint errado e cadastro ausente abortam o import");
}

console.log(`\n${passed} testes ok\n`);
