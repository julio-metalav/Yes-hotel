/**
 * Separação do patch de credencial: status operacional (obrigatório)
 * vs colunas sync_* (migration 0009 — podem ausentar em produção).
 *
 * Nunca deixar status=provisionada dependente de last_sync_error existir.
 */

export const CREDENCIAL_SYNC_COLUMN_KEYS = [
  "sync_status",
  "last_sync_attempt_at",
  "last_sync_error",
] as const;

export type CredencialSyncColumnKey = (typeof CREDENCIAL_SYNC_COLUMN_KEYS)[number];

export function splitCredencialProvisionDbPatch(
  patch: Record<string, unknown>,
): {
  core: Record<string, unknown>;
  sync: Record<string, unknown>;
} {
  const syncKeySet = new Set<string>(CREDENCIAL_SYNC_COLUMN_KEYS);
  const core: Record<string, unknown> = {};
  const sync: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (syncKeySet.has(key)) sync[key] = value;
    else core[key] = value;
  }
  return { core, sync };
}

export function isMissingSyncColumnError(message: string | null | undefined): boolean {
  const m = String(message ?? "").toLowerCase();
  if (!m) return false;
  return (
    m.includes("last_sync_error") ||
    m.includes("last_sync_attempt_at") ||
    m.includes("sync_status") ||
    (m.includes("schema cache") && m.includes("sync")) ||
    (m.includes("could not find the") && m.includes("column"))
  );
}
