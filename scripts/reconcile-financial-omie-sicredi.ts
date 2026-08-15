/**
 * Reconciliação determinística Omie AR/AP ↔ Sicredi.
 *
 * npm run financial:reconcile-omie-sicredi -- --dry-run
 * npm run financial:reconcile-omie-sicredi -- --from-json tmp/recon-entries.json --dry-run
 * npm run financial:reconcile-omie-sicredi -- --persist-high --allow-homo-reconciliation
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  OMIE_SICREDI_RULE_VERSION,
  RECON_PERIOD_END,
  RECON_PERIOD_START,
  YES_HOTEL_HOMO_REF,
  assertHomoReconciliationGate,
  buildHighPersistPlan,
  emitHighPersistSql,
  formatOmieSicrediDryRun,
  reconReportLeaksPii,
  reconcileOmieSicredi,
  summarizeHighPersistPlan,
  type ReconEntry,
} from "../src/lib/financial/reconciliation/index.ts";

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
  npm run financial:reconcile-omie-sicredi -- --from-json <entries.json> --dry-run
  npm run financial:reconcile-omie-sicredi -- --persist-high --allow-homo-reconciliation
  npm run financial:reconcile-omie-sicredi -- --persist-high --allow-homo-reconciliation --emit-sql <arquivo.sql>`);
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

function runLinkedSql(sqlPath: string): string {
  const out = spawnSync(
    "npx",
    [
      "supabase",
      "db",
      "query",
      "--linked",
      "--project-ref",
      YES_HOTEL_HOMO_REF,
      "-f",
      sqlPath,
      "--output-format",
      "json",
    ],
    { encoding: "utf8", shell: true },
  );
  if (out.status !== 0) {
    throw new Error(out.stderr || out.stdout || "falha no SQL HOMO");
  }
  return out.stdout;
}

function fetchHomoEntries(): ReconEntry[] {
  const sqlPath = resolve("tmp/recon-fetch.sql");
  mkdirSync(dirname(sqlPath), { recursive: true });
  writeFileSync(sqlPath, FETCH_SQL, "utf8");
  return parseRows(runLinkedSql(sqlPath));
}

function main() {
  if (hasFlag("--persist") || hasFlag("--apply")) {
    console.error("Persistência recusada. Use --persist-high --allow-homo-reconciliation. Nenhum dado foi gravado.");
    process.exit(2);
  }

  const persistHigh = hasFlag("--persist-high");
  const emitSql = argValue("--emit-sql");
  const apply = persistHigh && !emitSql;

  if (persistHigh || emitSql) {
    try {
      assertHomoReconciliationGate({
        persistHigh,
        allowHomo: hasFlag("--allow-homo-reconciliation"),
        url: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
        apply,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    }
  }

  if (!persistHigh && !hasFlag("--dry-run") && !argValue("--from-json")) usage();

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

  if (!persistHigh && !emitSql) return;

  try {
    const plan = buildHighPersistPlan(result, {
      requireExpectedSnapshot: true,
      requireUuid: true,
    });
    const sql = emitHighPersistSql(plan);
    console.log(summarizeHighPersistPlan(plan));
    if (emitSql) {
      const outPath = resolve(emitSql);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, sql, "utf8");
      console.log(`sql_emitido: ${outPath}`);
      console.log("persistido: NÃO (somente SQL)");
      return;
    }
    const sqlPath = resolve("tmp/recon-high-persist.sql");
    mkdirSync(dirname(sqlPath), { recursive: true });
    writeFileSync(sqlPath, sql, "utf8");
    const applied = runLinkedSql(sqlPath);
    console.log("persist_high: applied");
    console.log(applied.slice(applied.indexOf("{") >= 0 ? applied.indexOf("{") : 0));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

main();
