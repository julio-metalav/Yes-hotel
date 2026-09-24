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
  FetchHitsUpdatedReservationsResult,
  HitsSandboxReservationRow,
} from "./hits-gateway-read.ts";

/** Trava de escrita do snapshot (env da Edge). Ligar primeiro só em HOMO. */
export const HITS_SNAPSHOT_WRITE_ENV = "HITS_SNAPSHOT_WRITE_ENABLED";

export const HITS_SNAPSHOT_RPC_START = "hits_snapshot_sync_start";
export const HITS_SNAPSHOT_RPC_APPLY = "hits_snapshot_sync_apply";
export const HITS_SNAPSHOT_RPC_FAIL = "hits_snapshot_sync_fail";
/** Incremental (Type=2): upsert só do que mudou + remoção só de canceladas explícitas. */
export const HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL = "hits_snapshot_sync_apply_incremental";
/** Após uma leitura completa bem-sucedida: fixa o cursor da incremental. */
export const HITS_SNAPSHOT_RPC_SET_CURSOR = "hits_snapshot_sync_set_cursor";

export type SyncMode = "full" | "incremental";

/**
 * Sem cursor (ou cursor ilegível) → carga completa inicial (bootstrap), que ao
 * terminar `ok` fixa o cursor. Com cursor válido → incremental, sempre. Não há
 * leitura completa periódica automática; a completa continua disponível como
 * fallback (cursor nulo) e pela chamada sem a trava incremental.
 */
export function decideSyncMode(input: { cursorAt: string | null | undefined }): SyncMode {
  const raw = String(input.cursorAt ?? "").trim();
  if (!raw) return "full";
  return Number.isFinite(Date.parse(raw)) ? "incremental" : "full";
}

/**
 * Fuso do hotel (America/Campo_Grande = UTC−04:00, sem horário de verão) —
 * mesma premissa do scheduler (migration 20260922100000). As datas
 * InitialDate/FinalDate são dias no calendário do HITS; o dia local do hotel é
 * a melhor aproximação disponível.
 */
export const HITS_HOTEL_UTC_OFFSET_MINUTES = -240;
/**
 * Margem antes do cursor, em minutos, só para a virada do dia: cobre a duração
 * do ciclo (≤ 110 s) e uma diferença de fuso do HITS de até 1 h a oeste.
 */
export const HITS_INCREMENTAL_CURSOR_MARGIN_MINUTES = 60;

/** `YYYY-MM-DD` no dia local do hotel. */
export function hotelLocalYmd(ms: number): string {
  return new Date(ms + HITS_HOTEL_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/**
 * Janela Type=2 (dias no calendário, inclusiva). O gateway/HITS só aceitam
 * `YYYY-MM-DD`, então a menor janela segura é:
 *   InitialDate = dia local de (cursor − 60 min): na maior parte do dia é o
 *                 próprio dia do cursor; só na 1ª hora após a meia-noite local
 *                 inclui o dia anterior (virada do dia + margem de fuso).
 *   FinalDate   = dia local de agora + 1 dia: os carimbos do HITS observados
 *                 vêm em −03:00 (fixture real), 1 h à frente de Campo Grande;
 *                 à noite o HITS já está no dia seguinte — sem o +1, alterações
 *                 entre 23:00 e 24:00 locais só apareceriam após a virada.
 * Custo da granularidade diária: a cada ciclo o HITS devolve TODAS as reservas
 * atualizadas nesses dias, e cada uma custa 1 detalhe — repetido a cada 10 min
 * enquanto o dia não vira. É o teto de detalhes por ciclo.
 */
export function incrementalWindow(input: { cursorAt: string; nowMs: number }): {
  from: string;
  to: string;
} {
  const cursorMs = Date.parse(input.cursorAt);
  return {
    from: hotelLocalYmd(cursorMs - HITS_INCREMENTAL_CURSOR_MARGIN_MINUTES * 60_000),
    to: hotelLocalYmd(input.nowMs + 86_400_000),
  };
}

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

/** Presente só quando o ciclo rodou com cursor (readState/readIncremental informados). */
export type SyncModeInfo = {
  mode: SyncMode;
  /** Janela da incremental (dias, inclusiva); null na completa. */
  window: { from: string; to: string } | null;
  /** Canceladas explícitas (status 2 no detalhe) removidas do snapshot. */
  cancelled_count: number;
  /** Cursor avançou para o início deste ciclo (só em ciclo `ok` completo). */
  cursor_advanced: boolean;
  /** Início do ciclo (ISO) — candidato a cursor. */
  cycle_started_at: string;
};

export type SnapshotOutcome =
  | ({
      persisted: true;
      batch_id: string;
      status: "ok" | "partial";
      rows_upserted: number;
      rows_removed: number;
      failed_count: number;
      start_error: string | null;
    } & Partial<SyncModeInfo>)
  | ({
      persisted: false;
      batch_id: string;
      stage: "start" | "read" | "apply" | "listing_incomplete";
      error: string;
    } & Partial<SyncModeInfo>);

export type RunHitsSnapshotSyncResult = {
  /** Resultado da leitura, quando ela funcionou (a resposta da Edge continua igual). */
  result: FetchHitsSandboxReservationsResult | FetchHitsUpdatedReservationsResult | null;
  /** Erro da leitura, quando ela falhou (a Edge devolve 502 como antes). */
  readError: unknown;
  snapshot: SnapshotOutcome;
};

/** Estado mínimo lido antes do ciclo (service_role, só leitura). */
export type SnapshotSyncState = {
  last_cursor_at?: string | null;
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
  /** Leitura completa (Type=0). Sempre exigida: é o fallback da incremental. */
  read: () => Promise<FetchHitsSandboxReservationsResult>;
  /**
   * Modo incremental (opcional; sem estes dois, o ciclo é sempre completo e o
   * comportamento é idêntico ao anterior):
   *  - readState: lê `last_cursor_at` do estado (service_role, só leitura);
   *  - readIncremental: Type=2 na janela → detalhes só dos ids devolvidos.
   */
  readState?: () => Promise<SnapshotSyncState | null>;
  readIncremental?: (
    window: { from: string; to: string },
    todayYmd: string,
  ) => Promise<FetchHitsUpdatedReservationsResult>;
  nowMs?: () => number;
}): Promise<RunHitsSnapshotSyncResult> {
  const batchId = String(input.batchId || "").trim();
  const now = input.nowMs ?? (() => Date.now());
  const cycleStartMs = now();
  const cycleStartIso = new Date(cycleStartMs).toISOString();
  let startError: string | null = null;

  // Modo: só quando o chamador dá acesso ao estado e à leitura incremental.
  let mode: SyncMode = "full";
  let window: { from: string; to: string } | null = null;
  const withCursor = typeof input.readState === "function" && typeof input.readIncremental === "function";
  if (withCursor) {
    let cursorAt: string | null = null;
    try {
      const state = await input.readState!();
      cursorAt = state?.last_cursor_at ?? null;
    } catch {
      cursorAt = null; // estado ilegível → completa (fail-safe)
    }
    mode = decideSyncMode({ cursorAt });
    if (mode === "incremental") {
      window = incrementalWindow({ cursorAt: cursorAt!, nowMs: cycleStartMs });
    }
  }
  const info = (extra: Partial<SyncModeInfo> = {}): Partial<SyncModeInfo> =>
    withCursor
      ? { mode, window, cancelled_count: 0, cursor_advanced: false, cycle_started_at: cycleStartIso, ...extra }
      : {};

  try {
    const started = await input.rpc(HITS_SNAPSHOT_RPC_START, { p_batch_id: batchId });
    if (started.error) startError = errorMessage(started.error);
  } catch (e) {
    startError = errorMessage(e);
  }

  let result: FetchHitsSandboxReservationsResult | FetchHitsUpdatedReservationsResult;
  try {
    result =
      mode === "incremental"
        ? await input.readIncremental!(window!, hotelLocalYmd(cycleStartMs))
        : await input.read();
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
      snapshot: { persisted: false, batch_id: batchId, stage: "read", error, ...info() },
    };
  }

  // Orçamento esgotado ANTES de a listagem terminar: o conjunto de ids é
  // desconhecido, então o `apply` removeria reservas válidas que só não foram
  // listadas (completa) ou perderia alterações (incremental). Registra como
  // falha e preserva o snapshot inteiro; o cursor não avança.
  if (result.listing_complete === false) {
    const error = "time_budget: listagem incompleta; snapshot anterior preservado";
    try {
      await input.rpc(HITS_SNAPSHOT_RPC_FAIL, { p_batch_id: batchId, p_error: error });
    } catch {
      /* diagnóstico; a projeção já está preservada por não haver apply */
    }
    return {
      result,
      readError: null,
      snapshot: { persisted: false, batch_id: batchId, stage: "listing_incomplete", error, ...info() },
    };
  }

  // Detalhes não lidos por orçamento (`time_budget`) entram em failedIds como
  // qualquer detalhe falho: a RPC preserva a fotografia anterior deles.
  const failedIds = (result.failed ?? [])
    .map((f) => String(f?.external_reservation_id ?? "").trim())
    .filter(Boolean);
  const status: "ok" | "partial" = failedIds.length > 0 ? "partial" : "ok";
  const cancelledIds =
    mode === "incremental"
      ? ((result as FetchHitsUpdatedReservationsResult).cancelled_ids ?? [])
          .map((id) => String(id ?? "").trim())
          .filter(Boolean)
      : [];

  try {
    let applied: { data: unknown; error: { message?: string } | null };
    if (mode === "incremental") {
      // Upsert só do que mudou; remove só canceladas explícitas; NUNCA remove
      // por ausência. Cursor avança apenas em ciclo `ok` (sem detalhe falho):
      // em `partial`, a janela seguinte recobre os ids que falharam.
      applied = await input.rpc(HITS_SNAPSHOT_RPC_APPLY_INCREMENTAL, {
        p_batch_id: batchId,
        p_rows: toSnapshotRows(result.rows),
        p_failed_ids: failedIds,
        p_cancelled_ids: cancelledIds,
        p_status: status,
        p_stopped_reason: result.stopped_reason,
        p_cursor_at: status === "ok" ? cycleStartIso : null,
      });
    } else {
      applied = await input.rpc(HITS_SNAPSHOT_RPC_APPLY, {
        p_batch_id: batchId,
        p_rows: toSnapshotRows(result.rows),
        p_failed_ids: failedIds,
        p_status: status,
        p_stopped_reason: result.stopped_reason,
      });
    }
    if (applied.error) {
      return {
        result,
        readError: null,
        snapshot: {
          persisted: false,
          batch_id: batchId,
          stage: "apply",
          error: errorMessage(applied.error),
          ...info(),
        },
      };
    }
    const row = firstRow(applied.data);

    // Completa bem-sucedida (`ok`) com cursor habilitado: fixa o cursor no
    // início deste ciclo. Em `partial` o cursor não avança: sem cursor o
    // próximo ciclo repete a completa; com cursor antigo segue incremental.
    let cursorAdvanced = mode === "incremental" && status === "ok";
    if (withCursor && mode === "full" && status === "ok") {
      try {
        const set = await input.rpc(HITS_SNAPSHOT_RPC_SET_CURSOR, {
          p_batch_id: batchId,
          p_cursor_at: cycleStartIso,
        });
        cursorAdvanced = !set.error;
      } catch {
        cursorAdvanced = false;
      }
    }

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
        ...info({ cancelled_count: cancelledIds.length, cursor_advanced: cursorAdvanced }),
      },
    };
  } catch (e) {
    return {
      result,
      readError: null,
      snapshot: { persisted: false, batch_id: batchId, stage: "apply", error: errorMessage(e), ...info() },
    };
  }
}
