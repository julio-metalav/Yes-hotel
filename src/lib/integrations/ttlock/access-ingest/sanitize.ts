import type {
  TtlockAccessNotifyParsed,
  TtlockAccessNotifySanitized,
  TtlockAccessRecordParsed,
  TtlockAccessRecordSanitized,
} from "./types";

const SENSITIVE_KEY_RE =
  /keyboardPwd|password|senha|passwd|secret|token|authorization|apikey|api_key/i;

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

/** Serializa e garante que nenhuma senha/secret aparece no JSON. */
export function assertSanitizedPayloadSafe(value: unknown): void {
  const json = JSON.stringify(value);
  if (!json) return;
  if (SENSITIVE_KEY_RE.test(json)) {
    throw new Error("Payload sanitizado contém chave sensível proibida.");
  }
  // Valor típico de senha numérica TTLock não deve aparecer como string solta se veio do raw.
  if (/"keyboardPwd"\s*:/i.test(json)) {
    throw new Error("keyboardPwd presente no payload sanitizado.");
  }
}

export function stripEphemeralPassword(record: TtlockAccessRecordParsed): void {
  if ("keyboardPwd" in record) {
    delete record.keyboardPwd;
  }
}
