/**
 * Reconciliação determinística Omie AR/AP ↔ Sicredi.
 *
 * npm run financial:reconcile-omie-sicredi -- --dry-run
 * npm run financial:reconcile-omie-sicredi -- --from-json tmp/recon-entries.json --dry-run
 *
 * Persistência recusada nesta V1.2.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  OMIE_SICREDI_RULE_VERSION,
  RECON_PERIOD_END,
  RECON_PERIOD_START,
  formatOmieSicrediDryRun,
  reconReportLeaksPii,
  reconcileOmieSicredi,
  type ReconEntry,
} from "../src/lib/financial/reconciliation/index.ts";

const HOMO_REF = "minmmecajnmjqlgacfoz";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function usage(): never {
  console.error(`Uso:
  npm run financial:reconcile-omie-sicredi -- --dry-run
  npm run financial:reconcile-omie-sicredi -- --from-json <entries.json> --dry-run`);
  process.exit(2);
}

const FETCH_SQL = `
select
  e.id::text as id,
  e.account_id::text as account_id,
  a.code as account_code,
  e.source_system,
  e.source_kind,
  e.source_import_id::text as source_import_id,
  e.source_record_id,
  e.direction,
  e.person_name,
  e.description,
  e.gross_amount_cents,
  e.settled_amount_cents,
  e.open_amount_cents,
  e.settlement_date::text as settlement_date
from public.financial_entries e
left join public.financial_accounts a on a.id = e.account_id
where e.lifecycle_status = 'active'
  and e.settlement_date between '${RECON_PERIOD_START}' and '${RECON_PERIOD_END}'
  and e.source_system in ('omie', 'sicredi')
order by e.id;
`;

function readJsonText(path: string): string {
  const buf = readFileSync(path);
  const text =
    buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
      ? buf.toString("utf16le")
      : buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
        ? buf.subarray(3).toString("utf8")
        : buf.toString("utf8").replace(/^\uFEFF/, "");
  const start = text.indexOf("{") >= 0 && (text.indexOf("[") < 0 || text.indexOf("{") < text.indexOf("["))
    ? text.indexOf("{")
    : text.indexOf("[");
  if (start < 0) throw new Error("JSON de entries ausente");
  return text.slice(start);
}

function parseRows(raw: string): ReconEntry[] {
  const parsed = JSON.parse(raw) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : null;
  if (!rows) throw new Error("JSON de entries inválido");
  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      account_id: r.account_id == null ? null : String(r.account_id),
      account_code: r.account_code == null ? null : String(r.account_code),
      source_system: r.source_system as ReconEntry["source_system"],
      source_kind: r.source_kind as ReconEntry["source_kind"],
      source_import_id: r.source_import_id == null ? null : String(r.source_import_id),
      source_record_id: r.source_record_id == null ? null : String(r.source_record_id),
      direction: r.direction as ReconEntry["direction"],
      person_name: r.person_name == null ? null : String(r.person_name),
      description: r.description == null ? null : String(r.description),
      gross_amount_cents: r.gross_amount_cents == null ? null : Number(r.gross_amount_cents),
      settled_amount_cents: r.settled_amount_cents == null ? null : Number(r.settled_amount_cents),
      open_amount_cents: r.open_amount_cents == null ? null : Number(r.open_amount_cents),
      settlement_date: String(r.settlement_date),
    };
  });
}

function fetchHomoEntries(): ReconEntry[] {
  const sqlPath = resolve("tmp/recon-fetch.sql");
  mkdirSync(dirname(sqlPath), { recursive: true });
  writeFileSync(sqlPath, FETCH_SQL, "utf8");
  const out = spawnSync(
    "npx",
    [
      "supabase",
      "db",
      "query",
      "--linked",
      "--project-ref",
      HOMO_REF,
      "-f",
      sqlPath,
      "--output-format",
      "json",
    ],
    { encoding: "utf8", shell: true },
  );
  if (out.status !== 0) {
    throw new Error(out.stderr || out.stdout || "falha ao ler HOMO");
  }
  return parseRows(out.stdout);
}

function main() {
  if (hasFlag("--persist") || hasFlag("--apply")) {
    console.error("Persistência recusada nesta V1. Use somente --dry-run. Nenhum dado foi gravado.");
    process.exit(2);
  }
  if (!hasFlag("--dry-run") && !argValue("--from-json")) usage();

  const fromJson = argValue("--from-json");
  const entries = fromJson ? parseRows(readJsonText(resolve(fromJson))) : fetchHomoEntries();
  const result = reconcileOmieSicredi({
    entries,
    periodStart: argValue("--from") ?? RECON_PERIOD_START,
    periodEnd: argValue("--to") ?? RECON_PERIOD_END,
  });
  const text = formatOmieSicrediDryRun(result);
  if (reconReportLeaksPii(text)) {
    console.error("Dry-run bloqueado: saída conteria padrão de PII.");
    process.exit(2);
  }
  console.log(text);
  console.log(`entries_lidas: ${entries.length}`);
  console.log(`parser_rule: ${OMIE_SICREDI_RULE_VERSION}`);
}

main();
