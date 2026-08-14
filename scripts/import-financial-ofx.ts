/**
 * Backfill local OFX Sicredi.
 * Dry-run é o modo obrigatório. Não persiste. Não imprime PII/OFX bruto.
 *
 * npm run financial:import-ofx -- --file "C:\...\arquivo.ofx" --account sicredi_principal --dry-run
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import {
  DEFAULT_SICREDI_ACCOUNT_HINTS,
  buildDryRunReport,
  dryRunReportLeaksPii,
  formatDryRunReport,
  normalizeOfxImport,
  type OfxDryRunReport,
} from "../src/lib/financial/import/ofx/index.ts";

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
  npm run financial:import-ofx -- --file <caminho.ofx> [--account sicredi_principal|sicredi_0911] --dry-run
  npm run financial:import-ofx -- --dir <pasta> [--account ...] --dry-run

Persistência está desabilitada neste PR. Não use --persist.`);
  process.exit(2);
}

function listOfxFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => [".ofx", ".OFX"].includes(extname(name)))
    .map((name) => resolve(dir, name))
    .sort((a, b) => a.localeCompare(b));
}

function runOne(filePath: string, expectedAccount?: string): OfxDryRunReport {
  const bytes = new Uint8Array(readFileSync(filePath));
  const result = normalizeOfxImport({
    bytes,
    expectedAccountCode: expectedAccount,
    knownAccounts: DEFAULT_SICREDI_ACCOUNT_HINTS,
  });
  return buildDryRunReport(basename(filePath), result);
}

function main() {
  if (hasFlag("--persist") || hasFlag("--apply")) {
    console.error("Persistência recusada neste PR. Use somente --dry-run. Nenhum dado foi gravado.");
    process.exit(2);
  }
  if (!hasFlag("--dry-run")) usage();

  const file = argValue("--file");
  const dir = argValue("--dir");
  const account = argValue("--account");
  if (!file && !dir) usage();
  if (file && dir) {
    console.error("Informe --file ou --dir, não ambos.");
    process.exit(2);
  }

  const paths = file ? [resolve(file)] : listOfxFiles(resolve(dir!));
  if (paths.length === 0) {
    console.error("Nenhum arquivo .ofx encontrado.");
    process.exit(2);
  }
  for (const path of paths) {
    if (!statSync(path).isFile()) {
      console.error(`Não é arquivo: ${basename(path)}`);
      process.exit(2);
    }
  }

  const reports = paths.map((path) => runOne(path, account));
  const texts = reports.map((report) => formatDryRunReport(report));
  for (const text of texts) {
    if (dryRunReportLeaksPii(text)) {
      console.error("Dry-run bloqueado: saída conteria padrão de PII/OFX bruto.");
      process.exit(2);
    }
  }

  console.log(texts.join("\n\n---\n\n"));
  if (reports.length > 1) {
    const tx = reports.reduce((n, r) => n + r.transactions, 0);
    const credits = reports.reduce((n, r) => n + r.credits_count, 0);
    const debits = reports.reduce((n, r) => n + r.debits_count, 0);
    const errors = reports.reduce((n, r) => n + r.errors + (r.fatal ? 1 : 0), 0);
    console.log(`\nconsolidado: arquivos=${reports.length} transações=${tx} créditos=${credits} débitos=${debits} erros=${errors}`);
  }

  if (reports.some((r) => r.fatal)) process.exit(1);
}

main();
