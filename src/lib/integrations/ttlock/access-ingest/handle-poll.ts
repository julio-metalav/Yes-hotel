/**
 * Polling TTLock /v3/lockRecord/list → first-room-access-orchestrator.
 * Mesma idempotency_key do Notify; source = ttlock_polling.
 */

import { processFirstRoomAccessEvent } from "../../../application/yes-hotel/first-room-access-orchestrator.ts";
import type { FirstRoomAccessPorts } from "../../../application/yes-hotel/first-room-access-ports.ts";
import type { ProcessFirstRoomAccessResult } from "../../../application/yes-hotel/first-room-access-types.ts";
import type { TtlockClient } from "../client.ts";
import { ACCESS_EVENT_SOURCE_POLLING, MAX_NOTIFY_RECORDS } from "./constants.ts";
import { buildIdempotencyKey, buildSourceEventId } from "./idempotency.ts";
import { parseTtlockAccessNotifyPayload } from "./parse-notify.ts";
import {
  assertSanitizedPayloadSafe,
  sanitizeNotifyPayload,
  stripEphemeralPassword,
} from "./sanitize.ts";
import type { TtlockAccessRecordParsed } from "./types.ts";

export const ENV_TTLOCK_ACCESS_POLL_ENABLED = "YES_HOTEL_TTLOCK_ACCESS_POLL_ENABLED";

export function isTtlockAccessPollEnabled(
  env: Record<string, string | undefined> = {},
): boolean {
  return env[ENV_TTLOCK_ACCESS_POLL_ENABLED] === "true";
}

export type PollCheckpoint = {
  lock_id: number;
  last_lock_date_ms: number;
  last_record_id: string | null;
};

export type PollCheckpointStore = {
  listCandidateApartmentLockIds(): Promise<number[]>;
  getCheckpoint(lockId: number): Promise<PollCheckpoint | null>;
  upsertCheckpoint(input: {
    lock_id: number;
    last_lock_date_ms: number;
    last_record_id?: string | null;
    last_error?: string | null;
  }): Promise<void>;
};

export type PollLockResult = {
  lock_id: number;
  fetched: number;
  newer: number;
  processed: number;
  failed: number;
  skipped: number;
  watermark_before: number;
  watermark_after: number;
  bootstrapped?: boolean;
  results: Array<{
    index: number;
    status: ProcessFirstRoomAccessResult["status"] | "error" | "skipped_old";
    ignored_reason?: string;
    error?: string;
    event_id?: string;
    lockDate?: number;
  }>;
};

async function processOnePollingRecord(args: {
  lockId: number;
  record: TtlockAccessRecordParsed;
  ports: FirstRoomAccessPorts;
  env: Record<string, string | undefined>;
  sanitizedEnvelope: ReturnType<typeof sanitizeNotifyPayload>;
}): Promise<PollLockResult["results"][number]> {
  const { lockId, record, ports, env, sanitizedEnvelope } = args;
  let ephemeral = record.keyboardPwd;
  try {
    const source_event_id = buildSourceEventId(ACCESS_EVENT_SOURCE_POLLING, lockId, record);
    const idempotency_key = await buildIdempotencyKey(
      {
        lockId,
        lockDate: record.lockDate,
        recordType: record.recordType,
        success: record.success,
        ephemeralKeyboardPwd: ephemeral,
      },
      env,
    );
    const recordSanitized = sanitizedEnvelope.records.find((r) => r.index === record.index);
    const raw_payload_sanitized = {
      lockId: sanitizedEnvelope.lockId,
      lockMac_masked: sanitizedEnvelope.lockMac_masked,
      record: recordSanitized,
      source: ACCESS_EVENT_SOURCE_POLLING,
    };
    assertSanitizedPayloadSafe(raw_payload_sanitized);

    const options = { ephemeral_keyboard_pwd: ephemeral };
    const out = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_POLLING,
        source_event_id,
        idempotency_key,
        occurred_at: new Date(record.lockDate).toISOString(),
        lock_id: lockId,
        record_type: record.recordType,
        success: record.success,
        raw_payload_sanitized,
      },
      ports,
      options,
    );
    ephemeral = undefined;
    options.ephemeral_keyboard_pwd = undefined;
    stripEphemeralPassword(record);
    return {
      index: record.index,
      status: out.status,
      ignored_reason: out.ignored_reason,
      error: out.error,
      event_id: out.event_id,
      lockDate: record.lockDate,
    };
  } catch (e) {
    ephemeral = undefined;
    stripEphemeralPassword(record);
    return {
      index: record.index,
      status: "error",
      error: e instanceof Error ? e.message : String(e),
      lockDate: record.lockDate,
    };
  }
}

/**
 * Polla um lock: busca records, processa só lockDate > watermark, avança checkpoint.
 * Sem checkpoint: bootstrap watermark = now (não processa histórico).
 */
export async function pollOneLock(args: {
  lockId: number;
  client: TtlockClient;
  ports: FirstRoomAccessPorts;
  store: PollCheckpointStore;
  env: Record<string, string | undefined>;
  nowMs?: number;
  /** Janela máxima para trás se houver checkpoint (ms). Default 2h. */
  lookbackMs?: number;
}): Promise<PollLockResult> {
  const nowMs = args.nowMs ?? Date.now();
  const lookbackMs = args.lookbackMs ?? 2 * 60 * 60 * 1000;
  const cp = await args.store.getCheckpoint(args.lockId);

  if (!cp) {
    await args.store.upsertCheckpoint({
      lock_id: args.lockId,
      last_lock_date_ms: nowMs,
      last_record_id: null,
      last_error: "bootstrap_skip_history",
    });
    return {
      lock_id: args.lockId,
      fetched: 0,
      newer: 0,
      processed: 0,
      failed: 0,
      skipped: 0,
      watermark_before: 0,
      watermark_after: nowMs,
      bootstrapped: true,
      results: [],
    };
  }

  const watermarkBefore = cp.last_lock_date_ms;
  const startDate = Math.max(0, watermarkBefore - 60_000);
  const endDate = nowMs + 60_000;
  // Não ampliar lookback além do necessário; overlap de 60s cobre clock skew.
  void lookbackMs;

  const { list } = await args.client.listLockRecords({
    lockId: args.lockId,
    startDate,
    endDate,
    pageNo: 1,
    pageSize: Math.min(100, MAX_NOTIFY_RECORDS),
    date: nowMs,
  });

  if (list.length === 0) {
    await args.store.upsertCheckpoint({
      lock_id: args.lockId,
      last_lock_date_ms: watermarkBefore,
      last_record_id: cp.last_record_id,
      last_error: null,
    });
    return {
      lock_id: args.lockId,
      fetched: 0,
      newer: 0,
      processed: 0,
      failed: 0,
      skipped: 0,
      watermark_before: watermarkBefore,
      watermark_after: watermarkBefore,
      results: [],
    };
  }

  const parseResult = parseTtlockAccessNotifyPayload({
    lockId: args.lockId,
    records: list,
  });
  if (!parseResult.ok) {
    await args.store.upsertCheckpoint({
      lock_id: args.lockId,
      last_lock_date_ms: watermarkBefore,
      last_record_id: cp.last_record_id,
      last_error: parseResult.code,
    });
    return {
      lock_id: args.lockId,
      fetched: list.length,
      newer: 0,
      processed: 0,
      failed: 0,
      skipped: list.length,
      watermark_before: watermarkBefore,
      watermark_after: watermarkBefore,
      results: [],
    };
  }

  const envelope = parseResult.parsed;
  const sanitizedEnvelope = sanitizeNotifyPayload(envelope);
  const newer = envelope.records
    .filter((r) => r.lockDate > watermarkBefore)
    .sort((a, b) => a.lockDate - b.lockDate || a.index - b.index);

  const results: PollLockResult["results"] = [];
  let processed = 0;
  let failed = 0;
  const skipped = envelope.records.length - newer.length;
  let watermarkAfter = watermarkBefore;
  let maxRecordId = cp.last_record_id;

  for (const record of newer) {
    const out = await processOnePollingRecord({
      lockId: args.lockId,
      record,
      ports: args.ports,
      env: args.env,
      sanitizedEnvelope,
    });
    results.push(out);
    if (out.status === "error") {
      failed += 1;
      // Não avança watermark além do primeiro falho (permite retry).
      break;
    }
    processed += 1;
    if (record.lockDate >= watermarkAfter) {
      watermarkAfter = record.lockDate;
      if (record.nativeRecordId) maxRecordId = record.nativeRecordId;
    }
  }

  await args.store.upsertCheckpoint({
    lock_id: args.lockId,
    last_lock_date_ms: watermarkAfter,
    last_record_id: maxRecordId,
    last_error: failed > 0 ? "partial_batch_error" : null,
  });

  return {
    lock_id: args.lockId,
    fetched: list.length,
    newer: newer.length,
    processed,
    failed,
    skipped,
    watermark_before: watermarkBefore,
    watermark_after: watermarkAfter,
    results,
  };
}

export async function runTtlockAccessPollBatch(args: {
  client: TtlockClient;
  ports: FirstRoomAccessPorts;
  store: PollCheckpointStore;
  env: Record<string, string | undefined>;
  nowMs?: number;
  limitLocks?: number;
}): Promise<{
  enabled: boolean;
  locks: number;
  results: PollLockResult[];
}> {
  if (!isTtlockAccessPollEnabled(args.env)) {
    return { enabled: false, locks: 0, results: [] };
  }
  const ids = await args.store.listCandidateApartmentLockIds();
  const limit = args.limitLocks ?? 50;
  const slice = ids.slice(0, limit);
  const results: PollLockResult[] = [];
  for (const lockId of slice) {
    try {
      results.push(
        await pollOneLock({
          lockId,
          client: args.client,
          ports: args.ports,
          store: args.store,
          env: args.env,
          nowMs: args.nowMs,
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await args.store.upsertCheckpoint({
        lock_id: lockId,
        last_lock_date_ms: (await args.store.getCheckpoint(lockId))?.last_lock_date_ms ?? 0,
        last_error: msg.slice(0, 500),
      });
      results.push({
        lock_id: lockId,
        fetched: 0,
        newer: 0,
        processed: 0,
        failed: 1,
        skipped: 0,
        watermark_before: 0,
        watermark_after: 0,
        results: [{ index: -1, status: "error", error: msg }],
      });
    }
  }
  return { enabled: true, locks: slice.length, results };
}
