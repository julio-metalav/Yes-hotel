/**
 * Resolução fail-closed da conta Yes a partir do OFX.
 * Não usa nome de arquivo. Não persiste agência/conta completa.
 */

import {
  SICREDI_BANK_IDS,
  type AccountResolutionMethod,
  type OfxAccountFingerprint,
  type OfxAccountHint,
  type OfxBankAccount,
} from "./types.ts";

export type AccountResolveOk = { ok: true; code: string; method: AccountResolutionMethod };
export type AccountResolveErr = { ok: false; code: "account_unresolved"; message: string };
export type AccountResolveResult = AccountResolveOk | AccountResolveErr;

export function accountIdLast4(acctId: string | null | undefined): string | null {
  const digits = String(acctId ?? "").replace(/\D/g, "");
  if (digits.length < 2) return null;
  return digits.slice(-4);
}

export function maskAccountId(acctId: string | null | undefined): string | null {
  return accountIdLast4(acctId);
}

function digitsOnly(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length ? digits : null;
}

function normalizeAcctType(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim().toUpperCase();
  return text || null;
}

export function extractOfxFingerprint(ofx: OfxBankAccount): OfxAccountFingerprint {
  return {
    bank_id: digitsOnly(ofx.bankId),
    branch_fingerprint: accountIdLast4(ofx.branchId),
    account_last4: ofx.acctIdLast4 ?? accountIdLast4(ofx.acctId),
    account_type: normalizeAcctType(ofx.acctType),
  };
}

export function parseOfxFingerprint(metadata: unknown): OfxAccountFingerprint | null {
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const ofx = (metadata as { ofx?: unknown }).ofx;
  if (ofx == null || typeof ofx !== "object" || Array.isArray(ofx)) return null;
  const row = ofx as Record<string, unknown>;
  if ("account_number" in row || "acct_id" in row || "conta" in row) return null;
  return {
    bank_id: digitsOnly(row.bank_id == null ? null : String(row.bank_id)),
    branch_fingerprint: accountIdLast4(row.branch_fingerprint == null ? null : String(row.branch_fingerprint)),
    account_last4: accountIdLast4(row.account_last4 == null ? null : String(row.account_last4)),
    account_type: normalizeAcctType(row.account_type == null ? null : String(row.account_type)),
  };
}

export function isOfxFingerprintComplete(fp: OfxAccountFingerprint | null | undefined): boolean {
  return Boolean(fp?.bank_id && fp.account_last4 && fp.account_last4.length >= 2);
}

export function maskOfxFingerprint(fp: OfxAccountFingerprint | null | undefined): string {
  if (!fp) return "(ausente)";
  const last4 = fp.account_last4 ?? "";
  const last2 = last4.length >= 2 ? last4.slice(-2) : "??";
  return `bank=${fp.bank_id ?? "?"} type=${fp.account_type ?? "?"} last4=**${last2} branch=${fp.branch_fingerprint ?? "null"}`;
}

/** Comparação exata dos campos cadastrados. Sem similaridade. */
export function ofxFingerprintsMatch(file: OfxAccountFingerprint, registered: OfxAccountFingerprint): boolean {
  if (!isOfxFingerprintComplete(registered) || !isOfxFingerprintComplete(file)) return false;
  if (file.account_last4 !== registered.account_last4) return false;
  if (registered.bank_id && file.bank_id !== registered.bank_id) return false;
  if (registered.branch_fingerprint && file.branch_fingerprint !== registered.branch_fingerprint) return false;
  if (registered.account_type && file.account_type !== registered.account_type) return false;
  return true;
}

export function resolveOfxAccount(input: {
  ofx: OfxBankAccount;
  expectedCode?: string | null;
  knownAccounts: readonly OfxAccountHint[];
}): AccountResolveResult {
  const bankId = String(input.ofx.bankId ?? "").replace(/\D/g, "");
  if (bankId && !SICREDI_BANK_IDS.includes(bankId as (typeof SICREDI_BANK_IDS)[number])) {
    return { ok: false, code: "account_unresolved", message: "BANKID OFX não é Sicredi" };
  }

  const last4 = input.ofx.acctIdLast4 ?? accountIdLast4(input.ofx.acctId);
  const expected = String(input.expectedCode ?? "").trim();
  const known = input.knownAccounts;

  const clash = last4
    ? known.find((a) => a.account_mask && a.account_mask === last4 && a.code !== expected)
    : undefined;

  if (expected) {
    const hinted = known.find((a) => a.code === expected);
    if (!hinted) {
      return { ok: false, code: "account_unresolved", message: "conta esperada ausente do catálogo" };
    }
    if (clash && clash.code !== hinted.code) {
      return { ok: false, code: "account_unresolved", message: "máscara OFX pertence a outra conta Yes" };
    }
    if (hinted.account_mask && last4 && last4 === hinted.account_mask) {
      return { ok: true, code: hinted.code, method: "mask" };
    }
    // Hint do operador: a máscara cadastrada pode ser apelido (ex.: 0911) e não o last4 do OFX.
    // Sem fingerprint persistido, não verificamos o last4 real. Não usar nome de arquivo.
    return { ok: true, code: hinted.code, method: "operator_hint" };
  }

  if (last4) {
    const masked = known.filter((a) => a.account_mask === last4);
    if (masked.length === 1) return { ok: true, code: masked[0]!.code, method: "mask" };
    if (masked.length > 1) {
      return { ok: false, code: "account_unresolved", message: "máscara OFX ambígua no catálogo" };
    }
  }

  return { ok: false, code: "account_unresolved", message: "não foi possível identificar a conta univocamente" };
}

export function assertHintedFingerprint(input: {
  file: OfxAccountFingerprint;
  expectedCode: string;
  knownAccounts: readonly OfxAccountHint[];
}):
  | { ok: true; method: "fingerprint" }
  | { ok: false; code: "account_fingerprint_mismatch"; message: string } {
  const hinted = input.knownAccounts.find((a) => a.code === input.expectedCode);
  const registered = hinted?.ofx_fingerprint ?? null;
  if (!hinted || !isOfxFingerprintComplete(registered)) {
    return { ok: false, code: "account_fingerprint_mismatch", message: "fingerprint cadastrado ausente ou incompleto" };
  }
  const otherMatch = input.knownAccounts.find(
    (a) =>
      a.code !== input.expectedCode &&
      a.ofx_fingerprint &&
      ofxFingerprintsMatch(input.file, a.ofx_fingerprint),
  );
  if (otherMatch) {
    return { ok: false, code: "account_fingerprint_mismatch", message: "fingerprint do arquivo não confere com a conta informada" };
  }
  if (!ofxFingerprintsMatch(input.file, registered)) {
    return { ok: false, code: "account_fingerprint_mismatch", message: "fingerprint do arquivo não confere com a conta informada" };
  }
  return { ok: true, method: "fingerprint" };
}
