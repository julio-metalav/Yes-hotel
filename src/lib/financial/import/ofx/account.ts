/**
 * Resolução fail-closed da conta Yes a partir do OFX.
 * Não usa nome de arquivo. Não persiste agência/conta completa.
 */

import { SICREDI_BANK_IDS, type AccountResolutionMethod, type OfxAccountHint, type OfxBankAccount } from "./types.ts";

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
