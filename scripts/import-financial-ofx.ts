/**
 * Backfill local OFX Sicredi.
 *
 * Dry-run:
 *   npm run financial:import-ofx -- --file "C:\...\arquivo.ofx" --account sicredi_principal --dry-run
 *
 * Persistência só no HOMO, com fingerprint cadastrado:
 *   npm run financial:import-ofx -- --file "..." --account sicredi_principal --persist --allow-homo-backfill
 */
import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { canReimportSameFile } from "../src/lib/financial/index.ts";
import {
  DEFAULT_SICREDI_ACCOUNT_HINTS,
  OFX_PARSER_NAME,
  OFX_PARSER_VERSION,
  buildDryRunReport,
  dryRunReportLeaksPii,
  formatDryRunReport,
  maskOfxFingerprint,
  normalizeOfxImport,
  parseOfxFingerprint,
  type OfxAccountHint,
  type OfxDryRunReport,
  type OfxImportOk,
} from "../src/lib/financial/import/ofx/index.ts";

const HOMO_REF = "minmmecajnmjqlgacfoz";
const ENTRY_BATCH = 150;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function usage(): never {
  console.error(`Uso:
  npm run financial:import-ofx -- --file <caminho.ofx> --account sicredi_principal|sicredi_0911 --dry-run
  npm run financial:import-ofx -- --file <caminho.ofx> --account ... --persist --allow-homo-backfill`);
  process.exit(2);
}

function listOfxFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => [".ofx", ".OFX"].includes(extname(name)))
    .map((name) => resolve(dir, name))
    .sort((a, b) => a.localeCompare(b));
}

function homoClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!url.includes(HOMO_REF)) {
    throw new Error("Persistência recusada: URL não é o HOMO Yes Hotel");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function loadAccountHints(client: SupabaseClient): Promise<
  Array<OfxAccountHint & { id: string }>
> {
  const { data, error } = await client
    .from("financial_accounts")
    .select("id, code, account_mask, institution, metadata")
    .in("code", ["sicredi_principal", "sicredi_0911"]);
  if (error) throw new Error(`falha ao ler financial_accounts: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    code: String(row.code),
    account_mask: row.account_mask == null ? null : String(row.account_mask),
    institution: row.institution == null ? null : String(row.institution),
    ofx_fingerprint: parseOfxFingerprint(row.metadata),
  }));
}

function runOne(
  filePath: string,
  expectedAccount: string | undefined,
  knownAccounts: readonly OfxAccountHint[],
  requireFingerprint: boolean,
): OfxDryRunReport & { result: ReturnType<typeof normalizeOfxImport> } {
  const bytes = new Uint8Array(readFileSync(filePath));
  const result = normalizeOfxImport({
    bytes,
    expectedAccountCode: expectedAccount,
    knownAccounts,
    requireFingerprint,
  });
  return { ...buildDryRunReport(basename(filePath), result), result };
}

async function persistOne(
  client: SupabaseClient,
  filePath: string,
  expectedAccount: string,
  accounts: Array<OfxAccountHint & { id: string }>,
): Promise<{ status: "inserted" | "duplicate"; importId?: string; entries: number }> {
  const bytes = new Uint8Array(readFileSync(filePath));
  const result = normalizeOfxImport({
    bytes,
    expectedAccountCode: expectedAccount,
    knownAccounts: accounts,
    requireFingerprint: true,
  });
  if (!result.ok) {
    throw new Error(`import abortado (${result.fatal.code}): ${result.fatal.message}`);
  }
  const account = accounts.find((a) => a.code === result.account_code);
  if (!account) throw new Error("conta resolvida ausente do catálogo HOMO");

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
      source_type: "ofx_bank",
      source_name: "sicredi",
      original_filename: basename(filePath),
      file_sha256: result.file_sha256,
      parser_name: OFX_PARSER_NAME,
      parser_version: OFX_PARSER_VERSION,
      period_start: result.period_start,
      period_end: result.period_end,
      status: "normalized",
      total_rows: result.stats.transactions,
      failed_row_count: result.errors.length,
      metadata: {
        account_code: result.account_code,
        account_resolution: result.account_resolution,
        currency: result.currency,
        credits_count: result.stats.credits_count,
        credits_cents: result.stats.credits_cents,
        debits_count: result.stats.debits_count,
        debits_cents: result.stats.debits_cents,
        missing_fitid: result.stats.missing_fitid,
        ledger_balance_cents: result.ledger_balance?.amountCents ?? null,
        fingerprint: maskOfxFingerprint(account.ofx_fingerprint),
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
      account_id: account.id,
      source_system: entry.source_system,
      source_kind: entry.source_kind,
      source_import_id: importId,
      source_record_id: entry.source_record_id,
      source_row: entry.source_row,
      direction: entry.direction,
      entry_type: entry.entry_type,
      person_name: entry.person_name,
      description: entry.description,
      gross_amount_cents: entry.gross_amount_cents,
      net_amount_cents: entry.net_amount_cents,
      settlement_date: entry.settlement_date,
      payment_method: entry.payment_method,
      external_reference: entry.external_reference,
      raw_payload: entry.raw_payload,
      normalized_hash: entry.normalized_hash,
      lifecycle_status: "active",
    }));
    const { error: entryErr } = await client.from("financial_entries").insert(chunk);
    if (entryErr) throw new Error(`insert financial_entries: ${entryErr.message}`);
  }

  void (result as OfxImportOk);
  return { status: "inserted", importId, entries: result.entries.length };
}

async function main() {
  const persist = hasFlag("--persist") || hasFlag("--apply");
  if (persist && !hasFlag("--allow-homo-backfill")) {
    console.error("Persistência recusada. Para HOMO use --persist --allow-homo-backfill. Nenhum dado foi gravado.");
    process.exit(2);
  }
  if (!persist && !hasFlag("--dry-run")) usage();

  const file = argValue("--file");
  const dir = argValue("--dir");
  const account = argValue("--account");
  if (!file && !dir) usage();
  if (file && dir) {
    console.error("Informe --file ou --dir, não ambos.");
    process.exit(2);
  }
  if (persist && !account) {
    console.error("Persistência exige --account explícito.");
    process.exit(2);
  }

  const paths = file ? [resolve(file)] : listOfxFiles(resolve(dir!));
  if (paths.length === 0) {
    console.error("Nenhum arquivo .ofx encontrado.");
    process.exit(2);
  }

  let knownAccounts: OfxAccountHint[] = [...DEFAULT_SICREDI_ACCOUNT_HINTS];
  let client: SupabaseClient | null = null;
  let accountsWithId: Array<OfxAccountHint & { id: string }> = [];
  if (persist || hasFlag("--use-homo-fingerprints")) {
    client = homoClient();
    accountsWithId = await loadAccountHints(client);
    if (accountsWithId.length !== 2) throw new Error("catálogo HOMO incompleto");
    knownAccounts = accountsWithId;
    for (const row of accountsWithId) {
      console.log(`fingerprint ${row.code}: ${maskOfxFingerprint(row.ofx_fingerprint)}`);
    }
  }

  const reports = paths.map((path) => runOne(path, account, knownAccounts, persist));
  const texts = reports.map((report) => formatDryRunReport(report));
  for (const text of texts) {
    if (dryRunReportLeaksPii(text)) {
      console.error("Saída bloqueada: padrão de PII/OFX bruto.");
      process.exit(2);
    }
  }
  console.log(texts.join("\n\n---\n\n"));
  if (reports.some((r) => r.fatal)) process.exit(1);

  if (!persist) return;
  if (!client) throw new Error("cliente HOMO ausente");

  for (const path of paths) {
    const out = await persistOne(client, path, account!, accountsWithId);
    console.log(`${basename(path)}: ${out.status} entries=${out.entries}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
