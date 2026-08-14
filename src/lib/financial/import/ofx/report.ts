/**
 * Relatório de dry-run sem PII: sem conta completa, CPF/CNPJ, MEMO integral ou OFX bruto.
 */

import { maskSha256 } from "./hash.ts";
import type { OfxImportResult, OfxRowError } from "./types.ts";

const PII_LEAK_RE =
  /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b|<OFX|<STMTTRN|<MEMO>|<BANKACCTFROM>/i;

export type OfxDryRunReport = {
  file_label: string;
  file_sha256_masked: string;
  parser_version: string;
  account_code: string | null;
  account_resolution: string | null;
  period_start: string | null;
  period_end: string | null;
  transactions: number;
  credits_count: number;
  credits_cents: number;
  debits_count: number;
  debits_cents: number;
  missing_fitid: number;
  errors: number;
  fatal: { code: string; message: string } | null;
  error_codes: OfxRowError["code"][];
};

export function buildDryRunReport(fileLabel: string, result: OfxImportResult): OfxDryRunReport {
  return {
    file_label: fileLabel,
    file_sha256_masked: maskSha256(result.file_sha256),
    parser_version: result.parser_version,
    account_code: result.account_code,
    account_resolution: result.ok ? result.account_resolution : null,
    period_start: result.ok ? result.period_start : null,
    period_end: result.ok ? result.period_end : null,
    transactions: result.stats.transactions,
    credits_count: result.stats.credits_count,
    credits_cents: result.stats.credits_cents,
    debits_count: result.stats.debits_count,
    debits_cents: result.stats.debits_cents,
    missing_fitid: result.stats.missing_fitid,
    errors: result.stats.errors,
    fatal: result.ok ? null : result.fatal,
    error_codes: result.errors.map((e) => e.code),
  };
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${sign}${whole},${frac}`;
}

export function formatDryRunReport(report: OfxDryRunReport): string {
  const lines = [
    `arquivo: ${report.file_label}`,
    `hash: ${report.file_sha256_masked}`,
    `parser: ${report.parser_version}`,
    `conta: ${report.account_code ?? "(não resolvida)"}${report.account_resolution ? ` (${report.account_resolution})` : ""}`,
    `período: ${report.period_start ?? "?"} → ${report.period_end ?? "?"}`,
    `transações: ${report.transactions}`,
    `créditos: ${report.credits_count} / ${formatCents(report.credits_cents)}`,
    `débitos: ${report.debits_count} / ${formatCents(report.debits_cents)}`,
    `sem FITID: ${report.missing_fitid}`,
    `erros: ${report.errors}${report.error_codes.length ? ` [${[...new Set(report.error_codes)].join(", ")}]` : ""}`,
  ];
  if (report.fatal) lines.push(`fatal: ${report.fatal.code} — ${report.fatal.message}`);
  return lines.join("\n");
}

export function dryRunReportLeaksPii(text: string): boolean {
  return PII_LEAK_RE.test(text);
}
