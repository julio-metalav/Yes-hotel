/** Extração civil YYYY-MM-DD sem I/O. Isolada para não puxar TTLock. */

export function extractYmdSafe(value: string): string {
  const m = String(value ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) {
    throw new Error(`Data civil ausente ou inválida: ${value}`);
  }
  return m[1];
}
