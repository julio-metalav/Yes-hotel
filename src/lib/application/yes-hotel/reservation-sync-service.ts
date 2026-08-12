/**
 * Serviço de sincronização de reservas (mock ou real via ReservationSourcePort).
 * Idempotente. Não interpreta ausência em página como cancelamento.
 * Modo real bloqueado enquanto HITS_INTEGRATION_ENABLED != true.
 * Persistência do sync não dispara cobrança, DigiSac, senha ou TTLock.
 * Após create operacional, a Edge pode orquestrar FNRH (reserva_criada) sem bloquear o sync.
 */

import { detectReservationChanges } from "../../domain/yes-hotel/reservation-sync-diff.ts";
import type {
  ReservationSourcePort,
  SyncedReservation,
} from "../../domain/yes-hotel/synced-reservation.ts";
import type { ReservationSyncRepository } from "./reservation-sync-repository.ts";

export type ReservationSyncFlags = {
  syncEnabled: boolean;
  mode: "mock" | "real";
  batchSize: number;
  hitsIntegrationEnabled: boolean;
  persistenceEnabled: boolean;
  schemaReady: boolean;
};

export function getReservationSyncFlags(
  env: Record<string, string | undefined> = typeof process !== "undefined"
    ? (process.env as Record<string, string | undefined>)
    : {},
): ReservationSyncFlags {
  const modeRaw = String(env.HITS_RESERVATION_SYNC_MODE ?? "mock").trim().toLowerCase();
  return {
    syncEnabled: String(env.HITS_RESERVATION_SYNC_ENABLED ?? "").trim() === "true",
    mode: modeRaw === "real" ? "real" : "mock",
    batchSize: Math.min(
      500,
      Math.max(1, Number(env.HITS_RESERVATION_SYNC_BATCH_SIZE ?? 100) || 100),
    ),
    hitsIntegrationEnabled: String(env.HITS_INTEGRATION_ENABLED ?? "").trim() === "true",
    persistenceEnabled:
      String(env.HITS_RESERVATION_SYNC_PERSISTENCE_ENABLED ?? "").trim() === "true",
    schemaReady: String(env.HITS_RESERVATION_SCHEMA_READY ?? "").trim() === "true",
  };
}

export type SyncReservationsResult = {
  ok: boolean;
  dry_run: boolean;
  mode: string;
  pages: number;
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  cancelled: number;
  events: number;
  errors: number;
  /** IDs operacionais criados neste run (para orquestração pós-sync, ex. FNRH). */
  createdReservationIds: string[];
  stopped_reason?: string;
  error?: string;
};

export async function syncReservationsFromSource(input: {
  source: ReservationSourcePort;
  repo: ReservationSyncRepository;
  flags?: ReservationSyncFlags;
  dryRun?: boolean;
  maxPages?: number;
  /** Limite duro de reservas processadas (smoke controlado). */
  maxReservations?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  nowIso?: string;
}): Promise<SyncReservationsResult> {
  const flags = input.flags ?? getReservationSyncFlags();
  const dryRun = input.dryRun !== false; // default true
  const nowIso = input.nowIso ?? new Date().toISOString();
  const maxPages = Math.max(1, Math.min(50, input.maxPages ?? 50));
  const maxReservations =
    input.maxReservations != null &&
    Number.isFinite(input.maxReservations) &&
    input.maxReservations > 0
      ? Math.floor(input.maxReservations)
      : null;

  if (!flags.syncEnabled) {
    return emptyResult(dryRun, flags.mode, "sync_disabled");
  }

  if (flags.mode === "real" && !flags.hitsIntegrationEnabled) {
    return emptyResult(dryRun, flags.mode, "hits_real_blocked");
  }

  const runId = dryRun
    ? "dry-run-sync"
    : await input.repo.startSyncRun({
        provider: "hits",
        nowIso,
        dryRun: false,
      });

  let pages = 0;
  let processed = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let cancelled = 0;
  let events = 0;
  let errors = 0;
  let cursor: string | null = null;
  let stopped_reason: string | undefined;
  const createdReservationIds: string[] = [];

  try {
    while (pages < maxPages) {
      const remaining =
        maxReservations != null ? Math.max(0, maxReservations - processed) : null;
      if (remaining === 0) {
        stopped_reason = "max_reservations";
        break;
      }
      const pageSize =
        remaining != null
          ? Math.min(flags.batchSize, remaining)
          : flags.batchSize;
      const page = await input.source.listReservations({
        cursor,
        pageSize,
        dateFrom: input.dateFrom ?? null,
        dateTo: input.dateTo ?? null,
      });
      pages += 1;

      for (const reservation of page.items) {
        if (maxReservations != null && processed >= maxReservations) {
          stopped_reason = "max_reservations";
          break;
        }
        processed += 1;
        try {
          await processOne(reservation, input.repo, dryRun, nowIso, {
            onCreated: (operacionalId) => {
              created += 1;
              if (operacionalId && operacionalId !== "dry-run") {
                createdReservationIds.push(operacionalId);
              }
            },
            onUpdated: () => {
              updated += 1;
            },
            onUnchanged: () => {
              unchanged += 1;
            },
            onCancelled: () => {
              cancelled += 1;
            },
            onEvents: (n) => {
              events += n;
            },
          });
        } catch (e) {
          errors += 1;
          const msg = e instanceof Error ? e.message.slice(0, 200) : "sync_item_error";
          await input.repo.recordSyncError({
            sync_run_id: runId,
            severity: "error",
            step: "upsert",
            message: msg,
            context: { external_reservation_id: reservation.externalReservationId },
          });
        }
      }

      if (stopped_reason === "max_reservations") break;

      if (!page.hasMore || !page.nextCursor) {
        stopped_reason = "no_more_pages";
        break;
      }
      cursor = page.nextCursor;
    }
    if (pages >= maxPages && !stopped_reason) {
      stopped_reason = "max_pages";
    }

    const status = errors > 0 ? (processed > errors ? "partial" : "failed") : "success";
    await input.repo.finishSyncRun(runId, {
      status,
      finished_at: nowIso,
      stats: {
        dry_run: dryRun,
        pages,
        processed,
        created,
        updated,
        unchanged,
        cancelled,
        events,
        errors,
        stopped_reason,
      },
    });

    return {
      ok: errors === 0,
      dry_run: dryRun,
      mode: flags.mode,
      pages,
      processed,
      created,
      updated,
      unchanged,
      cancelled,
      events,
      errors,
      createdReservationIds,
      stopped_reason,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : "sync_failed";
    await input.repo.finishSyncRun(runId, {
      status: "failed",
      finished_at: nowIso,
      stats: { dry_run: dryRun, pages, processed, errors: errors + 1 },
      message: msg,
    });
    return {
      ok: false,
      dry_run: dryRun,
      mode: flags.mode,
      pages,
      processed,
      created,
      updated,
      unchanged,
      cancelled,
      events,
      errors: errors + 1,
      createdReservationIds,
      error: msg,
    };
  }
}

function emptyResult(
  dryRun: boolean,
  mode: string,
  error: string,
): SyncReservationsResult {
  return {
    ok: false,
    dry_run: dryRun,
    mode,
    pages: 0,
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    cancelled: 0,
    events: 0,
    errors: 0,
    createdReservationIds: [],
    error,
  };
}

async function processOne(
  reservation: SyncedReservation,
  repo: ReservationSyncRepository,
  dryRun: boolean,
  nowIso: string,
  counters: {
    onCreated: (operacionalId: string) => void;
    onUpdated: () => void;
    onUnchanged: () => void;
    onCancelled: () => void;
    onEvents: (n: number) => void;
  },
): Promise<void> {
  const previous = await repo.findPmsSnapshot("hits", reservation.externalReservationId);
  const changeEvents = detectReservationChanges(previous, reservation);
  const result = await repo.upsertFromSynced(reservation, changeEvents, { dryRun, nowIso });

  if (result.created) counters.onCreated(result.operacionalId);
  else if (changeEvents.length === 0) counters.onUnchanged();
  else counters.onUpdated();

  if (
    reservation.reservationStatus === "cancelada" &&
    changeEvents.some((e) => e.tipo === "hits_reserva_cancelada")
  ) {
    counters.onCancelled();
  }
  counters.onEvents(dryRun ? changeEvents.length : result.eventsWritten);
}
