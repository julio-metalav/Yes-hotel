/** Feature flag de ingestão TTLock (ausente ou ≠ "true" = desativado). */
export const ENV_TTLOCK_ACCESS_INGEST_ENABLED = "YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED";

/** Segredo de autenticação do callback (header/query). Nunca usar TTLOCK_CLIENT_SECRET. */
export const ENV_TTLOCK_ACCESS_WEBHOOK_SECRET = "TTLOCK_ACCESS_WEBHOOK_SECRET";

/** Segredo HMAC de idempotência (dedicado). */
export const ENV_TTLOCK_ACCESS_IDEMPOTENCY_SECRET = "TTLOCK_ACCESS_IDEMPOTENCY_SECRET";

/** Allowlist de IP complementar (CSV). Nunca única defesa. */
export const ENV_TTLOCK_ACCESS_WEBHOOK_IP_ALLOWLIST = "TTLOCK_ACCESS_WEBHOOK_IP_ALLOWLIST";

export const TTLOCK_ACCESS_WEBHOOK_SECRET_HEADER = "x-yes-hotel-ttlock-webhook-secret";
export const TTLOCK_ACCESS_WEBHOOK_SECRET_QUERY = "secret";

/** Fonte Notify (callback). */
export const ACCESS_EVENT_SOURCE_NOTIFY = "ttlock_notify";

/** Fonte futura de polling (mesma idempotency_key, source_event_id distinto). */
export const ACCESS_EVENT_SOURCE_POLLING = "ttlock_polling";

export const MAX_NOTIFY_PAYLOAD_BYTES = 64_000;
export const MAX_NOTIFY_RECORDS = 50;

/** Resposta exigida pela TTLock Lock Records Notify. */
export const TTLOCK_NOTIFY_SUCCESS_BODY = "success";
