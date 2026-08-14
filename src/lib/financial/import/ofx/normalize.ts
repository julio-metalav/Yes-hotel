import { isRawPayloadMinimized } from "../../payload.ts";
import { assertHintedFingerprint, extractOfxFingerprint, resolveOfxAccount } from "./account.ts";
import { parseOfxDateTime } from "./dates.ts";
import { ofxNormalizedHash, normalizeOfxText, sha256HexOfBytes } from "./hash.ts";
import { parseOfxAmountToSignedCents, signedCentsToDirection } from "./money.ts";
import { decodeOfxBytes, parseOfxDocument } from "./parser.ts";
import {
  OFX_PARSER_NAME,
  OFX_PARSER_VERSION,
  type OfxAccountHint,
  type OfxBalance,
  type OfxDryRunStats,
  type OfxImportResult,
  type OfxNormalizedEntry,
  type OfxRowError,
  type OfxStmtTrn,
} from "./types.ts";

const DESCRIPTION_MAX = 500;
const NAME_MAX = 200;
const EXCERPT_MAX = 120;

export const DEFAULT_SICREDI_ACCOUNT_HINTS: readonly OfxAccountHint[] = [
  { code: "sicredi_principal", account_mask: null, institution: "Sicredi" },
  { code: "sicredi_0911", account_mask: "0911", institution: "Sicredi" },
];

function emptyStats(): OfxDryRunStats {
  return {
    transactions: 0,
    credits_count: 0,
    credits_cents: 0,
    debits_count: 0,
    debits_cents: 0,
    missing_fitid: 0,
    errors: 0,
  };
}

function sanitizeExcerpt(raw: string | null | undefined): string {
  return normalizeOfxText(raw)
    .replace(/\d{5,}/g, "***")
    .slice(0, EXCERPT_MAX);
}

function composeDescription(name: string | null, memo: string | null): string {
  const n = normalizeOfxText(name);
  const m = normalizeOfxText(memo);
  if (n && m && n.toLowerCase() !== m.toLowerCase()) return `${n} | ${m}`.slice(0, DESCRIPTION_MAX);
  return (n || m).slice(0, DESCRIPTION_MAX);
}

function redactDescription(description: string): string {
  const cut = description.slice(0, 80);
  return description.length > 80 ? `${cut}…` : cut;
}

function externalReference(trn: OfxStmtTrn): string | null {
  const ref = normalizeOfxText(trn.refnum) || normalizeOfxText(trn.checknum);
  return ref || null;
}

function parseOptionalDate(raw: string | null | undefined): string | null {
  const parsed = parseOfxDateTime(raw);
  return parsed.ok ? parsed.date : null;
}

function parseBalance(raw: OfxBalance | null): OfxBalance | null {
  if (!raw) return null;
  const amount = raw.rawAmount ? parseOfxAmountToSignedCents(raw.rawAmount) : null;
  return {
    amountCents: amount?.ok ? amount.signedCents : null,
    asOfDate: parseOptionalDate(raw.asOfDate),
    rawAmount: null,
  };
}

function addError(
  errors: OfxRowError[],
  row: number,
  code: OfxRowError["code"],
  message: string,
  excerpt?: string,
) {
  errors.push({
    row_number: row,
    code,
    message,
    raw_excerpt: sanitizeExcerpt(excerpt ?? message),
  });
}

export function normalizeOfxImport(input: {
  bytes: Uint8Array;
  expectedAccountCode?: string | null;
  knownAccounts?: readonly OfxAccountHint[];
  requireFingerprint?: boolean;
}): OfxImportResult {
  const fileSha = sha256HexOfBytes(input.bytes);
  const stats = emptyStats();
  const errors: OfxRowError[] = [];
  const knownAccounts = input.knownAccounts ?? DEFAULT_SICREDI_ACCOUNT_HINTS;

  const parsed = parseOfxDocument(decodeOfxBytes(input.bytes));
  if (!parsed.ok) {
    return {
      ok: false,
      file_sha256: fileSha,
      parser_name: OFX_PARSER_NAME,
      parser_version: OFX_PARSER_VERSION,
      account_code: null,
      fatal: { code: parsed.reason, message: parsed.message },
      errors,
      stats,
    };
  }

  if (input.requireFingerprint && !String(input.expectedAccountCode ?? "").trim()) {
    return {
      ok: false,
      file_sha256: fileSha,
      parser_name: OFX_PARSER_NAME,
      parser_version: OFX_PARSER_VERSION,
      account_code: null,
      fatal: { code: "account_unresolved", message: "persistência exige --account explícito" },
      errors,
      stats,
    };
  }

  const account = resolveOfxAccount({
    ofx: parsed.document.account,
    expectedCode: input.expectedAccountCode,
    knownAccounts,
  });
  if (!account.ok) {
    return {
      ok: false,
      file_sha256: fileSha,
      parser_name: OFX_PARSER_NAME,
      parser_version: OFX_PARSER_VERSION,
      account_code: null,
      fatal: { code: "account_unresolved", message: account.message },
      errors,
      stats,
    };
  }

  let resolution = account.method;
  if (input.requireFingerprint) {
    const finger = assertHintedFingerprint({
      file: extractOfxFingerprint(parsed.document.account),
      expectedCode: account.code,
      knownAccounts,
    });
    if (!finger.ok) {
      return {
        ok: false,
        file_sha256: fileSha,
        parser_name: OFX_PARSER_NAME,
        parser_version: OFX_PARSER_VERSION,
        account_code: null,
        fatal: { code: finger.code, message: finger.message },
        errors,
        stats,
      };
    }
    resolution = finger.method;
  }

  const seenFitid = new Set<string>();
  const entries: OfxNormalizedEntry[] = [];
  const settlementDates: string[] = [];

  for (const trn of parsed.document.transactions) {
    stats.transactions += 1;

    const amountRaw = String(trn.trnamt ?? "").trim();
    if (!amountRaw) {
      addError(errors, trn.sourceRow, "missing_required_field", "TRNAMT ausente");
      continue;
    }
    const amount = parseOfxAmountToSignedCents(amountRaw);
    if (!amount.ok) {
      addError(errors, trn.sourceRow, "invalid_amount", `TRNAMT inválido (${amount.reason})`, amountRaw);
      continue;
    }

    const postedRaw = String(trn.dtposted ?? "").trim();
    if (!postedRaw) {
      addError(errors, trn.sourceRow, "missing_required_field", "DTPOSTED ausente");
      continue;
    }
    const posted = parseOfxDateTime(postedRaw);
    if (!posted.ok) {
      addError(errors, trn.sourceRow, "invalid_date", "DTPOSTED inválida", postedRaw);
      continue;
    }

    const fitid = normalizeOfxText(trn.fitid) || null;
    if (fitid) {
      if (seenFitid.has(fitid)) {
        addError(errors, trn.sourceRow, "duplicate_source_record", "FITID duplicado no arquivo", fitid);
        continue;
      }
      seenFitid.add(fitid);
    } else {
      stats.missing_fitid += 1;
    }

    const signed = signedCentsToDirection(amount.signedCents);
    const description = composeDescription(trn.name, trn.memo);
    const extRef = externalReference(trn);
    const personName = normalizeOfxText(trn.name).slice(0, NAME_MAX) || null;

    const rawPayload: Record<string, unknown> = {
      source_row: trn.sourceRow,
      fitid,
      trntype: trn.trntype,
      settlement_date: posted.date,
      gross_amount_cents: signed.absCents,
      net_amount_cents: signed.absCents,
      description_redacted: redactDescription(description),
      external_reference: extRef,
      currency: parsed.document.currency ?? "BRL",
      parser_version: OFX_PARSER_VERSION,
      dtposted_raw: posted.original,
      timezone: posted.timezone,
    };
    if (trn.checknum) rawPayload.checknum = normalizeOfxText(trn.checknum);
    if (trn.refnum) rawPayload.refnum = normalizeOfxText(trn.refnum);

    if (!isRawPayloadMinimized(rawPayload)) {
      addError(errors, trn.sourceRow, "malformed_transaction", "raw_payload fora da allowlist");
      continue;
    }

    entries.push({
      source_system: "sicredi",
      source_kind: signed.sourceKind,
      direction: signed.direction,
      entry_type: "bank_tx",
      account_code: account.code,
      source_record_id: fitid,
      source_row: trn.sourceRow,
      external_reference: extRef,
      person_name: personName,
      description,
      gross_amount_cents: signed.absCents,
      net_amount_cents: signed.absCents,
      settlement_date: posted.date,
      payment_method: null,
      raw_payload: rawPayload,
      normalized_hash: ofxNormalizedHash({
        sourceSystem: "sicredi",
        accountCode: account.code,
        settlementDate: posted.date,
        amountCents: signed.absCents,
        direction: signed.direction,
        description,
        externalReference: extRef,
      }),
    });
    settlementDates.push(posted.date);
    if (signed.direction === "credit") {
      stats.credits_count += 1;
      stats.credits_cents += signed.absCents;
    } else {
      stats.debits_count += 1;
      stats.debits_cents += signed.absCents;
    }
  }

  stats.errors = errors.length;
  const minSettlement = settlementDates.length ? settlementDates.reduce((a, b) => (a < b ? a : b)) : null;
  const maxSettlement = settlementDates.length ? settlementDates.reduce((a, b) => (a > b ? a : b)) : null;

  return {
    ok: true,
    file_sha256: fileSha,
    parser_name: OFX_PARSER_NAME,
    parser_version: OFX_PARSER_VERSION,
    account_code: account.code,
    account_resolution: resolution,
    currency: parsed.document.currency,
    period_start: parseOptionalDate(parsed.document.periodStartRaw) ?? minSettlement,
    period_end: parseOptionalDate(parsed.document.periodEndRaw) ?? maxSettlement,
    ledger_balance: parseBalance(parsed.document.ledgerBal),
    avail_balance: parseBalance(parsed.document.availBal),
    entries,
    errors,
    stats,
  };
}
