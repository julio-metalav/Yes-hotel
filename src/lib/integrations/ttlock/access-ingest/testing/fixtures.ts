/**
 * Fixtures TTLock access ingest (PR3) — sem I/O real.
 */

export const FIX_LOCK_APT = 15615492;
export const FIX_LOCK_GATE = 25709122;
export const FIX_PWD = "482910";
export const FIX_PWD_OTHER = "111111";
export const FIX_OCCURRED_MS = Date.parse("2026-08-08T18:00:00.000Z");

export const FIX_RES_ID = "5321a46f-5000-43e1-8830-df57f3bc0439";
export const FIX_CRED_ID = "64705bcb-6736-4329-96ae-f9413f3bb5d8";
export const FIX_ITEM_APT = "a1111111-1111-4111-8111-111111111111";

export function notifyPayload(overrides: Record<string, unknown> = {}) {
  return {
    lockId: FIX_LOCK_APT,
    lockMac: "AA:BB:CC:DD:EE:FF",
    records: [
      {
        recordType: 4,
        success: 1,
        username: "guest",
        keyboardPwd: FIX_PWD,
        lockDate: FIX_OCCURRED_MS,
        serverDate: FIX_OCCURRED_MS + 1000,
        electricQuantity: 88,
      },
    ],
    ...overrides,
  };
}

export function record(
  partial: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    recordType: 4,
    success: 1,
    keyboardPwd: FIX_PWD,
    lockDate: FIX_OCCURRED_MS,
    ...partial,
  };
}

export const TEST_ENV = {
  YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED: "true",
  TTLOCK_ACCESS_WEBHOOK_SECRET: "test-webhook-secret-pr3-not-real",
  TTLOCK_ACCESS_IDEMPOTENCY_SECRET: "test-idempotency-secret-pr3-not-real",
};

export const TEST_ENV_FLAG_OFF = {
  ...TEST_ENV,
  YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED: "false",
};
