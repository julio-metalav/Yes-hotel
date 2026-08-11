import {
  ACCESS_EVENT_SOURCE_NOTIFY,
  ACCESS_EVENT_SOURCE_POLLING,
  ENV_TTLOCK_ACCESS_IDEMPOTENCY_SECRET,
  ENV_TTLOCK_ACCESS_WEBHOOK_SECRET,
} from "./constants.ts";
import { hmacSha256Hex } from "./crypto-hmac.ts";
import type { TtlockAccessRecordParsed } from "./types.ts";

export type IdempotencyMaterial = {
  lockId: number;
  lockDate: number;
  recordType: number;
  success: boolean;
  /** Material mínimo derivado — nunca a senha em claro no resultado. */
  ephemeralKeyboardPwd?: string;
};

function resolveIdempotencySecret(env: Record<string, string | undefined>): string {
  const dedicated = env[ENV_TTLOCK_ACCESS_IDEMPOTENCY_SECRET];
  if (dedicated && dedicated.trim()) return dedicated;
  const fallback = env[ENV_TTLOCK_ACCESS_WEBHOOK_SECRET];
  if (fallback && fallback.trim()) return fallback;
  throw new Error(
    "Segredo de idempotência ausente (TTLOCK_ACCESS_IDEMPOTENCY_SECRET ou TTLOCK_ACCESS_WEBHOOK_SECRET).",
  );
}

/**
 * source_event_id: ID nativo se existir; senão composto estável.
 * Prefixo de fonte evita colisão UNIQUE(source, source_event_id) entre Notify e polling,
 * mas a idempotency_key é compartilhada para deduplicar o mesmo evento físico.
 */
export function buildSourceEventId(
  source: typeof ACCESS_EVENT_SOURCE_NOTIFY | typeof ACCESS_EVENT_SOURCE_POLLING,
  lockId: number,
  record: TtlockAccessRecordParsed,
): string {
  if (record.nativeRecordId) {
    return `${source}:native:${record.nativeRecordId}`;
  }
  return [
    source,
    lockId,
    record.lockDate,
    record.recordType,
    record.success ? 1 : 0,
    record.index,
  ].join(":");
}

/**
 * idempotency_key = HMAC-SHA256(secret, lockId|lockDate|recordType|success|pwdDigest?)
 *
 * - Nunca usa hash simples de keyboardPwd sozinho.
 * - Se houver senha, inclui digest HMAC interno (não a senha) no material.
 * - Notify e polling do mesmo evento físico geram a MESMA key (sem prefixo de fonte).
 *
 * Colisões: teoricamente possíveis entre locks/eventos distintos com mesmos campos
 * e sem senha; índice estável não entra na key — se dois records no mesmo ms tiverem
 * mesmos campos sem senha, podem colidir. Mitigação: incluir senha quando disponível
 * e, no futuro, recordId nativo na key quando a API fornecer.
 */
export async function buildIdempotencyKey(
  material: IdempotencyMaterial,
  env: Record<string, string | undefined> = typeof process !== "undefined"
    ? (process.env as Record<string, string | undefined>)
    : {},
): Promise<string> {
  const secret = resolveIdempotencySecret(env);
  const parts = [
    String(material.lockId),
    String(material.lockDate),
    String(material.recordType),
    material.success ? "1" : "0",
  ];
  if (material.ephemeralKeyboardPwd) {
    const pwdDigest = await hmacSha256Hex(secret, `pwd:${material.ephemeralKeyboardPwd}`);
    parts.push(pwdDigest);
  }
  const message = parts.join("|");
  return hmacSha256Hex(secret, message);
}
