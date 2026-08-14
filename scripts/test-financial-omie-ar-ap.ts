/**
 * Parser Omie AR/AP. Fixtures sintéticas. Sem I/O remoto. Sem PII real.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRawPayloadMinimized } from "../src/lib/financial/index.ts";
import {
  OMIE_AR_AP_PARSER_VERSION,
  buildOmieArApDryRunReport,
  formatOmieArApDryRunReport,
  normalizeOmieArApImport,
  omieArApNormalizedHash,
  omieDryRunLeaksPii,
  parseOmieAmountToSignedCents,
  parseOmieDate,
} from "../src/lib/financial/import/omie/index.ts";
import { buildSyntheticOmieArApXlsx } from "./fixtures/omie/synthetic-ar-ap.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

console.log("\n=== Omie AR/AP V1 ===\n");

{
  const sql = readFileSync(join(root, "supabase/migrations/20260815010000_financial_entries_settled_amount_cents.sql"), "utf8");
  assert.match(sql, /add column if not exists settled_amount_cents/);
  assert.match(sql, /settled_amount_cents is null or settled_amount_cents >= 0/);
  assert.doesNotMatch(sql, /operacional_|management_|hits-gateway/);
  ok("migration aditiva settled_amount_cents sem tocar operacional");
}

{
  assert.equal(parseOmieAmountToSignedCents(100.5).ok && (parseOmieAmountToSignedCents(100.5) as { absCents: number }).absCents, 10050);
  assert.equal(parseOmieAmountToSignedCents(-40).ok && (parseOmieAmountToSignedCents(-40) as { signedCents: number }).signedCents, -4000);
  assert.equal(parseOmieAmountToSignedCents(0).ok && (parseOmieAmountToSignedCents(0) as { absCents: number }).absCents, 0);
  assert.equal(parseOmieAmountToSignedCents("1.234,56").ok && (parseOmieAmountToSignedCents("1.234,56") as { absCents: number }).absCents, 123456);
  assert.equal(parseOmieAmountToSignedCents("abc").ok, false);
  ok("valores: número Excel, BRL texto, zero, negativo, inválido");
}

{
  assert.equal(parseOmieDate("15/01/2026").ok && (parseOmieDate("15/01/2026") as { date: string }).date, "2026-01-15");
  assert.equal(parseOmieDate(new Date(2026, 0, 16)).ok && (parseOmieDate(new Date(2026, 0, 16)) as { date: string }).date, "2026-01-16");
  assert.equal(parseOmieDate(46038).ok && (parseOmieDate(46038) as { date: string }).date, "2026-01-16");
  assert.equal(parseOmieDate("2026-02-01").ok && (parseOmieDate("2026-02-01") as { date: string }).date, "2026-02-01");
  assert.equal(parseOmieDate("32/13/2026").ok, false);
  assert.equal(parseOmieDate("ontem").ok, false);
  ok("datas: dd/mm/yyyy, Date, serial Excel, ISO; rejeita inválida");
}

async function main() {
{
  const bytes = await buildSyntheticOmieArApXlsx({
    rows: [
      { name: "CLIENTE SINTETICO", date: "15/01/2026", ar: { gross: 200, tax: 10, settled: 150, open: 40 } },
      { name: "FORNECEDOR SINTETICO", date: "16/01/2026", ap: { gross: -80, tax: 0, settled: -50, open: -30 } },
      { date: "17/01/2026", ap: { gross: -20, settled: -20, open: 0 } },
      { name: "MISTO SINTETICO", date: "18/01/2026", ar: { gross: 5, settled: 5, open: 0 }, ap: { gross: -3, settled: -3, open: 0 } },
    ],
  });
  const result = await normalizeOmieArApImport({ bytes });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("esperado ok");
  assert.equal(result.parser_version, OMIE_AR_AP_PARSER_VERSION);
  assert.equal(result.entries.length, 5);
  assert.equal(result.stats.ar_count, 2);
  assert.equal(result.stats.ap_count, 3);
  const rec = result.entries.find((e) => e.source_kind === "omie_receivable" && e.gross_amount_cents === 20000)!;
  assert.equal(rec.direction, "credit");
  assert.equal(rec.entry_type, "receivable");
  assert.equal(rec.tax_cents, 1000);
  assert.equal(rec.settled_amount_cents, 15000);
  assert.equal(rec.open_amount_cents, 4000);
  assert.equal(rec.net_amount_cents, null);
  assert.equal(rec.account_id, null);
  assert.equal(rec.source_record_id, null);
  assert.equal(rec.issue_date, null);
  assert.equal(isRawPayloadMinimized(rec.raw_payload), true);
  const pay = result.entries.find((e) => e.gross_amount_cents === 8000)!;
  assert.equal(pay.source_kind, "omie_payable");
  assert.equal(pay.direction, "debit");
  const carried = result.entries.find((e) => e.settlement_date === "2026-01-17")!;
  assert.equal(carried.person_name, "FORNECEDOR SINTETICO");
  const both = result.entries.filter((e) => e.person_name === "MISTO SINTETICO");
  assert.equal(both.length, 2);
  assert.notEqual(both[0]!.source_row, both[1]!.source_row);
  assert.equal(result.ignored.some((i) => i.kind === "total"), true);
  assert.equal(result.workbook_totals?.ar_gross_cents, 20500);
  ok("receivable/payable, parcial, imposto, carry-forward, linha mista, total ignorado");
}

{
  const bytes = await buildSyntheticOmieArApXlsx({
    rows: [
      { name: "ZERO SINTETICO", date: "01/02/2026", ar: { gross: 0, tax: 0, settled: 0, open: 0 } },
    ],
  });
  const result = await normalizeOmieArApImport({ bytes });
  assert.equal(result.ok && result.entries[0]?.gross_amount_cents, 0);
  ok("zero persiste como 0, não null");
}

{
  const bytes = await buildSyntheticOmieArApXlsx({
    rows: [
      { name: "IGUAL A", date: "02/02/2026", ar: { gross: 10, settled: 10, open: 0 } },
      { name: "IGUAL A", date: "02/02/2026", ar: { gross: 10, settled: 10, open: 0 } },
    ],
  });
  const result = await normalizeOmieArApImport({ bytes });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("esperado ok");
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]!.normalized_hash, result.entries[1]!.normalized_hash);
  assert.notEqual(result.entries[0]!.source_row, result.entries[1]!.source_row);
  ok("duas entries iguais legítimas convivem; hash não elimina");
}

{
  const a = omieArApNormalizedHash({
    side: "ar",
    personName: "CLIENTE SINTETICO",
    settlementDate: "2026-01-15",
    grossCents: 10050,
    settledCents: 10050,
    openCents: 0,
    taxCents: 0,
  });
  const b = omieArApNormalizedHash({
    side: "ar",
    personName: "CLIENTE SINTETICO",
    settlementDate: "2026-01-15",
    grossCents: 10050,
    settledCents: 10050,
    openCents: 0,
    taxCents: 0,
  });
  assert.equal(a, b);
  assert.equal(OMIE_AR_AP_PARSER_VERSION, "omie_ar_ap@1.0.0");
  ok("hash determinístico e parser_version");
}

{
  const badAmt = await buildSyntheticOmieArApXlsx({
    rows: [
      { name: "OK", date: "03/02/2026", ar: { gross: 10, settled: 10, open: 0 } },
    ],
  });
  const result = await normalizeOmieArApImport({ bytes: badAmt });
  assert.equal(result.ok, true);
  const badDate = await buildSyntheticOmieArApXlsx({
    rows: [{ name: "X", date: "32/13/2026", ar: { gross: 1, settled: 1, open: 0 } }],
  });
  const dated = await normalizeOmieArApImport({ bytes: badDate });
  assert.equal(dated.ok && dated.errors.some((e) => e.code === "invalid_date"), true);
  ok("data inválida vira row error e não aborta o contrato");
}

{
  const bytes = await buildSyntheticOmieArApXlsx({
    rows: [
      { name: "OK", date: "04/02/2026", ar: { gross: 2, settled: 2, open: 0 } },
      { name: "Cliente ou Fornecedor (Nome Fantasia)", date: "05/02/2026", ar: { gross: 9, settled: 9, open: 0 } },
    ],
  });
  const result = await normalizeOmieArApImport({ bytes });
  assert.equal(result.ok && result.entries.length, 1);
  assert.equal(result.ok && result.ignored.some((i) => i.kind === "header" && i.physicalRow > 4), true);
  ok("cabeçalho repetido é ignorado");
}

{
  const bytes = await buildSyntheticOmieArApXlsx({ omitHeaders: true, rows: [] });
  const result = await normalizeOmieArApImport({ bytes });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("esperado fatal");
  assert.equal(result.fatal.code, "incompatible_headers");
  ok("workbook incompatível falha o import inteiro");
}

{
  const bytes = await buildSyntheticOmieArApXlsx();
  const result = await normalizeOmieArApImport({ bytes });
  const text = formatOmieArApDryRunReport(buildOmieArApDryRunReport("pivot-sintetico.xlsx", result));
  assert.match(text, /parser: omie_ar_ap@1\.0\.0/);
  assert.doesNotMatch(text, /CLIENTE SINTETICO/);
  assert.doesNotMatch(text, /52998224725/);
  assert.equal(omieDryRunLeaksPii(text), false);
  ok("dry-run sintético sem PII");
}

{
  const tmp = join(root, "tmp", "omie-ar-ap-dry-run");
  mkdirSync(tmp, { recursive: true });
  const file = join(tmp, "pivot-sintetico.xlsx");
  writeFileSync(file, await buildSyntheticOmieArApXlsx());
  const tsxCli = join(root, "node_modules/tsx/dist/cli.mjs");
  const cli = spawnSync(
    process.execPath,
    [tsxCli, "scripts/import-financial-omie-ar-ap.ts", "--file", file, "--dry-run"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.match(cli.stdout, /contas a receber: 1/);
  assert.match(cli.stdout, /contas a pagar: 1/);
  const persist = spawnSync(
    process.execPath,
    [tsxCli, "scripts/import-financial-omie-ar-ap.ts", "--file", file, "--persist"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(persist.status, 0);
  assert.match(persist.stderr + persist.stdout, /Persistência recusada/i);
  const emitSql = join(tmp, "must-not-write.sql");
  const emit = spawnSync(
    process.execPath,
    [tsxCli, "scripts/import-financial-omie-ar-ap.ts", "--file", file, "--emit-sql", emitSql],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(emit.status, 0);
  assert.match(emit.stderr + emit.stdout, /Persistência recusada/i);
  assert.equal(existsSync(emitSql), false);
  const persistGated = spawnSync(
    process.execPath,
    [tsxCli, "scripts/import-financial-omie-ar-ap.ts", "--file", file, "--persist", "--allow-homo-backfill"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SUPABASE_URL: "https://example-prod.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "not-a-real-key",
      },
    },
  );
  assert.notEqual(persistGated.status, 0);
  assert.match(persistGated.stderr + persistGated.stdout, /URL não é o HOMO/i);
  ok("CLI dry-run; persist/emit-sql recusados sem gate; PROD não é alvo");
}

console.log(`\n${passed} testes ok\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
