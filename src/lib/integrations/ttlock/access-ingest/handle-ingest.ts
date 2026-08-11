/**
 * Handler agnóstico de runtime para ingestão TTLock Access Notify.
 * Usado pela Edge e pelos testes locais (sem Deno).
 */

import { processFirstRoomAccessEvent } from "../../../application/yes-hotel/first-room-access-orchestrator.ts";
import type { FirstRoomAccessPorts } from "../../../application/yes-hotel/first-room-access-ports.ts";
import type { ProcessFirstRoomAccessResult } from "../../../application/yes-hotel/first-room-access-types.ts";
import {
  ACCESS_EVENT_SOURCE_NOTIFY,
  TTLOCK_NOTIFY_SUCCESS_BODY,
} from "./constants.ts";
import {
  extractWebhookSecretFromUrl,
  extractWebhookSecretsFromHeaders,
  validateTtlockAccessWebhookAuth,
} from "./auth.ts";
import { isTtlockAccessIngestEnabled } from "./feature-flag.ts";
import { buildIdempotencyKey, buildSourceEventId } from "./idempotency.ts";
import { parseTtlockAccessNotifyPayload } from "./parse-notify.ts";
import {
  assertSanitizedPayloadSafe,
  sanitizeNotifyPayload,
  stripEphemeralPassword,
} from "./sanitize.ts";
import type { TtlockAccessRecordParsed } from "./types.ts";

export type IngestRequest = {
  method: string;
  url: string;
  headers: Headers | Record<string, string | undefined>;
  /** Corpo já parseado ou string bruta. */
  body: unknown;
  rawByteLength?: number;
  clientIp?: string | null;
  env?: Record<string, string | undefined>;
};

export type IngestResponse = {
  status: number;
  /** Corpo texto (TTLock exige "success"). */
  bodyText: string;
  contentType: string;
  /** Metadados só para testes — sem senhas. */
  meta: {
    ingest_enabled: boolean;
    auth_ok: boolean;
    processed: number;
    failed: number;
    skipped: number;
    results: Array<{
      index: number;
      status: ProcessFirstRoomAccessResult["status"] | "skipped_parse" | "error";
      ignored_reason?: string;
      error?: string;
      event_id?: string;
    }>;
    log_safe: Record<string, unknown>;
  };
};

function envMap(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  return env ?? (typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {});
}

function successResponse(
  meta: IngestResponse["meta"],
  status = 200,
): IngestResponse {
  return {
    status,
    bodyText: TTLOCK_NOTIFY_SUCCESS_BODY,
    contentType: "text/plain; charset=utf-8",
    meta,
  };
}

function unauthorizedResponse(meta: IngestResponse["meta"]): IngestResponse {
  return {
    status: 401,
    bodyText: TTLOCK_NOTIFY_SUCCESS_BODY,
    contentType: "text/plain; charset=utf-8",
    meta,
  };
}

/**
 * Processa um Notify.
 *
 * Flag desligada: responde sempre `success` (compatível TTLock), sem persistir/
 * processar, e sem revelar se o segredo está correto ou incorreto (mesmo status/
 * corpo; logs internos não distinguem auth no caminho desabilitado).
 *
 * Flag ligada: exige TTLOCK_ACCESS_WEBHOOK_SECRET (header preferencial ou query).
 */
export async function handleTtlockAccessIngest(
  req: IngestRequest,
  ports: FirstRoomAccessPorts | null,
): Promise<IngestResponse> {
  const env = envMap(req.env);
  const baseMeta: IngestResponse["meta"] = {
    ingest_enabled: false,
    auth_ok: false,
    processed: 0,
    failed: 0,
    skipped: 0,
    results: [],
    log_safe: {},
  };

  if (req.method.toUpperCase() === "OPTIONS") {
    return { status: 204, bodyText: "", contentType: "text/plain", meta: baseMeta };
  }

  if (req.method.toUpperCase() !== "POST") {
    return {
      status: 405,
      bodyText: "method_not_allowed",
      contentType: "text/plain; charset=utf-8",
      meta: { ...baseMeta, log_safe: { event: "method_not_allowed" } },
    };
  }

  const enabled = isTtlockAccessIngestEnabled(env);
  baseMeta.ingest_enabled = enabled;

  if (!enabled) {
    // Não validar/revelar resultado de auth com flag off (anti-oráculo de segredo).
    baseMeta.log_safe = {
      event: "ingest_disabled",
      message: "YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED != true; ack sem persistir.",
    };
    return successResponse(baseMeta);
  }

  const headerSecret = extractWebhookSecretsFromHeaders(req.headers);
  const querySecret = extractWebhookSecretFromUrl(req.url);
  const auth = validateTtlockAccessWebhookAuth({
    headerSecret,
    querySecret,
    clientIp: req.clientIp,
    env,
  });

  if (!auth.ok) {
    // Log sem ecoar o segredo nem query/header brutos.
    baseMeta.log_safe = { event: "auth_failed", code: auth.code };
    return unauthorizedResponse(baseMeta);
  }
  baseMeta.auth_ok = true;

  if (!ports) {
    baseMeta.log_safe = { event: "ports_missing" };
    baseMeta.failed = 1;
    return successResponse(baseMeta);
  }

  let bodyObj: unknown = req.body;
  if (typeof req.body === "string") {
    try {
      bodyObj = JSON.parse(req.body);
    } catch {
      baseMeta.log_safe = { event: "malformed_json" };
      return successResponse(baseMeta);
    }
  }

  const parsed = parseTtlockAccessNotifyPayload(bodyObj, {
    rawByteLength: req.rawByteLength,
  });

  if (!parsed.ok) {
    baseMeta.log_safe = { event: "payload_rejected", code: parsed.code };
    return successResponse(baseMeta);
  }

  const sanitizedEnvelope = sanitizeNotifyPayload(parsed.parsed);
  assertSanitizedPayloadSafe(sanitizedEnvelope);
  baseMeta.log_safe = {
    event: "ingest_batch",
    lockId: sanitizedEnvelope.lockId,
    record_count: sanitizedEnvelope.records.length,
  };

  for (const record of parsed.parsed.records) {
    const result = await processOneRecord({
      lockId: parsed.parsed.lockId,
      lockMac: parsed.parsed.lockMac,
      record,
      ports,
      env,
      sanitizedEnvelope,
    });
    baseMeta.results.push(result);
    if (result.status === "error" || result.status === "failed") baseMeta.failed += 1;
    else if (result.status === "skipped_parse") baseMeta.skipped += 1;
    else baseMeta.processed += 1;

    stripEphemeralPassword(record);
  }

  return successResponse(baseMeta);
}

async function processOneRecord(args: {
  lockId: number;
  lockMac?: string;
  record: TtlockAccessRecordParsed;
  ports: FirstRoomAccessPorts;
  env: Record<string, string | undefined>;
  sanitizedEnvelope: ReturnType<typeof sanitizeNotifyPayload>;
}): Promise<IngestResponse["meta"]["results"][number]> {
  const { lockId, record, ports, env, sanitizedEnvelope } = args;
  let ephemeral = record.keyboardPwd;
  try {
    const source_event_id = buildSourceEventId(ACCESS_EVENT_SOURCE_NOTIFY, lockId, record);
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
    };
    assertSanitizedPayloadSafe(raw_payload_sanitized);

    const occurred_at = new Date(record.lockDate).toISOString();

    const options = { ephemeral_keyboard_pwd: ephemeral };
    const out = await processFirstRoomAccessEvent(
      {
        source: ACCESS_EVENT_SOURCE_NOTIFY,
        source_event_id,
        idempotency_key,
        occurred_at,
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
    };
  } catch (e) {
    ephemeral = undefined;
    stripEphemeralPassword(record);
    const msg = e instanceof Error ? e.message : String(e);
    return { index: record.index, status: "error", error: msg };
  }
}

/**
 * Log sanitizado — nunca inclui secrets, query secret, headers de auth ou senhas.
 * Com flag desligada, não expõe auth_ok (evita oráculo externo via logs agregados).
 */
export function buildSafeIngestLog(meta: IngestResponse["meta"]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...meta.log_safe,
    ingest_enabled: meta.ingest_enabled,
    processed: meta.processed,
    failed: meta.failed,
    skipped: meta.skipped,
    results: meta.results.map((r) => ({
      index: r.index,
      status: r.status,
      ignored_reason: r.ignored_reason,
      error: r.error,
      event_id: r.event_id,
    })),
  };
  if (meta.ingest_enabled) {
    out.auth_ok = meta.auth_ok;
  }
  return out;
}
