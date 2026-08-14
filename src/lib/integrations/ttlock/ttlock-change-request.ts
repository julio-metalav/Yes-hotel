/**
 * Contrato do POST /v3/keyboardPwd/change.
 * docs/YES_HOTEL_TTLOCK_CONTRATO_API.md: form-urlencoded + changeType=2 (gateway).
 * O client legado ainda serializa JSON — o processador herda isso.
 */
export const TTLOCK_CHANGE_TYPE_GATEWAY = 2 as const;
export const TTLOCK_PASSCODE_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
export const TTLOCK_PASSCODE_JSON_CONTENT_TYPE = "application/json";

export type TtlockChangeValidityFields = {
  lockId: number;
  keyboardPwdId: number;
  startDate: number;
  endDate: number;
  changeType: typeof TTLOCK_CHANGE_TYPE_GATEWAY;
  date: number;
  keyboardPwdName?: string;
};

export function buildTtlockChangeValidityFields(input: {
  lockId: number | string;
  keyboardPwdId: number;
  startDateMs: number;
  endDateMs: number;
  dateMs?: number;
  keyboardPwdName?: string;
}): TtlockChangeValidityFields {
  const lockId = typeof input.lockId === "string" ? parseInt(input.lockId, 10) : input.lockId;
  const fields: TtlockChangeValidityFields = {
    lockId,
    keyboardPwdId: input.keyboardPwdId,
    startDate: input.startDateMs,
    endDate: input.endDateMs,
    changeType: TTLOCK_CHANGE_TYPE_GATEWAY,
    date: input.dateMs ?? Date.now(),
  };
  if (input.keyboardPwdName != null) fields.keyboardPwdName = input.keyboardPwdName;
  return fields;
}

/** Serialização oficial do contrato (Edge lifecycle). */
export function encodeTtlockChangeValidityForm(
  fields: TtlockChangeValidityFields,
  auth: { clientId: string; accessToken: string },
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("clientId", auth.clientId);
  params.set("accessToken", auth.accessToken);
  params.set("lockId", String(fields.lockId));
  params.set("keyboardPwdId", String(fields.keyboardPwdId));
  params.set("startDate", String(fields.startDate));
  params.set("endDate", String(fields.endDate));
  params.set("changeType", String(fields.changeType));
  params.set("date", String(fields.date));
  if (fields.keyboardPwdName != null) params.set("keyboardPwdName", fields.keyboardPwdName);
  return params;
}

export type TtlockValidityInstantView = {
  ms: number;
  utc_iso: string;
  campo_grande: string;
  minute: number;
  second: number;
  millisecond: number;
  hour_aligned: boolean;
};

function tzPart(d: Date, timeZone: string, type: Intl.DateTimeFormatPartTypes): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === type)?.value ?? NaN);
}

export function describeTtlockValidityMs(
  ms: number,
  timeZone = "America/Campo_Grande",
): TtlockValidityInstantView {
  const d = new Date(ms);
  const utc_iso = d.toISOString();
  const campo_grande = d.toLocaleString("sv-SE", { timeZone });
  const minute = tzPart(d, timeZone, "minute");
  const second = tzPart(d, timeZone, "second");
  const millisecond = d.getUTCMilliseconds();
  return {
    ms,
    utc_iso,
    campo_grande,
    minute,
    second,
    millisecond,
    hour_aligned: minute === 0 && second === 0 && millisecond === 0,
  };
}
