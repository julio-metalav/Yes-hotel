/**
 * Tipos do payload TTLock Lock Records Notify / polling futuro.
 * keyboardPwd pode existir na entrada; nunca persistir/logar/retornar.
 */

export type TtlockAccessRecordRaw = {
  recordType?: unknown;
  success?: unknown;
  username?: unknown;
  keyboardPwd?: unknown;
  lockDate?: unknown;
  serverDate?: unknown;
  electricQuantity?: unknown;
  /** ID nativo se a plataforma enviar no futuro. */
  recordId?: unknown;
  id?: unknown;
};

export type TtlockAccessNotifyPayloadRaw = {
  lockId?: unknown;
  lockMac?: unknown;
  records?: unknown;
};

export type TtlockAccessRecordParsed = {
  recordType: number;
  success: boolean;
  username?: string;
  /** Somente memória — descartar após correlação. */
  keyboardPwd?: string;
  lockDate: number;
  serverDate?: number;
  electricQuantity?: number;
  nativeRecordId?: string;
  /** Índice estável no array original. */
  index: number;
};

export type TtlockAccessNotifyParsed = {
  lockId: number;
  lockMac?: string;
  records: TtlockAccessRecordParsed[];
};

export type TtlockAccessRecordSanitized = {
  recordType: number;
  success: boolean;
  username_masked?: string;
  lockDate: number;
  serverDate?: number;
  electricQuantity?: number;
  index: number;
  nativeRecordId?: string;
};

export type TtlockAccessNotifySanitized = {
  lockId: number;
  lockMac_masked?: string;
  records: TtlockAccessRecordSanitized[];
};

export type ParseNotifyResult =
  | { ok: true; parsed: TtlockAccessNotifyParsed }
  | { ok: false; error: string; code: "malformed" | "too_large" | "too_many_records" | "empty_batch" };
