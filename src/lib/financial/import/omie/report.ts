import { maskSha256 } from "./hash.ts";
import type { OmieArApImportResult } from "./ar-ap-types.ts";

const PII_LEAK_RE =
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b|Cliente ou Fornecedor \(Nome Fantasia\)/;

export type OmieArApDryRunReport = {
  file_label: string;
  file_sha256_masked: string;
  parser_version: string;
  sheet: string | null;
  physical_rows: number;
  ignored_rows: number;
  entries: number;
  ar_count: number;
  ap_count: number;
  ar_gross_cents: number;
  ar_settled_cents: number;
  ar_open_cents: number;
  ar_tax_cents: number;
  ap_gross_cents: number;
  ap_settled_cents: number;
  ap_open_cents: number;
  ap_tax_cents: number;
  period_start: string | null;
  period_end: string | null;
  errors: number;
  fatal: { code: string; message: string } | null;
  totals_match: boolean | null;
};

function formatCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const frac = String(cents % 100).padStart(2, "0");
  return `${whole},${frac}`;
}

export function buildOmieArApDryRunReport(fileLabel: string, result: OmieArApImportResult): OmieArApDryRunReport {
  let totalsMatch: boolean | null = null;
  if (result.ok && result.workbook_totals) {
    const t = result.workbook_totals;
    const s = result.stats;
    totalsMatch =
      t.ar_gross_cents === s.ar_gross_cents &&
      t.ar_settled_cents === s.ar_settled_cents &&
      t.ar_open_cents === s.ar_open_cents &&
      t.ar_tax_cents === s.ar_tax_cents &&
      t.ap_gross_cents === s.ap_gross_cents &&
      t.ap_settled_cents === s.ap_settled_cents &&
      t.ap_open_cents === s.ap_open_cents &&
      t.ap_tax_cents === s.ap_tax_cents;
  }
  return {
    file_label: fileLabel,
    file_sha256_masked: maskSha256(result.file_sha256),
    parser_version: result.parser_version,
    sheet: result.ok ? result.sheet : null,
    physical_rows: result.stats.physical_rows,
    ignored_rows: result.stats.ignored_rows,
    entries: result.stats.entries,
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
    period_start: result.ok ? result.period_start : null,
    period_end: result.ok ? result.period_end : null,
    errors: result.stats.errors,
    fatal: result.ok ? null : result.fatal,
    totals_match: totalsMatch,
  };
}

export function formatOmieArApDryRunReport(report: OmieArApDryRunReport): string {
  const lines = [
    `arquivo: ${report.file_label}`,
    `hash: ${report.file_sha256_masked}`,
    `parser: ${report.parser_version}`,
    `sheet: ${report.sheet ?? "(n/a)"}`,
    `linhas físicas: ${report.physical_rows}`,
    `linhas ignoradas: ${report.ignored_rows}`,
    `entries: ${report.entries}`,
    `contas a receber: ${report.ar_count}`,
    `contas a pagar: ${report.ap_count}`,
    `AR bruto: ${formatCents(report.ar_gross_cents)}`,
    `AR recebido: ${formatCents(report.ar_settled_cents)}`,
    `AR aberto: ${formatCents(report.ar_open_cents)}`,
    `AR impostos: ${formatCents(report.ar_tax_cents)}`,
    `AP bruto: ${formatCents(report.ap_gross_cents)}`,
    `AP pago: ${formatCents(report.ap_settled_cents)}`,
    `AP aberto: ${formatCents(report.ap_open_cents)}`,
    `AP impostos: ${formatCents(report.ap_tax_cents)}`,
    `período: ${report.period_start ?? "?"} → ${report.period_end ?? "?"}`,
    `erros: ${report.errors}`,
    `totais do XLSX conferem: ${report.totals_match == null ? "n/a" : report.totals_match ? "sim" : "NÃO"}`,
  ];
  if (report.fatal) lines.push(`fatal: ${report.fatal.code} — ${report.fatal.message}`);
  return lines.join("\n");
}

export function omieDryRunLeaksPii(text: string): boolean {
  return PII_LEAK_RE.test(text);
}
