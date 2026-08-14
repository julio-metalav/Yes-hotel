/**
 * Diagnóstico TTLock (lock homolog 16274746).
 * Auth: ACCESS_TOLERANCE_PROCESSOR_TOKEN ou service_role.
 * NÃO retorna secrets, PIN, lockKey, adminPwd, aesKey.
 *
 * mode:
 *   lock_record (default) — /v3/lockRecord/list
 *   lock_capacity — detail + keyboardPwdVersion + queryOpenState
 *   gateway — gateway/list + listLock + lock alvo
 *   change_add | change_run | change_delete — probe isolado (não Breno)
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import md5 from "npm:md5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-access-tolerance-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const HOMOLOG_LOCK_ID = 16274746;
const BRENO_PWD_ID = 104041356;
const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
const processorToken = (Deno.env.get("ACCESS_TOLERANCE_PROCESSOR_TOKEN") ?? "").trim();
const ttlockClientId = Deno.env.get("TTLOCK_CLIENT_ID") ?? "";
const ttlockClientSecret = Deno.env.get("TTLOCK_CLIENT_SECRET") ?? "";
const ttlockUsername = Deno.env.get("TTLOCK_USERNAME") ?? "";
const ttlockPassword = Deno.env.get("TTLOCK_PASSWORD") ?? "";
const TTLOCK_TOKEN_DEFAULT = "https://api.sciener.com/oauth2/token";
const TTLOCK_API_BASE_DEFAULT = "https://api.sciener.com";
const ttlockTokenUrl =
  (Deno.env.get("TTLOCK_TOKEN_URL") ?? "").trim() || TTLOCK_TOKEN_DEFAULT;
const ttlockApiBase = (
  (Deno.env.get("TTLOCK_API_BASE_URL") ?? "").trim() || TTLOCK_API_BASE_DEFAULT
).replace(/\/+$/, "");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function isServiceRoleBearer(token: string, expectedServiceKey: string): boolean {
  if (!token) return false;
  if (expectedServiceKey && (ctEqual(token, expectedServiceKey) || token === expectedServiceKey)) {
    return true;
  }
  const parts = token.split(".");
  if (parts.length < 2) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const payload = JSON.parse(atob(b64 + pad)) as { role?: string };
    return String(payload.role ?? "").toLowerCase() === "service_role";
  } catch {
    return false;
  }
}

function authorize(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (isServiceRoleBearer(t, serviceRoleKey)) return true;
  }
  if (processorToken) {
    const h = (req.headers.get("x-access-tolerance-token") ?? "").trim();
    if (h && ctEqual(h, processorToken)) return true;
  }
  return false;
}

function maskPwd(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  if (s.length <= 2) return "***";
  return `${s.slice(0, 1)}${"*".repeat(Math.max(1, s.length - 2))}${s.slice(-1)}`;
}

function describeMs(ms: number) {
  const d = new Date(ms);
  const campo = d.toLocaleString("sv-SE", { timeZone: "America/Campo_Grande" });
  const minute = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Campo_Grande",
      minute: "2-digit",
    }).format(d),
  );
  const second = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Campo_Grande",
      second: "2-digit",
    }).format(d),
  );
  return {
    ms,
    utc_iso: d.toISOString(),
    campo_grande: campo,
    minute,
    second,
    millisecond: d.getUTCMilliseconds(),
    hour_aligned: minute === 0 && second === 0 && d.getUTCMilliseconds() === 0,
  };
}

async function getToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: ttlockClientId,
    client_secret: ttlockClientSecret,
    username: ttlockUsername,
    password: md5(ttlockPassword),
    grant_type: "password",
  });
  const res = await fetch(ttlockTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || (data.errcode && data.errcode !== 0) || !data.access_token) {
    throw new Error(`token_failed:${data.errcode ?? res.status}:${data.errmsg ?? "no_token"}`);
  }
  return String(data.access_token);
}

function authForm(token: string): URLSearchParams {
  const form = new URLSearchParams();
  form.set("clientId", ttlockClientId);
  form.set("accessToken", token);
  form.set("date", String(Date.now()));
  return form;
}

type TtlockCallResult = {
  http_status: number;
  content_type: string | null;
  body_kind: "json" | "text" | "empty";
  errcode: number | null;
  errmsg: string | null;
  description: string | null;
  body_preview: string;
  data: Record<string, unknown> | null;
};

const SECRET_KEY_RE =
  /accessToken|clientSecret|client_secret|password|passwd|keyboardPwd|newKeyboardPwd|lockKey|adminPwd|noKeyPwd|deletePwd|aesKey/i;

function publicPreview(raw: string): string {
  const cut = raw.replace(/\s+/g, " ").trim().slice(0, 240);
  if (SECRET_KEY_RE.test(cut)) return "[redacted_sensitive_keys]";
  return cut;
}

async function ttlockCall(
  path: string,
  token: string,
  extra: Record<string, string>,
  contentType: "form" | "json",
): Promise<TtlockCallResult> {
  const url = `${ttlockApiBase}${path}`;
  let body: string;
  const headers: Record<string, string> = {};
  if (contentType === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      clientId: ttlockClientId,
      accessToken: token,
      date: Date.now(),
      ...extra,
    });
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const form = authForm(token);
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    body = form.toString();
  }
  const res = await fetch(url, { method: "POST", headers, body });
  const text = await res.text();
  const content_type = res.headers.get("content-type");
  if (!text) {
    return {
      http_status: res.status,
      content_type,
      body_kind: "empty",
      errcode: null,
      errmsg: null,
      description: null,
      body_preview: "",
      data: null,
    };
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      http_status: res.status,
      content_type,
      body_kind: "json",
      errcode: typeof parsed.errcode === "number" ? parsed.errcode : null,
      errmsg: parsed.errmsg == null ? null : String(parsed.errmsg).slice(0, 200),
      description: parsed.description == null ? null : String(parsed.description).slice(0, 200),
      body_preview: publicPreview(
        JSON.stringify({
          errcode: parsed.errcode ?? null,
          errmsg: parsed.errmsg ?? null,
          description: parsed.description ?? null,
        }),
      ),
      data: parsed,
    };
  } catch {
    return {
      http_status: res.status,
      content_type,
      body_kind: "text",
      errcode: null,
      errmsg: null,
      description: null,
      body_preview: publicPreview(text),
      data: null,
    };
  }
}

function pickLockPublic(raw: Record<string, unknown> | null) {
  if (!raw) return null;
  return {
    lockId: raw.lockId ?? null,
    lockName: raw.lockName ?? null,
    lockAlias: raw.lockAlias ?? null,
    keyboardPwdVersion: raw.keyboardPwdVersion ?? null,
    hasGateway: raw.hasGateway ?? null,
    specialValue: raw.specialValue ?? null,
    electricQuantity: raw.electricQuantity ?? null,
    timezoneRawOffset: raw.timezoneRawOffset ?? null,
    modelNum: raw.modelNum ?? null,
    hardwareRevision: raw.hardwareRevision ?? null,
    firmwareRevision: raw.firmwareRevision ?? null,
    date: raw.date ?? null,
    errcode: raw.errcode ?? null,
    errmsg: raw.errmsg ?? null,
  };
}

function assertHomologLock(lockId: number) {
  if (lockId !== HOMOLOG_LOCK_ID) {
    throw new Error(`lock_id_not_homolog:${lockId}`);
  }
}

function randomPin(): string {
  const n = (crypto.getRandomValues(new Uint32Array(1))[0] % 900000) + 100000;
  return String(n);
}

async function modeLockRecord(token: string, body: Record<string, unknown>) {
  const lockId = Number(body.lockId ?? HOMOLOG_LOCK_ID);
  assertHomologLock(lockId);
  const startDate = Number(body.startDate ?? Date.parse("2026-08-11T22:35:00.000Z"));
  const endDate = Number(body.endDate ?? Date.parse("2026-08-11T22:43:00.000Z"));
  const call = await ttlockCall(
    "/v3/lockRecord/list",
    token,
    {
      lockId: String(lockId),
      startDate: String(startDate),
      endDate: String(endDate),
      pageNo: "1",
      pageSize: "100",
    },
    "form",
  );
  const list = Array.isArray(call.data?.list) ? call.data!.list as Record<string, unknown>[] : [];
  const targetMs = Date.parse("2026-08-11T22:39:51.000Z");
  const records = list.map((r) => ({
    lockId: r.lockId ?? lockId,
    recordType: r.recordType,
    success: r.success,
    lockDate: r.lockDate,
    serverDate: r.serverDate,
    keyboardPwd_present: r.keyboardPwd != null && String(r.keyboardPwd).length > 0,
    keyboardPwd_masked: maskPwd(r.keyboardPwd),
    recordId: r.recordId ?? r.id ?? null,
  }));
  const match =
    records.find((r) => {
      const d = Number(r.lockDate);
      return Number.isFinite(d) && Math.abs(d - targetMs) <= 5000;
    }) ?? null;
  return {
    ok: !call.errcode,
    apiBase: ttlockApiBase,
    clientId_prefix: ttlockClientId.slice(0, 4) + "…",
    lockId,
    startDate,
    endDate,
    http: call,
    records_count: records.length,
    found_target_183951: Boolean(match),
    match,
    records,
  };
}

async function modeLockCapacity(token: string, lockId: number) {
  assertHomologLock(lockId);
  const detail = await ttlockCall("/v3/lock/detail", token, { lockId: String(lockId) }, "form");
  const version = await ttlockCall(
    "/v3/lock/getKeyboardPwdVersion",
    token,
    { lockId: String(lockId) },
    "form",
  );
  const openState = await ttlockCall(
    "/v3/lock/queryOpenState",
    token,
    { lockId: String(lockId) },
    "form",
  );
  const list = await ttlockCall(
    "/v3/lock/list",
    token,
    { pageNo: "1", pageSize: "100" },
    "form",
  );
  const locks = Array.isArray(list.data?.list) ? list.data!.list as Record<string, unknown>[] : [];
  const listed = locks.find((l) => Number(l.lockId) === lockId) ?? null;
  return {
    ok: true,
    lockId,
    apiBase: ttlockApiBase,
    detail: {
      http_status: detail.http_status,
      errcode: detail.errcode,
      errmsg: detail.errmsg,
      lock: pickLockPublic(detail.data),
    },
    keyboardPwdVersion_endpoint: {
      http_status: version.http_status,
      errcode: version.errcode,
      errmsg: version.errmsg,
      keyboardPwdVersion: version.data?.keyboardPwdVersion ?? null,
    },
    queryOpenState: {
      http_status: openState.http_status,
      errcode: openState.errcode,
      errmsg: openState.errmsg,
      description: openState.description,
      body_kind: openState.body_kind,
      body_preview: openState.body_preview,
      state: openState.data?.state ?? null,
    },
    lock_list_match: listed
      ? {
          lockId: listed.lockId ?? null,
          lockAlias: listed.lockAlias ?? listed.lockName ?? null,
          keyboardPwdVersion: listed.keyboardPwdVersion ?? null,
          hasGateway: listed.hasGateway ?? null,
          specialValue: listed.specialValue ?? null,
        }
      : null,
  };
}

async function modeGateway(token: string, lockId: number) {
  assertHomologLock(lockId);
  const gateways = await ttlockCall(
    "/v3/gateway/list",
    token,
    { pageNo: "1", pageSize: "100" },
    "form",
  );
  const list = Array.isArray(gateways.data?.list)
    ? (gateways.data!.list as Record<string, unknown>[])
    : [];
  const details = [];
  for (const g of list) {
    const gatewayId = Number(g.gatewayId);
    if (!Number.isFinite(gatewayId)) continue;
    const locks = await ttlockCall(
      "/v3/gateway/listLock",
      token,
      { gatewayId: String(gatewayId) },
      "form",
    );
    const lockList = Array.isArray(locks.data?.list)
      ? (locks.data!.list as Record<string, unknown>[])
      : [];
    const hit = lockList.find((l) => Number(l.lockId) === lockId) ?? null;
    details.push({
      gatewayId,
      gatewayMac: g.gatewayMac ?? null,
      gatewayVersion: g.gatewayVersion ?? null,
      networkName: g.networkName ?? null,
      lockNum: g.lockNum ?? null,
      isOnline: g.isOnline ?? null,
      listLock_http: locks.http_status,
      listLock_errcode: locks.errcode,
      target_lock: hit
        ? {
            lockId: hit.lockId ?? null,
            lockName: hit.lockName ?? null,
            lockAlias: hit.lockAlias ?? null,
            rssi: hit.rssi ?? null,
            updateDate: hit.updateDate ?? null,
            updateDate_utc: hit.updateDate != null
              ? new Date(Number(hit.updateDate)).toISOString()
              : null,
            updateDate_campo_grande: hit.updateDate != null
              ? new Date(Number(hit.updateDate)).toLocaleString("sv-SE", {
                timeZone: "America/Campo_Grande",
              })
              : null,
          }
        : null,
    });
  }
  return {
    ok: true,
    lockId,
    gateway_list_http: gateways.http_status,
    gateway_list_errcode: gateways.errcode,
    gateway_count: list.length,
    gateways: details,
    serving: details.filter((d) => d.target_lock != null),
  };
}

async function modeChangeAdd(token: string, lockId: number) {
  assertHomologLock(lockId);
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const startDate = Math.floor(now / hourMs) * hourMs;
  const endDate = startDate + 48 * hourMs;
  const pin = randomPin();
  const call = await ttlockCall(
    "/v3/keyboardPwd/add",
    token,
    {
      lockId: String(lockId),
      keyboardPwd: pin,
      keyboardPwdName: "YH-DIAG-CHG400",
      startDate: String(startDate),
      endDate: String(endDate),
      addType: "2",
    },
    "form",
  );
  const keyboardPwdId = Number(call.data?.keyboardPwdId);
  return {
    ok: call.errcode == null || call.errcode === 0,
    lockId,
    keyboardPwdId: Number.isFinite(keyboardPwdId) ? keyboardPwdId : null,
    breno_pwd_reused: keyboardPwdId === BRENO_PWD_ID,
    add_http_status: call.http_status,
    add_errcode: call.errcode,
    add_errmsg: call.errmsg,
    add_body_kind: call.body_kind,
    add_body_preview: call.body_preview,
    startDate: describeMs(startDate),
    endDate: describeMs(endDate),
    pin_returned: false,
  };
}

async function modeChangeRun(
  token: string,
  lockId: number,
  keyboardPwdId: number,
  startDateMs: number,
  endDateMs: number,
  alsoHourAligned: boolean,
) {
  assertHomologLock(lockId);
  if (keyboardPwdId === BRENO_PWD_ID) throw new Error("refuse_breno_pwd");
  const extra = {
    lockId: String(lockId),
    keyboardPwdId: String(keyboardPwdId),
    startDate: String(startDateMs),
    endDate: String(endDateMs),
    changeType: "2",
  };
  const jsonCall = await ttlockCall("/v3/keyboardPwd/change", token, extra, "json");
  const formCall = await ttlockCall("/v3/keyboardPwd/change", token, extra, "form");
  let hourCall: TtlockCallResult | null = null;
  let hourEnd: ReturnType<typeof describeMs> | null = null;
  if (alsoHourAligned) {
    const hourMs = 60 * 60 * 1000;
    const hourEndMs = Math.floor(endDateMs / hourMs) * hourMs;
    hourEnd = describeMs(hourEndMs);
    hourCall = await ttlockCall(
      "/v3/keyboardPwd/change",
      token,
      { ...extra, endDate: String(hourEndMs) },
      "form",
    );
  }
  const jsonOk = jsonCall.http_status < 400 && (jsonCall.errcode == null || jsonCall.errcode === 0);
  const formOk = formCall.http_status < 400 && (formCall.errcode == null || formCall.errcode === 0);
  const hourOk = hourCall
    ? hourCall.http_status < 400 && (hourCall.errcode == null || hourCall.errcode === 0)
    : null;
  return {
    ok: true,
    lockId,
    keyboardPwdId,
    changeType_sent: 2,
    dates: {
      startDate: describeMs(startDateMs),
      endDate: describeMs(endDateMs),
      hour_aligned_end: hourEnd,
    },
    probe_json_like_processor: {
      content_type: "application/json",
      http_status: jsonCall.http_status,
      body_kind: jsonCall.body_kind,
      errcode: jsonCall.errcode,
      errmsg: jsonCall.errmsg,
      description: jsonCall.description,
      body_preview: jsonCall.body_preview,
      ok: jsonOk,
    },
    probe_form_contract: {
      content_type: "application/x-www-form-urlencoded",
      http_status: formCall.http_status,
      body_kind: formCall.body_kind,
      errcode: formCall.errcode,
      errmsg: formCall.errmsg,
      description: formCall.description,
      body_preview: formCall.body_preview,
      ok: formOk,
    },
    probe_form_hour_aligned: hourCall
      ? {
          content_type: "application/x-www-form-urlencoded",
          http_status: hourCall.http_status,
          body_kind: hourCall.body_kind,
          errcode: hourCall.errcode,
          errmsg: hourCall.errmsg,
          description: hourCall.description,
          body_preview: hourCall.body_preview,
          ok: hourOk,
        }
      : null,
    verdict: {
      json_ok: jsonOk,
      form_ok: formOk,
      hour_ok: hourOk,
      content_type_is_cause: !jsonOk && formOk,
      hour_granularity_is_cause: !formOk && hourOk === true,
    },
  };
}

async function modeChangeDelete(token: string, lockId: number, keyboardPwdId: number) {
  assertHomologLock(lockId);
  if (keyboardPwdId === BRENO_PWD_ID) throw new Error("refuse_breno_pwd");
  const call = await ttlockCall(
    "/v3/keyboardPwd/delete",
    token,
    {
      lockId: String(lockId),
      keyboardPwdId: String(keyboardPwdId),
      deleteType: "2",
    },
    "form",
  );
  return {
    ok: call.errcode == null || call.errcode === 0,
    lockId,
    keyboardPwdId,
    delete_http_status: call.http_status,
    delete_errcode: call.errcode,
    delete_errmsg: call.errmsg,
    delete_body_kind: call.body_kind,
    delete_body_preview: call.body_preview,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, 401);

  if (!ttlockClientId || !ttlockClientSecret || !ttlockUsername || !ttlockPassword) {
    return json({ ok: false, error: "ttlock_credentials_missing" }, 500);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const mode = String(body.mode ?? "lock_record");
  const lockId = Number(body.lockId ?? HOMOLOG_LOCK_ID);

  try {
    const token = await getToken();
    void createClient;

    if (mode === "lock_capacity") {
      return json(await modeLockCapacity(token, lockId));
    }
    if (mode === "gateway") {
      return json(await modeGateway(token, lockId));
    }
    if (mode === "change_add") {
      return json(await modeChangeAdd(token, lockId));
    }
    if (mode === "change_run") {
      const keyboardPwdId = Number(body.keyboardPwdId);
      if (!Number.isFinite(keyboardPwdId)) {
        return json({ ok: false, error: "keyboardPwdId_required" }, 400);
      }
      const startDateMs = Number(body.startDateMs);
      const endDateMs = Number(body.endDateMs);
      if (!Number.isFinite(startDateMs) || !Number.isFinite(endDateMs)) {
        return json({ ok: false, error: "dates_required" }, 400);
      }
      return json(
        await modeChangeRun(
          token,
          lockId,
          keyboardPwdId,
          startDateMs,
          endDateMs,
          body.alsoHourAligned === true,
        ),
      );
    }
    if (mode === "change_delete") {
      const keyboardPwdId = Number(body.keyboardPwdId);
      if (!Number.isFinite(keyboardPwdId)) {
        return json({ ok: false, error: "keyboardPwdId_required" }, 400);
      }
      return json(await modeChangeDelete(token, lockId, keyboardPwdId));
    }
    return json(await modeLockRecord(token, body));
  } catch (e) {
    return json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      apiBase: ttlockApiBase,
    }, 500);
  }
});
