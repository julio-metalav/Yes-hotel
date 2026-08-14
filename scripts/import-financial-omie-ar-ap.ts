/**
 * Dry-run do pivot Omie Contas a Receber / Contas a Pagar.
 * Persistência recusada neste PR.
 *
 * npm run financial:import-omie-ar-ap -- --file "C:\...\pivot (4).xlsx" --dry-run
 */
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  buildOmieArApDryRunReport,
  formatOmieArApDryRunReport,
  normalizeOmieArApImport,
  omieDryRunLeaksPii,
} from "../src/lib/financial/import/omie/index.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function usage(): never {
  console.error(`Uso:
  npm run financial:import-omie-ar-ap -- --file <pivot.xlsx> --dry-run`);
  process.exit(2);
}

async function main() {
  if (hasFlag("--persist") || hasFlag("--apply")) {
    console.error("Persistência recusada neste PR. Use somente --dry-run. Nenhum dado foi gravado.");
    process.exit(2);
  }
  if (!hasFlag("--dry-run")) usage();
  const file = argValue("--file");
  if (!file) usage();
  const path = resolve(file);
  if (!statSync(path).isFile()) {
    console.error("Arquivo inválido.");
    process.exit(2);
  }
  const bytes = new Uint8Array(readFileSync(path));
  const result = await normalizeOmieArApImport({ bytes });
  const text = formatOmieArApDryRunReport(buildOmieArApDryRunReport(basename(path), result));
  if (omieDryRunLeaksPii(text)) {
    console.error("Dry-run bloqueado: saída conteria padrão de PII.");
    process.exit(2);
  }
  console.log(text);
  if (!result.ok) process.exit(1);
  if (result.ok && result.workbook_totals) {
    const report = buildOmieArApDryRunReport(basename(path), result);
    if (report.totals_match === false) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
