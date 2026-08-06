/**
 * Sanitização de payloads TTLock / outbox.
 * Detecta chaves sensíveis (com ":"), não substrings soltas como a palavra "senha" em texto.
 */

import type {
  TtlockAccessNotifyParsed,
  TtlockAccessNotifySanitized,
  TtlockAccessRecordParsed,
  TtlockAccessRecordSanitized,
} from "./types";

const SENSITIVE_KEY_PATTERN_RE =
  /["']?(?:keyboardPwd|newKeyboardPwd|password|passwd|senha|secret|token|authorization|apikey|api_key|accessToken|clientSecret)["']?\s*:/i;

export function maskLockMac(mac: string | undefined): string | undefined {
  if (!mac) return undefined;
  const clean = String(mac).replace(/[^a-fA-F0-9]/g, "");
  if (clean.length < 4) return "***";
  return `${clean.slice(0, 2)}:**:**:**:**:${clean.slice(-2)}`;
}

export function maskUsername(username: string | undefined): string | undefined {
  if (!username) return undefined;
  const s = String(username);
  if (s.length <= 2) return "**";
  return `${s.slice(0, 1)}***${s.slice(-1)}`;
}

export function sanitizeAccessRecord(record: TtlockAccessRecordParsed): TtlockAccessRecordSanitized {
  const out: TtlockAccessRecordSanitized = {
    recordType: record.recordType,
    success: record.success,
    lockDate: record.lockDate,
    index: record.index,
  };
  if (record.serverDate != null) out.serverDate = record.serverDate;
  if (record.electricQuantity != null) out.electricQuantity = record.electricQuantity;
  if (record.nativeRecordId) out.nativeRecordId = record.nativeRecordId;
  const masked = maskUsername(record.username);
  if (masked) out.username_masked = masked;
  return out;
}

export function sanitizeNotifyPayload(parsed: TtlockAccessNotifyParsed): TtlockAccessNotifySanitized {
  return {
    lockId: parsed.lockId,
    lockMac_masked: maskLockMac(parsed.lockMac),
    records: parsed.records.map(sanitizeAccessRecord),
  };
}

/** Serializa e garante que nenhuma chave sensível aparece no JSON. */
export function assertSanitizedPayloadSafe(value: unknown): void {
  const json = JSON.stringify(value);
  if (!json) return;
  if (SENSITIVE_KEY_PATTERN_RE.test(json)) {
    throw new Error("Payload sanitizado contém chave sensível proibida.");
  }
  if (/"keyboardPwd"\s*:/i.test(json) || /"newKeyboardPwd"\s*:/i.test(json)) {
    throw new Error("keyboardPwd presente no payload sanitizado.");
  }
}

export function stripEphemeralPassword(record: TtlockAccessRecordParsed): void {
  if ("keyboardPwd" in record) {
    delete record.keyboardPwd;
  }
}
