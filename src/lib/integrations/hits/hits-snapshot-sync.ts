/**
 * Sync do snapshot operacional HITS — lógica pura, sem rede e sem Deno.
 *
 * A Edge hits-reservations-preview continua fazendo a MESMA leitura de sempre
 * (uma rodada de listagens + detalhes pelo gateway). O que muda: quando a
 * chamada tem a forma do scheduler e a trava HITS_SNAPSHOT_WRITE_ENABLED=true,
 * o resultado é gravado no nosso Supabase pelas RPCs hits_snapshot_sync_*
 * (service_role). A UI passa a ler o snapshot em vez de chamar o HITS ao vivo.
 *
 * Nada aqui escreve no HITS. A única escrita é no nosso banco, via RPC.
 *
 * Contrato de atomicidade (garantido pelas RPCs, migration
 * 20260924180000_hits_reservas_snapshot.sql):
 *   start  → só marca o ciclo como iniciado (batch_id);
 *   apply  → upsert do lote + remoção do que saiu da janela, numa transação;
 *   fail   → só registra o erro; nenhuma linha do snapshot é tocada.
 */

import type {
  FetchHitsSandboxReservationsResult,
  HitsSandboxReservationRow,
} from "./hits-gateway-read.ts";

/** Trava de escrita do snapshot (env da Edge). Ligar primeiro só em HOMO. */
export const HITS_SNAPSHOT_WRITE_ENV = "HITS_SNAPSHOT_WRITE_ENABLED";

export const HITS_SNAPSHOT_RPC_START = "hits_snapshot_sync_start";
export const HITS_SNAPSHOT_RPC_APPLY = "hits_snapshot_sync_apply";
export const HITS_SNAPSHOT_RPC_FAIL = "hits_snapshot_sync_fail";

/** Mesmo teto de mensagem da RPC de falha. */
export const HITS_SNAPSHOT_ERROR_MAX_CHARS = 300;

/**
 * Parâmetros de query que caracterizam uma leitura ad hoc (janela custom, ids,
 * paginação). O scheduler chama sem nenhum deles — e só essa forma alimenta o
 * snapshot, para a projeção refletir sempre a janela default do scheduler.
 */
export const HITS_SNAPSHOT_AD_HOC_PARAMS = ["ids", "date_from", "date_to", "page", "size"] as const;

export type SnapshotDecision =
  | { persist: true }
  | {
      persist: false;
      reason: "flag_off" | "has_query_params" | "user_session_caller";
    };

/**
 * Papel (claim `role`) do Bearer, sem verificar assinatura: o gateway de
 * funções já verificou o JWT (verify_jwt). Devolve "" se não for um JWT.
 */
export function bearerRole(authorization: string | null | undefined): string {
  const raw = String(authorization ?? "").trim();
  const token = raw.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length < 2) return "";
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : "";
  } catch {
    return "";
  }
}

/**
 * Decide se esta chamada alimenta o snapshot.
 *
 * Persistir exige: trava ligada; nenhum parâmetro ad hoc; e o chamador NÃO ser
 * uma sessão de usuário (JWT role=authenticated). O scheduler chama com a anon
 * key (role=anon); uma chave não-JWT (publishable) também é aceita — em ambos
 * os casos não há sessão de usuário. Uma página antiga ainda aberta no
 * navegador (JWT do usuário) nunca grava.
 */
export function shouldPersistSnapshot(input: {
  writeEnabled: string | undefined | null;
  searchParams: URLSearchParams;
  authorization: string | null | undefined;
}): SnapshotDecision {
  if (String(input.writeEnabled ?? "").trim() !== "true") {
    return { persist: false, reason: "flag_off" };
  }
  for (const key of HITS_SNAPSHOT_AD_HOC_PARAMS) {
    if (input.searchParams.has(key)) return { persist: false, reason: "has_query_params" };
  }
  if (bearerRole(input.authorization) === "authenticated") {
    return { persist: false, reason: "user_session_caller" };
  }
  return { persist: true };
}

/** Linha gravada no snapshot: exatamente o shape da Edge, por allowlist. */
export type HitsSnapshotRow = {
  external_reservation_id: string;
  apartamento: string;
  hospede_principal: string;
  check_in: string;
  check_out: string;
  status_reserva: "ativa" | "cancelada";
  ciclo_hits: "confirmada" | "hospedada";
  total_hospedes: number;
};

/**
 * Allowlist explícita: copia campo a campo. Nunca espalha o objeto de origem,
 * então nenhum campo extra (contato, documento, financeiro, raw) chega ao banco.
 */
export function toSnapshotRows(rows: ReadonlyArray<HitsSandboxReservationRow>): HitsSnapshotRow[] {
  const out: HitsSnapshotRow[] = [];
  for (const r of rows) {
    const id = String(r?.external_reservation_id ?? "").trim();
    if (!id) continue;
    out.push({
      external_reservation_id: id,
      apartamento: String(r.apartamento ?? "").trim(),
      hospede_principal: String(r.hospede_principal ?? "").trim(),
      check_in: String(r.check_in ?? "").slice(0, 10),
      check_out: String(r.check_out ?? "").slice(0, 10),
      status_reserva: r.status_reserva === "cancelada" ? "cancelada" : "ativa",
      ciclo_hits: r.ciclo_hits === "hospedada" ? "hospedada" : "confirmada",
      total_hospedes: Math.max(1, Number(r.total_hospedes) || 1),
    });
  }
  return out;
}

/** Assinatura mínima de `supabase.rpc(fn, args)`, injetável para teste. */
export type SnapshotRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;

export type SnapshotOutcome =
  | {
      persisted: true;
      batch_id: string;
      status: "ok" | "partial";
      rows_upserted: number;
      rows_removed: number;
      failed_count: number;
      start_error: string | null;
    }
  | {
      persisted: false;
      batch_id: string;
      stage: "start" | "read" | "apply";
      error: string;
    };

export type RunHitsSnapshotSyncResult = {
  /** Resultado da leitura, quando ela funcionou (a resposta da Edge continua igual). */
  result: FetchHitsSandboxReservationsResult | null;
  /** Erro da leitura, quando ela falhou (a Edge devolve 502 como antes). */
  readError: unknown;
  snapshot: SnapshotOutcome;
};

function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e ?? "erro");
  return String(msg || "erro").slice(0, HITS_SNAPSHOT_ERROR_MAX_CHARS);
}

function firstRow(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) return (data[0] ?? {}) as Record<string, unknown>;
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return {};
}

/**
 * Um ciclo: start → leitura (a mesma de sempre) → apply | fail.
 *
 * Nunca lança. A leitura é executada exatamente uma vez; se ela falhar, o
 * ciclo é marcado como erro e o snapshot anterior fica intacto. Se `start`
 * falhar, a leitura ainda acontece e `apply` ainda é tentado (o estado é
 * diagnóstico; a projeção é o que importa).
 */
export async function runHitsSnapshotSync(input: {
  rpc: SnapshotRpc;
  batchId: string;
  read: () => Promise<FetchHitsSandboxReservationsResult>;
}): Promise<RunHitsSnapshotSyncResult> {
  const batchId = String(input.batchId || "").trim();
  let startError: string | null = null;

  try {
    const started = await input.rpc(HITS_SNAPSHOT_RPC_START, { p_batch_id: batchId });
    if (started.error) startError = errorMessage(started.error);
  } catch (e) {
    startError = errorMessage(e);
  }

  let result: FetchHitsSandboxReservationsResult;
  try {
    result = await input.read();
  } catch (e) {
    const error = errorMessage(e);
    try {
      await input.rpc(HITS_SNAPSHOT_RPC_FAIL, { p_batch_id: batchId, p_error: error });
    } catch {
      /* registrar a falha é diagnóstico; a leitura já falhou de qualquer forma */
    }
    return {
      result: null,
      readError: e,
      snapshot: { persisted: false, batch_id: batchId, stage: "read", error },
    };
  }

  const failedIds = (result.failed ?? [])
    .map((f) => String(f?.external_reservation_id ?? "").trim())
    .filter(Boolean);
  const status: "ok" | "partial" = failedIds.length > 0 ? "partial" : "ok";

  try {
    const applied = await input.rpc(HITS_SNAPSHOT_RPC_APPLY, {
      p_batch_id: batchId,
      p_rows: toSnapshotRows(result.rows),
      p_failed_ids: failedIds,
      p_status: status,
      p_stopped_reason: result.stopped_reason,
    });
    if (applied.error) {
      return {
        result,
        readError: null,
        snapshot: {
          persisted: false,
          batch_id: batchId,
          stage: "apply",
          error: errorMessage(applied.error),
        },
      };
    }
    const row = firstRow(applied.data);
    return {
      result,
      readError: null,
      snapshot: {
        persisted: true,
        batch_id: batchId,
        status,
        rows_upserted: Number(row.rows_upserted) || 0,
        rows_removed: Number(row.rows_removed) || 0,
        failed_count: failedIds.length,
        start_error: startError,
      },
    };
  } catch (e) {
    return {
      result,
      readError: null,
      snapshot: { persisted: false, batch_id: batchId, stage: "apply", error: errorMessage(e) },
    };
  }
}
