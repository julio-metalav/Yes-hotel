/**
 * Import do pivot Omie Contas a Receber / Contas a Pagar.
 *
 * Dry-run:
 *   npm run financial:import-omie-ar-ap -- --file "C:\...\pivot (4).xlsx" --dry-run
 *
 * Persistência só no HOMO:
 *   npm run financial:import-omie-ar-ap -- --file "..." --persist --allow-homo-backfill
 */
import "dotenv/config";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { canReimportSameFile } from "../src/lib/financial/index.ts";
import {
  OMIE_AR_AP_PARSER_NAME,
  OMIE_AR_AP_PARSER_VERSION,
  buildOmieArApDryRunReport,
  formatOmieArApDryRunReport,
  normalizeOmieArApImport,
  omieDryRunLeaksPii,
  type OmieArApDryRunReport,
  type OmieArApImportOk,
} from "../src/lib/financial/import/omie/index.ts";

const YES_HOTEL_HOMO_REF = "minmmecajnmjqlgacfoz";
const ENTRY_BATCH = 150;

function isYesHotelHomoUrl(url: string): boolean {
  return url.includes(YES_HOTEL_HOMO_REF);
}

const EXPECTED_PIVOT4 = {
  parser_version: OMIE_AR_AP_PARSER_VERSION,
  physical_rows: 2137,
  ignored_rows: 5,
  entries: 2148,
  ar_count: 928,
  ap_count: 1220,
  ar_gross_cents: 140116969,
  ar_settled_cents: 138358166,
  ar_open_cents: 1759092,
  ar_tax_cents: 0,
  ap_gross_cents: 128656637,
  ap_settled_cents: 128656969,
  ap_open_cents: 0,
  ap_tax_cents: 0,
  period_start: "2026-01-01",
  period_end: "2026-07-31",
  errors: 0,
} as const;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function usage(): never {
  console.error(`Uso:
  npm run financial:import-omie-ar-ap -- --file <pivot.xlsx> --dry-run
  npm run financial:import-omie-ar-ap -- --file <pivot.xlsx> --persist --allow-homo-backfill
  npm run financial:import-omie-ar-ap -- --file <pivot.xlsx> --emit-sql <arquivo.sql> --allow-homo-backfill`);
  process.exit(2);
}

function sqlLiteral(value: string | null | undefined): string {
  if (value == null) return "null";
  return `'${value.replace(/'/g, "''")}'`;
}

function emitPersistSql(filePath: string, result: OmieArApImportOk): string {
  const jsonTag = "omie_ar_ap_json_v1";
  const payload = JSON.stringify(
    result.entries.map((entry) => ({
      source_system: entry.source_system,
      source_kind: entry.source_kind,
      source_record_id: entry.source_record_id,
      source_row: entry.source_row,
      direction: entry.direction,
      entry_type: entry.entry_type,
      person_name: entry.person_name,
      document_number: entry.document_number,
      installment: entry.installment,
      category_source: entry.category_source,
      category_yes: entry.category_yes,
      description: entry.description,
      gross_amount_cents: entry.gross_amount_cents,
      tax_cents: entry.tax_cents,
      settled_amount_cents: entry.settled_amount_cents,
      open_amount_cents: entry.open_amount_cents,
      net_amount_cents: entry.net_amount_cents,
      issue_date: entry.issue_date,
      due_date: entry.due_date,
      settlement_date: entry.settlement_date,
      competence_date: entry.competence_date,
      payment_method: entry.payment_method,
      external_reference: entry.external_reference,
      raw_payload: entry.raw_payload,
      normalized_hash: entry.normalized_hash,
    })),
  );
  if (payload.includes(`$${jsonTag}$`)) {
    throw new Error("payload JSON colidiu com o dollar-quote; recusar persistência");
  }
  const metadata = {
    sheet: result.sheet,
    physical_rows: result.stats.physical_rows,
    ignored_rows: result.stats.ignored_rows,
    ar_count: result.stats.ar_count,
    ap_count: result.stats.ap_count,
    ar_gross_cents: result.stats.ar_gross_cents,
    ar_settled_cents: result.stats.ar_settled_cents,
    ar_open_cents: result.stats.ar_open_cents,
    ar_tax_cents: result.stats.ar_tax_cents,
    ap_gross_cents: result.stats.ap_gross_cents,
    ap_settled_cents: result.stats.ap_settled_cents,
    ap_open_cents: result.stats.ap_open_cents,
    ap_tax_cents: result.stats.ap_tax_cents,
    storage: "not_uploaded_this_backfill",
  };
  return `-- Persistência HOMO Omie AR/AP. Não aplicar em PROD.
begin;

with ins as (
  insert into public.financial_imports (
    source_type, source_name, original_filename, file_sha256,
    parser_name, parser_version, period_start, period_end,
    status, total_rows, failed_row_count, metadata
  ) values (
    'omie_ar_ap',
    'omie',
    ${sqlLiteral(basename(filePath))},
    ${sqlLiteral(result.file_sha256)},
    ${sqlLiteral(OMIE_AR_AP_PARSER_NAME)},
    ${sqlLiteral(OMIE_AR_AP_PARSER_VERSION)},
    ${sqlLiteral(result.period_start)}::date,
    ${sqlLiteral(result.period_end)}::date,
    'normalized',
    ${result.stats.entries},
    ${result.errors.length},
    ${sqlLiteral(JSON.stringify(metadata))}::jsonb
  )
  returning id
)
insert into public.financial_entries (
  account_id, source_system, source_kind, source_import_id, source_record_id, source_row,
  direction, entry_type, person_name, document_number, installment,
  category_source, category_yes, description,
  gross_amount_cents, tax_cents, settled_amount_cents, open_amount_cents, net_amount_cents,
  issue_date, due_date, settlement_date, competence_date,
  payment_method, external_reference, raw_payload, normalized_hash, lifecycle_status
)
select
  null,
  x.source_system,
  x.source_kind,
  (select id from ins),
  x.source_record_id,
  x.source_row,
  x.direction,
  x.entry_type,
  x.person_name,
  x.document_number,
  x.installment,
  x.category_source,
  x.category_yes,
  x.description,
  x.gross_amount_cents,
  x.tax_cents,
  x.settled_amount_cents,
  x.open_amount_cents,
  x.net_amount_cents,
  x.issue_date,
  x.due_date,
  x.settlement_date,
  x.competence_date,
  x.payment_method,
  x.external_reference,
  x.raw_payload,
  x.normalized_hash,
  'active'
from json_to_recordset($${jsonTag}$${payload}$${jsonTag}$) as x(
  source_system text,
  source_kind text,
  source_record_id text,
  source_row integer,
  direction text,
  entry_type text,
  person_name text,
  document_number text,
  installment text,
  category_source text,
  category_yes text,
  description text,
  gross_amount_cents bigint,
  tax_cents bigint,
  settled_amount_cents bigint,
  open_amount_cents bigint,
  net_amount_cents bigint,
  issue_date date,
  due_date date,
  settlement_date date,
  competence_date date,
  payment_method text,
  external_reference text,
  raw_payload jsonb,
  normalized_hash text
);

commit;
`;
}

function homoClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!isYesHotelHomoUrl(url)) {
    throw new Error("Persistência recusada: URL não é o HOMO Yes Hotel");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function assertExpectedPivot4(report: OmieArApDryRunReport): void {
  const mismatches: string[] = [];
  for (const [key, expected] of Object.entries(EXPECTED_PIVOT4)) {
    const actual = report[key as keyof OmieArApDryRunReport];
    if (actual !== expected) mismatches.push(`${key}: esperado ${expected}, obtido ${actual}`);
  }
  if (report.totals_match !== true) mismatches.push("totais do XLSX não conferem");
  if (mismatches.length) {
    throw new Error(`Dry-run divergiu do contrato pivot 4. PARAR.\n${mismatches.join("\n")}`);
  }
}

async function persistOne(
  client: SupabaseClient,
  filePath: string,
  result: OmieArApImportOk,
): Promise<{ status: "inserted" | "duplicate"; importId?: string; entries: number }> {
  const { data: existing, error: existingErr } = await client
    .from("financial_imports")
    .select("id, parser_version")
    .eq("file_sha256", result.file_sha256);
  if (existingErr) throw new Error(existingErr.message);
  const versions = (existing ?? []).map((row) => String(row.parser_version));
  if (!canReimportSameFile({ existingParserVersions: versions, nextParserVersion: result.parser_version })) {
    return { status: "duplicate", importId: existing?.[0]?.id, entries: 0 };
  }

  const { data: importRow, error: importErr } = await client
    .from("financial_imports")
    .insert({
      source_type: "omie_ar_ap",
      source_name: "omie",
      original_filename: basename(filePath),
      file_sha256: result.file_sha256,
      parser_name: OMIE_AR_AP_PARSER_NAME,
      parser_version: OMIE_AR_AP_PARSER_VERSION,
      period_start: result.period_start,
      period_end: result.period_end,
      status: "normalized",
      total_rows: result.stats.entries,
      failed_row_count: result.errors.length,
      metadata: {
        sheet: result.sheet,
        physical_rows: result.stats.physical_rows,
        ignored_rows: result.stats.ignored_rows,
        ar_count: result.stats.ar_count,
        ap_count: result.stats.ap_count,
        ar_gross_cents: result.stats.ar_gross_cents,
        ar_settled_cents: result.stats.ar_settled_cents,
        ar_open_cents: result.stats.ar_open_cents,
        ar_tax_cents: result.stats.ar_tax_cents,
        ap_gross_cents: result.stats.ap_gross_cents,
        ap_settled_cents: result.stats.ap_settled_cents,
        ap_open_cents: result.stats.ap_open_cents,
        ap_tax_cents: result.stats.ap_tax_cents,
        storage: "not_uploaded_this_backfill",
      },
    })
    .select("id")
    .single();
  if (importErr || !importRow) throw new Error(importErr?.message ?? "insert financial_imports falhou");

  const importId = String(importRow.id);
  if (result.errors.length) {
    const { error: errRows } = await client.from("financial_import_row_errors").insert(
      result.errors.map((row) => ({
        import_id: importId,
        row_number: row.row_number,
        code: row.code,
        message: row.message.slice(0, 500),
        raw_excerpt: row.raw_excerpt.slice(0, 500),
      })),
    );
    if (errRows) throw new Error(errRows.message);
  }

  for (let i = 0; i < result.entries.length; i += ENTRY_BATCH) {
    const chunk = result.entries.slice(i, i + ENTRY_BATCH).map((entry) => ({
      account_id: null,
      source_system: entry.source_system,
      source_kind: entry.source_kind,
      source_import_id: importId,
      source_record_id: entry.source_record_id,
      source_row: entry.source_row,
      direction: entry.direction,
      entry_type: entry.entry_type,
      person_name: entry.person_name,
      document_number: entry.document_number,
      installment: entry.installment,
      category_source: entry.category_source,
      category_yes: entry.category_yes,
      description: entry.description,
      gross_amount_cents: entry.gross_amount_cents,
      tax_cents: entry.tax_cents,
      settled_amount_cents: entry.settled_amount_cents,
      open_amount_cents: entry.open_amount_cents,
      net_amount_cents: entry.net_amount_cents,
      issue_date: entry.issue_date,
      due_date: entry.due_date,
      settlement_date: entry.settlement_date,
      competence_date: entry.competence_date,
      payment_method: entry.payment_method,
      external_reference: entry.external_reference,
      raw_payload: entry.raw_payload,
      normalized_hash: entry.normalized_hash,
      lifecycle_status: "active",
    }));
    const { error: entryErr } = await client.from("financial_entries").insert(chunk);
    if (entryErr) throw new Error(`insert financial_entries: ${entryErr.message}`);
  }

  return { status: "inserted", importId, entries: result.entries.length };
}

async function main() {
  const persist = hasFlag("--persist") || hasFlag("--apply");
  const emitSql = argValue("--emit-sql");
  if ((persist || emitSql) && !hasFlag("--allow-homo-backfill")) {
    console.error("Persistência recusada. Para HOMO use --persist|--emit-sql --allow-homo-backfill. Nenhum dado foi gravado.");
    process.exit(2);
  }
  if (!persist && !emitSql && !hasFlag("--dry-run")) usage();

  const file = argValue("--file");
  if (!file) usage();
  const path = resolve(file);
  if (!statSync(path).isFile()) {
    console.error("Arquivo inválido.");
    process.exit(2);
  }

  const bytes = new Uint8Array(readFileSync(path));
  const result = await normalizeOmieArApImport({ bytes });
  const report = buildOmieArApDryRunReport(basename(path), result);
  const text = formatOmieArApDryRunReport(report);
  if (omieDryRunLeaksPii(text)) {
    console.error("Dry-run bloqueado: saída conteria padrão de PII.");
    process.exit(2);
  }
  console.log(text);
  if (!result.ok) process.exit(1);
  if (result.workbook_totals && report.totals_match === false) process.exit(1);

  if (!persist && !emitSql) return;

  const client = persist ? homoClient() : null;
  assertExpectedPivot4(report);
  if (emitSql) {
    const sqlPath = resolve(emitSql);
    mkdirSync(dirname(sqlPath), { recursive: true });
    writeFileSync(sqlPath, emitPersistSql(path, result), "utf8");
    console.log(`sql: ${basename(sqlPath)}`);
    if (!persist) return;
  }

  if (!client) throw new Error("cliente HOMO ausente");
  const out = await persistOne(client, path, result);
  console.log(`persist: ${out.status} entries=${out.entries}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
