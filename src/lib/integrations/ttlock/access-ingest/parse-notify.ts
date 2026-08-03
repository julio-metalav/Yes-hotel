import { MAX_NOTIFY_PAYLOAD_BYTES, MAX_NOTIFY_RECORDS } from "./constants";
import type {
  ParseNotifyResult,
  TtlockAccessNotifyPayloadRaw,
  TtlockAccessRecordParsed,
  TtlockAccessRecordRaw,
} from "./types";

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeSuccess(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function parseOneRecord(raw: unknown, index: number): TtlockAccessRecordParsed | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as TtlockAccessRecordRaw;
  const recordType = asFiniteNumber(r.recordType);
  const lockDate = asFiniteNumber(r.lockDate);
  const success = normalizeSuccess(r.success);
  if (recordType == null || lockDate == null || success == null) return null;
  if (!Number.isInteger(recordType)) return null;
  if (!Number.isFinite(lockDate) || lockDate < 0) return null;

  const out: TtlockAccessRecordParsed = {
    recordType,
    success,
    lockDate,
    index,
  };

  const serverDate = asFiniteNumber(r.serverDate);
  if (serverDate != null) out.serverDate = serverDate;
  const eq = asFiniteNumber(r.electricQuantity);
  if (eq != null) out.electricQuantity = eq;
  if (typeof r.username === "string" && r.username.trim()) out.username = r.username.trim();
  if (typeof r.keyboardPwd === "string" && r.keyboardPwd.length > 0) {
    out.keyboardPwd = r.keyboardPwd;
  } else if (typeof r.keyboardPwd === "number" && Number.isFinite(r.keyboardPwd)) {
    out.keyboardPwd = String(r.keyboardPwd);
  }
  const native =
    (typeof r.recordId === "string" && r.recordId) ||
    (typeof r.recordId === "number" && String(r.recordId)) ||
    (typeof r.id === "string" && r.id) ||
    (typeof r.id === "number" && String(r.id)) ||
    null;
  if (native) out.nativeRecordId = native;

  return out;
}

/**
 * Faz parse do Notify. Records malformados isolados são descartados do lote
 * (não derrubam o lote inteiro se ao menos o envelope for válido).
 * Lote vazio após filtro → empty_batch.
 */
export function parseTtlockAccessNotifyPayload(
  body: unknown,
  options?: { rawByteLength?: number },
): ParseNotifyResult {
  if (options?.rawByteLength != null && options.rawByteLength > MAX_NOTIFY_PAYLOAD_BYTES) {
    return { ok: false, error: "Payload excede limite de tamanho.", code: "too_large" };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Payload raiz inválido.", code: "malformed" };
  }

  const raw = body as TtlockAccessNotifyPayloadRaw;
  const lockId = asFiniteNumber(raw.lockId);
  if (lockId == null || !Number.isInteger(lockId)) {
    return { ok: false, error: "lockId inválido.", code: "malformed" };
  }

  if (!Array.isArray(raw.records)) {
    return { ok: false, error: "records deve ser array.", code: "malformed" };
  }

  if (raw.records.length > MAX_NOTIFY_RECORDS) {
    return { ok: false, error: "Quantidade de records excede limite.", code: "too_many_records" };
  }

  const records: TtlockAccessRecordParsed[] = [];
  for (let i = 0; i < raw.records.length; i += 1) {
    const parsed = parseOneRecord(raw.records[i], i);
    if (parsed) records.push(parsed);
  }

  if (records.length === 0) {
    return { ok: false, error: "Lote sem records válidos.", code: "empty_batch" };
  }

  const lockMac = typeof raw.lockMac === "string" ? raw.lockMac : undefined;

  return {
    ok: true,
    parsed: {
      lockId,
      lockMac,
      records,
    },
  };
}
