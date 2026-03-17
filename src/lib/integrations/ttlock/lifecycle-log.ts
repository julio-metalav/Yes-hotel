/**
 * Log estruturado do lifecycle TTLock (hardening).
 * Prefixo único para filtro; não expõe secrets/tokens.
 */

export type TtlockLifecycleAction = "provision" | "delete" | "revoke" | "cleanup_delete";
export type TtlockLifecycleSource = "edge_function" | "app_client" | "job_cleanup";
export type TtlockLifecycleStatus = "start" | "success" | "error";

export interface TtlockLifecycleLogEntry {
  action: TtlockLifecycleAction;
  source: TtlockLifecycleSource;
  reserva_id?: string;
  credencial_id?: string;
  credencial_item_id?: string;
  codigo_logico_destino?: string;
  remote_keyboard_pwd_id?: number;
  lock_id?: string | number;
  status: TtlockLifecycleStatus;
  error_message?: string;
  attempt?: number;
  timestamp: string;
}

const PREFIX = "[TTLOCK_LIFECYCLE]";

export function logTtlockLifecycle(entry: TtlockLifecycleLogEntry): void {
  if (typeof console === "undefined") return;
  try {
    console.log(PREFIX, JSON.stringify(entry));
  } catch {
    console.log(PREFIX, String(entry));
  }
}
