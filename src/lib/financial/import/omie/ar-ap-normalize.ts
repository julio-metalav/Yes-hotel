import { isRawPayloadMinimized } from "../../payload.ts";
import { parseOmieArApWorkbook } from "./ar-ap-parser.ts";
import { omieArApNormalizedHash, normalizeOmieText, sha256HexOfBytes } from "./hash.ts";
import {
  OMIE_AR_AP_PARSER_NAME,
  OMIE_AR_AP_PARSER_VERSION,
  type OmieArApFact,
  type OmieArApImportResult,
  type OmieArApNormalizedEntry,
  type OmieArApStats,
} from "./ar-ap-types.ts";

const DESCRIPTION_MAX = 500;

function emptyStats(): OmieArApStats {
  return {
    physical_rows: 0,
    ignored_rows: 0,
    entries: 0,
    ar_count: 0,
    ap_count: 0,
    ar_gross_cents: 0,
    ar_settled_cents: 0,
    ar_open_cents: 0,
    ar_tax_cents: 0,
    ap_gross_cents: 0,
    ap_settled_cents: 0,
    ap_open_cents: 0,
    ap_tax_cents: 0,
    errors: 0,
  };
}

function redactName(name: string): string {
  const cut = name.slice(0, 24);
  return name.length > 24 ? `${cut}…` : cut;
}

function toEntry(fact: OmieArApFact): OmieArApNormalizedEntry | { error: string } {
  const receivable = fact.side === "ar";
  const description = `${fact.personName} | ${fact.settlementDate}`.slice(0, DESCRIPTION_MAX);
  const rawPayload: Record<string, unknown> = {
    source_row: fact.sourceRow,
    settlement_date: fact.settlementDate,
    gross_amount_cents: fact.gross.absCents,
    tax_cents: fact.tax.absCents,
    settled_amount_cents: fact.settled.absCents,
    open_amount_cents: fact.open.absCents,
    omie_side: fact.side,
    parser_version: OMIE_AR_AP_PARSER_VERSION,
    description_redacted: redactName(description),
  };
  if (!isRawPayloadMinimized(rawPayload)) {
    return { error: "raw_payload fora da allowlist" };
  }
  return {
    source_system: "omie",
    source_kind: receivable ? "omie_receivable" : "omie_payable",
    direction: receivable ? "credit" : "debit",
    entry_type: receivable ? "receivable" : "payable",
    account_id: null,
    source_record_id: null,
    source_row: fact.sourceRow,
    person_name: normalizeOmieText(fact.personName).slice(0, 200),
    document_number: null,
    installment: null,
    category_source: null,
    category_yes: null,
    description,
    gross_amount_cents: fact.gross.absCents,
    tax_cents: fact.tax.absCents,
    settled_amount_cents: fact.settled.absCents,
    open_amount_cents: fact.open.absCents,
    net_amount_cents: null,
    issue_date: null,
    due_date: null,
    settlement_date: fact.settlementDate,
    competence_date: null,
    payment_method: null,
    external_reference: null,
    raw_payload: rawPayload,
    normalized_hash: omieArApNormalizedHash({
      side: fact.side,
      personName: fact.personName,
      settlementDate: fact.settlementDate,
      grossCents: fact.gross.absCents,
      settledCents: fact.settled.absCents,
      openCents: fact.open.absCents,
      taxCents: fact.tax.absCents,
    }),
  };
}

export async function normalizeOmieArApImport(input: { bytes: Uint8Array }): Promise<OmieArApImportResult> {
  const fileSha = sha256HexOfBytes(input.bytes);
  const stats = emptyStats();
  const parsed = await parseOmieArApWorkbook(input.bytes);
  if (!parsed.ok) {
    return {
      ok: false,
      file_sha256: fileSha,
      parser_name: OMIE_AR_AP_PARSER_NAME,
      parser_version: OMIE_AR_AP_PARSER_VERSION,
      fatal: { code: parsed.reason, message: parsed.message },
      errors: [],
      stats,
    };
  }

  stats.physical_rows = parsed.physicalRows;
  stats.ignored_rows = parsed.ignored.length;
  stats.errors = parsed.errors.length;
  const entries: OmieArApNormalizedEntry[] = [];
  const errors = [...parsed.errors];
  const dates: string[] = [];

  for (const fact of parsed.facts) {
    const entry = toEntry(fact);
    if ("error" in entry) {
      errors.push({
        row_number: fact.physicalRow,
        code: "malformed_row",
        message: entry.error,
        raw_excerpt: entry.error,
      });
      stats.errors += 1;
      continue;
    }
    entries.push(entry);
    dates.push(entry.settlement_date);
    if (fact.side === "ar") {
      stats.ar_count += 1;
      stats.ar_gross_cents += entry.gross_amount_cents;
      stats.ar_settled_cents += entry.settled_amount_cents;
      stats.ar_open_cents += entry.open_amount_cents;
      stats.ar_tax_cents += entry.tax_cents;
    } else {
      stats.ap_count += 1;
      stats.ap_gross_cents += entry.gross_amount_cents;
      stats.ap_settled_cents += entry.settled_amount_cents;
      stats.ap_open_cents += entry.open_amount_cents;
      stats.ap_tax_cents += entry.tax_cents;
    }
  }
  stats.entries = entries.length;
  stats.errors = errors.length;

  return {
    ok: true,
    file_sha256: fileSha,
    parser_name: OMIE_AR_AP_PARSER_NAME,
    parser_version: OMIE_AR_AP_PARSER_VERSION,
    sheet: parsed.sheet,
    period_start: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    period_end: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
    workbook_totals: parsed.workbookTotals,
    entries,
    ignored: parsed.ignored,
    errors,
    stats,
  };
}
