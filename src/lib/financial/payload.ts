/**
 * Minimização de PII no remanescente estrutural (raw_payload).
 * O arquivo original permanece no bucket privado.
 */

import { RAW_PAYLOAD_ALLOWED_KEYS, RAW_PAYLOAD_FORBIDDEN_KEYS } from "./types.ts";

const FORBIDDEN = new Set<string>(RAW_PAYLOAD_FORBIDDEN_KEYS);
const ALLOWED = new Set<string>(RAW_PAYLOAD_ALLOWED_KEYS);

export function rawPayloadHasForbiddenKey(payload: unknown): boolean {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return false;
  return Object.keys(payload).some((key) => FORBIDDEN.has(key));
}

export function isRawPayloadMinimized(payload: unknown): boolean {
  if (payload == null) return true;
  if (typeof payload !== "object" || Array.isArray(payload)) return false;
  const keys = Object.keys(payload);
  if (keys.some((key) => FORBIDDEN.has(key))) return false;
  return keys.every((key) => ALLOWED.has(key));
}

export function assertRawPayloadMinimized(payload: unknown): void {
  if (!isRawPayloadMinimized(payload)) {
    throw new Error("raw_payload deve ser allowlist sanitizada; PII completo fica só no arquivo original");
  }
}
