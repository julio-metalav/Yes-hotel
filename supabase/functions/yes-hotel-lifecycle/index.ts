/**
 * Yes Hotel — Lifecycle TTLock (Fase 3.2).
 * Ações: lifecycle_provision, lifecycle_gerar_nova_senha, lifecycle_update_validity,
 * cancelamento, checkout, sync_summary, retry_sync.
 * Autenticação: usuário interno (admin ou recepção) via Supabase Auth.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import md5 from "npm:md5";
import {
  allocateNewTtlockPasscode,
  formatTtlockKeyboardPwdName,
  generateRandomTtlockPasscode,
  TTLOCK_PASSCODE_COLLISION_RETRY_MAX,
} from "../_shared/ttlock-credential-format.ts";
import {
  resolveDefaultCredentialValidityIso,
  validityIsoToTtlockMs,
} from "../_shared/hotel-timezone.ts";
import { executeLifecycleUpdateValidity } from "../_shared/lifecycle-update-validity.ts";
import { resolveProvisionCredentialStatus } from "../../../src/lib/domain/yes-hotel/ttlock-guest-access-gate.ts";
import {
  canRetryWithNewPasscode,
  collectOccupiedPasscodesFromRows,
  shouldRollbackPartialPasscodeAttempt,
} from "../../../src/lib/domain/yes-hotel/ttlock-passcode-uniqueness.ts";
import {
  attemptProvisionLockWithSamePinRetry,
  encodeTransientRetryState,
  formatProvisionItemTransientError,
  parseTransientRetryState,
  TTLOCK_PROVISION_PHASE2_MAX,
  TTLOCK_PROVISION_SHORT_BUDGET_MS,
  TTLOCK_PROVISION_SHORT_DELAY_MS,
  TTLOCK_PROVISION_SHORT_RETRY_MAX,
  type ShortRetryBudget,
} from "../../../src/lib/domain/yes-hotel/ttlock-provision-retry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ttlockClientId = Deno.env.get("TTLOCK_CLIENT_ID") ?? "";
const ttlockClientSecret = Deno.env.get("TTLOCK_CLIENT_SECRET") ?? "";
const ttlockUsername = Deno.env.get("TTLOCK_USERNAME") ?? "";
const ttlockPassword = Deno.env.get("TTLOCK_PASSWORD") ?? "";
const TTLOCK_TOKEN_DEFAULT = "https://api.sciener.com/oauth2/token";
const TTLOCK_API_BASE_DEFAULT = "https://api.sciener.com";
const _rawTokenUrl = (Deno.env.get("TTLOCK_TOKEN_URL") ?? "").trim() || TTLOCK_TOKEN_DEFAULT;
const ttlockTokenUrl = _rawTokenUrl.includes("euopen.") ? _rawTokenUrl.replace(/euopen\.ttlock\.com/g, "api.sciener.com") : _rawTokenUrl;
const _rawApiBase = (Deno.env.get("TTLOCK_API_BASE_URL") ?? "").trim() || TTLOCK_API_BASE_DEFAULT;
const ttlockApiBase = _rawApiBase.replace(/\/+$/, "").replace(/euopen\.ttlock\.com/g, "api.sciener.com");

/** Contrato TTLock (form-urlencoded, retry delete): ver docs/YES_HOTEL_TTLOCK_CONTRATO_API.md */

/** Log estruturado lifecycle TTLock (hardening). Não expõe secrets. */
function logTtlockLifecycle(entry: Record<string, unknown>): void {
  if (typeof console === "undefined") return;
  try {
    console.log("[TTLOCK_LIFECYCLE]", JSON.stringify({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() }));
  } catch {
    console.log("[TTLOCK_LIFECYCLE]", String(entry));
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ensureText(value: unknown, label: string): string {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${label} obrigatório.`);
  return s;
}

/** Campos de reserva/credencial às vezes vêm na raiz do JSON (ex.: mesmo padrão de outras functions) em vez de só em `payload`. */
const PAYLOAD_MERGE_KEYS = [
  "reservaId",
  "reserva_id",
  "reservationId",
  "id",
  "credencialId",
  "credencial_id",
  "valido_de",
  "valido_ate",
] as const;

function resolvePayloadRecord(body: Record<string, unknown>): Record<string, unknown> {
  const raw = body["payload"];
  const base = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : {};
  for (const key of PAYLOAD_MERGE_KEYS) {
    const inBase = base[key];
    const baseEmpty = inBase == null || String(inBase).trim() === "";
    const fromBody = body[key];
    if (baseEmpty && fromBody != null && String(fromBody).trim() !== "") {
      base[key] = fromBody;
    }
  }
  return base;
}

/**
 * Contrato de reserva: camelCase (painel) ou snake_case (APIs / fetch direto).
 * O fallback `payload.id` é ambíguo (alguns clientes enviam credencial_id em `id`);
 * o lifecycle resolve isso com getCredencialPrincipalPorId após falhar por reserva_id.
 */
function pickReservaId(payload: Record<string, unknown>): string {
  for (const k of ["reservaId", "reserva_id", "reservationId"] as const) {
    const s = String(payload[k] ?? "").trim();
    if (s) return s;
  }
  const id = String(payload.id ?? "").trim();
  if (id) return id;
  return "";
}

function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s ?? "").trim());
}

function requireReservaId(payload: Record<string, unknown>): string {
  const id = pickReservaId(payload);
  if (!id) {
    throw new HttpError(
      "Identificador da reserva obrigatório: informe em payload reservaId, reserva_id, reservationId ou id.",
      400,
    );
  }
  return id;
}

const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Erro com status HTTP explícito (autorização / validação). */
class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

function createRequestClientWithAuth(request: Request) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: {
        Authorization: request.headers.get("Authorization") ?? "",
      },
    },
  });
}

/** Timeline operacional: não propaga falha para não quebrar lifecycle TTLock. */
async function insertReservaEvento(
  reservaId: string,
  tipo: string,
  titulo: string,
  detalhe: Record<string, unknown>,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify({ ...detalhe, timestamp });
  try {
    const { error } = await adminClient.from("operacional_reserva_eventos").insert({
      reserva_id: reservaId,
      tipo,
      titulo,
      detalhe: payload,
    });
    if (error && typeof console !== "undefined") {
      console.warn("[lifecycle] insertReservaEvento", tipo, error.message);
    }
  } catch (e) {
    if (typeof console !== "undefined") {
      console.warn("[lifecycle] insertReservaEvento exception", tipo, e instanceof Error ? e.message : String(e));
    }
  }
}

/** Aceita service_role por igualdade com o secret da Edge ou claim JWT `role=service_role`. */
function isServiceRoleBearer(token: string, expectedServiceKey: string): boolean {
  if (!token) return false;
  if (expectedServiceKey && token === expectedServiceKey) return true;
  const parts = token.split(".");
  if (parts.length < 2) return false;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = atob(b64 + pad);
    const payload = JSON.parse(json) as { role?: string };
    return String(payload.role ?? "").toLowerCase() === "service_role";
  } catch {
    return false;
  }
}

/**
 * Mesmo padrão de `internal-users-admin`: client com Authorization nos headers globais + getUser(),
 * em vez de getClaims/getUser(jwt) num client sem header (comportamento inconsistente no Edge).
 */
async function ensureCallerAllowed(request: Request): Promise<void> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    throw new HttpError("Autenticação obrigatória.", 401);
  }

  // Chamada interna send-senha→lifecycle_provision com service_role.
  // Necessária quando a quitação Pagar.me fecha depois da FNRH (sem JWT de operador).
  const internalCaller = String(request.headers.get("x-yes-internal-caller") ?? "")
    .trim()
    .toLowerCase();
  if (internalCaller === "send-senha" && isServiceRoleBearer(token, supabaseServiceKey)) {
    return;
  }

  const requestClient = createRequestClientWithAuth(request);
  const {
    data: { user },
    error: userError,
  } = await requestClient.auth.getUser();

  if (userError || !user?.id) {
    if (typeof console !== "undefined") {
      console.warn("[lifecycle] ensureCallerAllowed getUser", userError?.message ?? "no user");
    }
    throw new HttpError("Sessão inválida ou expirada.", 401);
  }

  const { data: row, error: rowError } = await adminClient
    .from("usuarios_internos")
    .select("perfil_usuario, ativo")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (rowError || !row) {
    if (typeof console !== "undefined") {
      console.warn("[lifecycle] ensureCallerAllowed usuarios_internos", rowError?.message ?? "no row", "auth_uid=" + user.id);
    }
    throw new HttpError("Usuário sem cadastro interno autorizado.", 403);
  }

  if (!row.ativo) {
    throw new HttpError("Usuário interno inativo.", 403);
  }

  const role = String(row.perfil_usuario ?? "").trim().toLowerCase();
  if (role !== "admin" && role !== "recepcao") {
    throw new HttpError("Apenas admin ou recepção ativos podem executar esta ação.", 403);
  }
}

function isTtlockAvailable(): boolean {
  return !!(
    ttlockClientId.trim() &&
    ttlockClientSecret.trim() &&
    ttlockUsername.trim() &&
    ttlockPassword.trim()
  );
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getTtlockToken(): Promise<string> {
  if (!isTtlockAvailable()) throw new Error("TTLock não configurado (variáveis de ambiente).");
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  // TTLOCK_USERNAME = conta do app TTLock (não do portal desenvolvedor). TTLOCK_PASSWORD = texto puro (enviamos MD5).
  const username = ttlockUsername.trim();
  const passwordPlain = ttlockPassword.trim();
  const passwordMd5 = String((md5 as (s: string) => string)(passwordPlain)).toLowerCase();
  const body = new URLSearchParams({
    client_id: ttlockClientId,
    client_secret: ttlockClientSecret,
    username,
    password: passwordMd5,
    grant_type: "password",
  });
  if (typeof console !== "undefined") console.log("[lifecycle] TTLock token URL=" + ttlockTokenUrl);
  const res = await fetch(ttlockTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
  if (typeof console !== "undefined") {
    console.log("[lifecycle] TTLock token res.status=" + res.status + " errcode=" + (data.errcode ?? "n/a") + " errmsg=" + (data.errmsg ?? "n/a"));
  }
  if (!res.ok || data.errcode !== undefined && data.errcode !== 0) {
    if (typeof console !== "undefined") console.warn("[lifecycle] TTLock token FAIL body=" + JSON.stringify({ ...data, access_token: data.access_token ? "***" : undefined }));
    throw new Error(data.errmsg ?? `TTLock token: ${res.status}`);
  }
  const token = data.access_token;
  if (!token) {
    if (typeof console !== "undefined") console.warn("[lifecycle] TTLock token no access_token body=" + JSON.stringify({ ...data, access_token: "***" }));
    throw new Error("TTLock: resposta sem access_token");
  }
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 7776000;
  cachedToken = { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
  return token;
}

const TTLOCK_DELETE_RETRY_MAX = 2;
const TTLOCK_DELAY_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retorna true se o erro parece transitório (vale retry). */
function isTransientDeleteError(res: Response, data: { errcode?: number }): boolean {
  if (res.status >= 500 || res.status === 429) return true;
  if (data.errcode != null && data.errcode !== 0) {
    const t = [10001, 10002, 10003, 10004]; // token/network-related TTLock codes exemplos
    if (t.includes(data.errcode)) return true;
  }
  return false;
}

async function ttlockDeleteKeyboardPassword(
  lockId: string | number,
  keyboardPwdId: number,
  ctx?: { reserva_id?: string; credencial_id?: string; credencial_item_id?: string; codigo_logico_destino?: string },
): Promise<void> {
  const lockIdNum = typeof lockId === "string" ? parseInt(lockId, 10) : lockId;
  const logErr = (attempt: number, errMsg: string) =>
    logTtlockLifecycle({
      action: "delete",
      source: "edge_function",
      reserva_id: ctx?.reserva_id,
      credencial_id: ctx?.credencial_id,
      credencial_item_id: ctx?.credencial_item_id,
      codigo_logico_destino: ctx?.codigo_logico_destino,
      remote_keyboard_pwd_id: keyboardPwdId,
      lock_id: lockIdNum,
      status: "error",
      error_message: errMsg,
      attempt,
      timestamp: new Date().toISOString(),
    });

  logTtlockLifecycle({
    action: "delete",
    source: "edge_function",
    reserva_id: ctx?.reserva_id,
    credencial_id: ctx?.credencial_id,
    credencial_item_id: ctx?.credencial_item_id,
    codigo_logico_destino: ctx?.codigo_logico_destino,
    remote_keyboard_pwd_id: keyboardPwdId,
    lock_id: lockIdNum,
    status: "start",
    attempt: 1,
    timestamp: new Date().toISOString(),
  });

  const token = await getTtlockToken();
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 1 + TTLOCK_DELETE_RETRY_MAX; attempt++) {
    if (attempt > 1) {
      logTtlockLifecycle({
        action: "delete",
        source: "edge_function",
        reserva_id: ctx?.reserva_id,
        credencial_id: ctx?.credencial_id,
        credencial_item_id: ctx?.credencial_item_id,
        codigo_logico_destino: ctx?.codigo_logico_destino,
        remote_keyboard_pwd_id: keyboardPwdId,
        lock_id: lockIdNum,
        status: "start",
        attempt,
        timestamp: new Date().toISOString(),
      });
      await delay(TTLOCK_DELAY_MS);
    }
    try {
      const params = new URLSearchParams();
      params.append("clientId", ttlockClientId);
      params.append("accessToken", token);
      params.append("lockId", String(lockIdNum));
      params.append("keyboardPwdId", String(keyboardPwdId));
      params.append("deleteType", "2");
      params.append("date", String(Date.now()));
      const res = await fetch(`${ttlockApiBase}/v3/keyboardPwd/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const text = await res.text();
      let data: { errcode?: number; errmsg?: string };
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        lastError = "TTLock delete respondeu não-JSON: " + text.substring(0, 200);
        if (attempt < 1 + TTLOCK_DELETE_RETRY_MAX) continue;
        logErr(attempt, lastError);
        throw new Error(lastError);
      }
      if (res.ok && (data.errcode == null || data.errcode === 0)) {
        logTtlockLifecycle({
          action: "delete",
          source: "edge_function",
          reserva_id: ctx?.reserva_id,
          credencial_id: ctx?.credencial_id,
          credencial_item_id: ctx?.credencial_item_id,
          codigo_logico_destino: ctx?.codigo_logico_destino,
          remote_keyboard_pwd_id: keyboardPwdId,
          lock_id: lockIdNum,
          status: "success",
          attempt,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      lastError = data.errmsg ?? `Delete passcode: ${res.status}`;
      const canRetry = attempt < 1 + TTLOCK_DELETE_RETRY_MAX && isTransientDeleteError(res, data);
      if (!canRetry) {
        logErr(attempt, lastError);
        throw new Error(lastError);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastError = msg;
      const canRetry = attempt < 1 + TTLOCK_DELETE_RETRY_MAX;
      if (!canRetry) {
        logErr(attempt, "Falha final após " + (1 + TTLOCK_DELETE_RETRY_MAX) + " tentativas: " + msg);
        throw e;
      }
    }
  }
  if (lastError) {
    logErr(1 + TTLOCK_DELETE_RETRY_MAX, "Falha final: " + lastError);
    throw new Error(lastError);
  }
}

/** Cria passcode temporário na fechadura (addType=2, via gateway). Retorna keyboardPwdId. */
async function ttlockAddKeyboardPassword(
  lockId: string | number,
  keyboardPwd: string,
  startDateMs: number,
  endDateMs: number,
  keyboardPwdName?: string,
  ctx?: { reserva_id?: string; credencial_id?: string; credencial_item_id?: string; codigo_logico_destino?: string },
): Promise<number> {
  const lockIdNum = typeof lockId === "string" ? parseInt(lockId, 10) : lockId;
  logTtlockLifecycle({
    action: "provision",
    source: "edge_function",
    reserva_id: ctx?.reserva_id,
    credencial_id: ctx?.credencial_id,
    credencial_item_id: ctx?.credencial_item_id,
    codigo_logico_destino: ctx?.codigo_logico_destino,
    lock_id: lockIdNum,
    status: "start",
    timestamp: new Date().toISOString(),
  });
  const token = await getTtlockToken();
  const params = new URLSearchParams();
  params.append("clientId", ttlockClientId);
  params.append("accessToken", token);
  params.append("lockId", String(lockIdNum));
  params.append("keyboardPwd", keyboardPwd);
  if (keyboardPwdName != null) params.append("keyboardPwdName", keyboardPwdName);
  params.append("startDate", String(startDateMs));
  params.append("endDate", String(endDateMs));
  params.append("addType", "2");
  params.append("date", String(Date.now()));
  const controller = new AbortController();
  const timeoutMs = Number(Deno.env.get("TTLOCK_REQUEST_TIMEOUT_MS") || 15000);
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 15000);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${ttlockApiBase}/v3/keyboardPwd/add`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    clearTimeout(timeout);
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && e.name === "AbortError";
    const errMsg = aborted ? `TTLock add timeout/aborted: ${msg}` : `TTLock add network error: ${msg}`;
    logTtlockLifecycle({
      action: "provision",
      source: "edge_function",
      reserva_id: ctx?.reserva_id,
      credencial_id: ctx?.credencial_id,
      credencial_item_id: ctx?.credencial_item_id,
      codigo_logico_destino: ctx?.codigo_logico_destino,
      lock_id: lockIdNum,
      status: "error",
      error_message: errMsg,
      timestamp: new Date().toISOString(),
    });
    const err = new Error(errMsg);
    if (aborted) err.name = "AbortError";
    throw err;
  }
  clearTimeout(timeout);
  let data: { keyboardPwdId?: number; errcode?: number; errmsg?: string };
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    logTtlockLifecycle({
      action: "provision",
      source: "edge_function",
      reserva_id: ctx?.reserva_id,
      credencial_id: ctx?.credencial_id,
      credencial_item_id: ctx?.credencial_item_id,
      codigo_logico_destino: ctx?.codigo_logico_destino,
      lock_id: lockIdNum,
      status: "error",
      error_message: "TTLock respondeu não-JSON: " + text.substring(0, 200),
      timestamp: new Date().toISOString(),
    });
    throw new Error("TTLock respondeu não-JSON: " + text.substring(0, 200));
  }
  if (data.errcode && data.errcode !== 0) {
    const errMsg = `TTLock erro ${data.errcode}: ${data.errmsg}`;
    logTtlockLifecycle({
      action: "provision",
      source: "edge_function",
      reserva_id: ctx?.reserva_id,
      credencial_id: ctx?.credencial_id,
      credencial_item_id: ctx?.credencial_item_id,
      codigo_logico_destino: ctx?.codigo_logico_destino,
      lock_id: lockIdNum,
      status: "error",
      error_message: errMsg,
      timestamp: new Date().toISOString(),
    });
    throw new Error(errMsg);
  }
  if (!res.ok) {
    const errMsg = data.errmsg ?? `Add passcode: ${res.status}`;
    logTtlockLifecycle({
      action: "provision",
      source: "edge_function",
      reserva_id: ctx?.reserva_id,
      credencial_id: ctx?.credencial_id,
      credencial_item_id: ctx?.credencial_item_id,
      codigo_logico_destino: ctx?.codigo_logico_destino,
      lock_id: lockIdNum,
      status: "error",
      error_message: errMsg,
      timestamp: new Date().toISOString(),
    });
    throw new Error(errMsg);
  }
  if (typeof data.keyboardPwdId !== "number") {
    logTtlockLifecycle({
      action: "provision",
      source: "edge_function",
      reserva_id: ctx?.reserva_id,
      credencial_id: ctx?.credencial_id,
      credencial_item_id: ctx?.credencial_item_id,
      codigo_logico_destino: ctx?.codigo_logico_destino,
      lock_id: lockIdNum,
      status: "error",
      error_message: "TTLock add passcode: resposta sem keyboardPwdId",
      timestamp: new Date().toISOString(),
    });
    throw new Error("TTLock add passcode: resposta sem keyboardPwdId");
  }
  logTtlockLifecycle({
    action: "provision",
    source: "edge_function",
    reserva_id: ctx?.reserva_id,
    credencial_id: ctx?.credencial_id,
    credencial_item_id: ctx?.credencial_item_id,
    codigo_logico_destino: ctx?.codigo_logico_destino,
    remote_keyboard_pwd_id: data.keyboardPwdId,
    lock_id: lockIdNum,
    status: "success",
    timestamp: new Date().toISOString(),
  });
  return data.keyboardPwdId;
}

/** Lista passcodes da fechadura (read-only) para reconciliação pós-timeout. */
async function ttlockListKeyboardPasswords(
  lockId: string | number,
): Promise<Array<{ keyboardPwdId: number; keyboardPwd?: string | null }>> {
  const lockIdNum = typeof lockId === "string" ? parseInt(lockId, 10) : lockId;
  const token = await getTtlockToken();
  const params = new URLSearchParams();
  params.append("clientId", ttlockClientId);
  params.append("accessToken", token);
  params.append("lockId", String(lockIdNum));
  params.append("pageNo", "1");
  params.append("pageSize", "100");
  params.append("date", String(Date.now()));
  const controller = new AbortController();
  const timeoutMs = Number(Deno.env.get("TTLOCK_REQUEST_TIMEOUT_MS") || 15000);
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 15000);
  try {
    const res = await fetch(`${ttlockApiBase}/v3/lock/listKeyboardPwd`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const text = await res.text();
    let data: { list?: Array<{ keyboardPwdId?: number; keyboardPwd?: string }>; errcode?: number; errmsg?: string };
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("TTLock listKeyboardPwd respondeu não-JSON: " + text.substring(0, 200));
    }
    if (!res.ok) {
      throw new Error(data.errmsg ?? `listKeyboardPwd HTTP ${res.status}`);
    }
    if (data.errcode != null && data.errcode !== 0) {
      throw new Error(`TTLock erro ${data.errcode}: ${data.errmsg ?? "listKeyboardPwd"}`);
    }
    const list = Array.isArray(data.list) ? data.list : [];
    return list
      .filter((r) => typeof r.keyboardPwdId === "number")
      .map((r) => ({
        keyboardPwdId: r.keyboardPwdId as number,
        keyboardPwd: r.keyboardPwd ?? null,
      }));
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error && e.name === "AbortError") {
      const err = new Error("TTLock listKeyboardPwd timeout/aborted");
      err.name = "AbortError";
      throw err;
    }
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * Altera somente startDate/endDate de um passcode existente (keyboardPwd/change).
 * NÃO envia newKeyboardPwd — preserva a senha remota.
 */
async function ttlockChangeKeyboardPasswordValidity(
  lockId: string | number,
  keyboardPwdId: number,
  startDateMs: number,
  endDateMs: number,
  ctx?: { reserva_id?: string; credencial_id?: string; credencial_item_id?: string; codigo_logico_destino?: string },
): Promise<void> {
  const lockIdNum = typeof lockId === "string" ? parseInt(lockId, 10) : lockId;
  logTtlockLifecycle({
    action: "change_validity",
    source: "edge_function",
    reserva_id: ctx?.reserva_id,
    credencial_id: ctx?.credencial_id,
    credencial_item_id: ctx?.credencial_item_id,
    codigo_logico_destino: ctx?.codigo_logico_destino,
    remote_keyboard_pwd_id: keyboardPwdId,
    lock_id: lockIdNum,
    start_date_ms: startDateMs,
    end_date_ms: endDateMs,
    status: "start",
    timestamp: new Date().toISOString(),
  });
  const token = await getTtlockToken();
  const params = new URLSearchParams();
  params.append("clientId", ttlockClientId);
  params.append("accessToken", token);
  params.append("lockId", String(lockIdNum));
  params.append("keyboardPwdId", String(keyboardPwdId));
  params.append("startDate", String(startDateMs));
  params.append("endDate", String(endDateMs));
  params.append("changeType", "2");
  params.append("date", String(Date.now()));
  const res = await fetch(`${ttlockApiBase}/v3/keyboardPwd/change`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  let data: { errcode?: number; errmsg?: string };
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const errMsg = "TTLock change respondeu não-JSON: " + text.substring(0, 200);
    logTtlockLifecycle({
      action: "change_validity",
      source: "edge_function",
      reserva_id: ctx?.reserva_id,
      credencial_id: ctx?.credencial_id,
      credencial_item_id: ctx?.credencial_item_id,
      codigo_logico_destino: ctx?.codigo_logico_destino,
      remote_keyboard_pwd_id: keyboardPwdId,
      lock_id: lockIdNum,
      status: "error",
      error_message: errMsg,
      timestamp: new Date().toISOString(),
    });
    throw new Error(errMsg);
  }
  if (data.errcode != null && data.errcode !== 0) {
    const errMsg = `TTLock erro ${data.errcode}: ${data.errmsg ?? "change failed"}`;
    logTtlockLifecycle({
      action: "change_validity",
      source: "edge_function",
      reserva_id: ctx?.reserva_id,
      credencial_id: ctx?.credencial_id,
      credencial_item_id: ctx?.credencial_item_id,
      codigo_logico_destino: ctx?.codigo_logico_destino,
      remote_keyboard_pwd_id: keyboardPwdId,
      lock_id: lockIdNum,
      status: "error",
      error_message: errMsg,
      timestamp: new Date().toISOString(),
    });
    throw new Error(errMsg);
  }
  if (!res.ok) {
    const errMsg = data.errmsg ?? `Change passcode validity: ${res.status}`;
    logTtlockLifecycle({
      action: "change_validity",
      source: "edge_function",
      reserva_id: ctx?.reserva_id,
      credencial_id: ctx?.credencial_id,
      credencial_item_id: ctx?.credencial_item_id,
      codigo_logico_destino: ctx?.codigo_logico_destino,
      remote_keyboard_pwd_id: keyboardPwdId,
      lock_id: lockIdNum,
      status: "error",
      error_message: errMsg,
      timestamp: new Date().toISOString(),
    });
    throw new Error(errMsg);
  }
  logTtlockLifecycle({
    action: "change_validity",
    source: "edge_function",
    reserva_id: ctx?.reserva_id,
    credencial_id: ctx?.credencial_id,
    credencial_item_id: ctx?.credencial_item_id,
    codigo_logico_destino: ctx?.codigo_logico_destino,
    remote_keyboard_pwd_id: keyboardPwdId,
    lock_id: lockIdNum,
    status: "success",
    timestamp: new Date().toISOString(),
  });
}

type CredencialRow = {
  id: string;
  reserva_id: string;
  status: string;
  sync_status?: string | null;
  last_sync_attempt_at?: string | null;
  last_sync_error?: string | null;
};

/**
 * Credencial para provisionamento: select alinhado ao schema mínimo em produção
 * (id, reserva_id, tipo_credencial, status, valido_de, valido_ate, motivo_origem, timestamps).
 * codigo_credencial / provider_tipo são opcionais quando existirem migrações TTLock (0007+).
 */
type CredencialForProvision = {
  id: string;
  reserva_id: string;
  status: string;
  valido_de: string;
  valido_ate: string;
  tipo_credencial?: string;
  motivo_origem?: string;
  codigo_credencial?: string | null;
  provider_tipo?: string | null;
  last_sync_error?: string | null;
};

type ItemRow = {
  id: string;
  credencial_id: string;
  lock_id_ttlock: string;
  status_provisionamento: string;
  remote_keyboard_pwd_id: number | null;
  codigo_logico_destino: string;
  ultimo_erro?: string | null;
};

async function getCredencialPorReserva(reservaId: string): Promise<CredencialRow | null> {
  const normalizedId = String(reservaId ?? "").trim().toLowerCase();
  if (!normalizedId) return null;
  const { data, error } = await adminClient
    .from("operacional_credenciais_acesso")
    .select("id, reserva_id, status")
    .eq("reserva_id", normalizedId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { id: string; reserva_id: string; status: string };
  const cred: CredencialRow = {
    id: row.id,
    reserva_id: row.reserva_id,
    status: row.status,
    sync_status: null,
    last_sync_attempt_at: null,
    last_sync_error: null,
  };
  try {
    const { data: extra } = await adminClient
      .from("operacional_credenciais_acesso")
      .select("sync_status, last_sync_attempt_at, last_sync_error")
      .eq("id", row.id)
      .maybeSingle();
    if (extra && typeof extra === "object") {
      cred.sync_status = (extra as { sync_status?: string | null }).sync_status ?? null;
      cred.last_sync_attempt_at = (extra as { last_sync_attempt_at?: string | null }).last_sync_attempt_at ?? null;
      cred.last_sync_error = (extra as { last_sync_error?: string | null }).last_sync_error ?? null;
    }
  } catch {
    // sync_* existem só após migration 0009
  }
  return cred;
}

async function loadReservaTtlockFormatContext(reservaId: string): Promise<{
  apartamento: string | null;
  external_reservation_id: string | null;
  principal_guest_nome: string | null;
  hospede_principal: string | null;
}> {
  const { data: reserva } = await adminClient
    .from("operacional_reservas")
    .select("apartamento, external_reservation_id, hospede_principal")
    .eq("id", reservaId)
    .maybeSingle();
  const { data: hosp } = await adminClient
    .from("operacional_hospedes")
    .select("nome")
    .eq("reserva_id", reservaId)
    .eq("principal", true)
    .limit(1)
    .maybeSingle();
  const r = reserva as {
    apartamento?: string | null;
    external_reservation_id?: string | null;
    hospede_principal?: string | null;
  } | null;
  const h = hosp as { nome?: string | null } | null;
  return {
    apartamento: r?.apartamento != null && String(r.apartamento).trim() ? String(r.apartamento).trim() : null,
    external_reservation_id: r?.external_reservation_id != null && String(r.external_reservation_id).trim()
      ? String(r.external_reservation_id).trim()
      : null,
    principal_guest_nome: h?.nome != null && String(h.nome).trim() ? String(h.nome).trim() : null,
    hospede_principal: r?.hospede_principal != null && String(r.hospede_principal).trim()
      ? String(r.hospede_principal).trim()
      : null,
  };
}

/** Colunas que existem na tabela base em produção (sem codigo_credencial / provider_tipo). */
const CREDENCIAL_PROVISION_SELECT =
  "id, reserva_id, tipo_credencial, status, valido_de, valido_ate, motivo_origem, created_at, updated_at";

/** Por reserva_id + tipo principal. Erro de PostgREST → HttpError (não confundir com “não encontrada”). */
async function getCredencialForProvision(reservaId: string): Promise<CredencialForProvision | null> {
  const normalizedId = String(reservaId ?? "").trim().toLowerCase();
  if (!normalizedId) return null;
  if (typeof console !== "undefined") console.log("[lifecycle] getCredencialForProvision by reserva_id=" + normalizedId);
  const { data, error } = await adminClient
    .from("operacional_credenciais_acesso")
    .select(CREDENCIAL_PROVISION_SELECT)
    .eq("reserva_id", normalizedId)
    .eq("tipo_credencial", "principal")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    if (typeof console !== "undefined") {
      console.warn(
        "[lifecycle] getCredencialForProvision query error reserva_id=" + normalizedId,
        (error as { code?: string }).code ?? "",
        error.message,
      );
    }
    throw new HttpError(
      "Erro ao consultar operacional_credenciais_acesso por reserva_id: " + error.message,
      500,
    );
  }
  const row = Array.isArray(data) && data[0] ? data[0] : null;
  return row ? (row as CredencialForProvision) : null;
}

/** Quando o payload trouxe o UUID da credencial em vez do da reserva (ex. `payload.id`). */
async function getCredencialPrincipalPorId(credencialId: string): Promise<CredencialForProvision | null> {
  const id = String(credencialId ?? "").trim().toLowerCase();
  if (!id) return null;
  if (typeof console !== "undefined") console.log("[lifecycle] getCredencialPrincipalPorId id=" + id);
  const { data, error } = await adminClient
    .from("operacional_credenciais_acesso")
    .select(CREDENCIAL_PROVISION_SELECT)
    .eq("id", id)
    .eq("tipo_credencial", "principal")
    .limit(1);
  if (error) {
    if (typeof console !== "undefined") {
      console.warn(
        "[lifecycle] getCredencialPrincipalPorId query error id=" + id,
        (error as { code?: string }).code ?? "",
        error.message,
      );
    }
    throw new HttpError(
      "Erro ao consultar operacional_credenciais_acesso por id: " + error.message,
      500,
    );
  }
  const row = Array.isArray(data) && data[0] ? data[0] : null;
  return row ? (row as CredencialForProvision) : null;
}

async function getAllItensCredencial(credencialId: string): Promise<ItemRow[]> {
  const cid = String(credencialId ?? "").trim();
  if (!cid) {
    throw new HttpError("credencialId inválido para listagem de itens.", 400);
  }
  const { data, error } = await adminClient
    .from("operacional_credencial_itens")
    .select(
      "id, credencial_id, lock_id_ttlock, status_provisionamento, codigo_logico_destino, remote_keyboard_pwd_id, ultimo_erro",
    )
    .eq("credencial_id", cid);
  if (error) {
    throw new HttpError("Falha ao listar itens da credencial: " + error.message, 500);
  }
  return (Array.isArray(data) ? data : []) as ItemRow[];
}

/** Pendente, provisionando (retry transitório) ou falhou sem remote id. */
async function getItensPendentes(credencialId: string): Promise<ItemRow[]> {
  const all = await getAllItensCredencial(credencialId);
  return all.filter(
    (i) =>
      i.status_provisionamento === "pendente" ||
      i.status_provisionamento === "provisionando" ||
      (i.status_provisionamento === "falhou" && i.remote_keyboard_pwd_id == null),
  );
}

/**
 * PINs ocupados nos locks obrigatórios — sem filtro temporal/status de reserva.
 * Inclui vencidas, futuras, inativas; exclui só delete remoto confirmado (`revogado`).
 */
async function listOccupiedPasscodesOnLocks(
  lockIds: string[],
  excludeCredencialId: string,
): Promise<Set<string>> {
  const locks = lockIds.map((x) => String(x || "").trim()).filter(Boolean);
  if (locks.length === 0) return new Set();
  const { data: itens } = await adminClient
    .from("operacional_credencial_itens")
    .select("credencial_id, lock_id_ttlock, status_provisionamento, remote_keyboard_pwd_id")
    .in("lock_id_ttlock", locks);
  const rows = (itens ?? []) as {
    credencial_id: string;
    status_provisionamento: string;
    remote_keyboard_pwd_id: number | null;
  }[];
  const credIds = [
    ...new Set(
      rows
        .map((r) => String(r.credencial_id || "").trim())
        .filter((id) => id && id !== excludeCredencialId),
    ),
  ];
  if (credIds.length === 0) return new Set();
  const { data: creds } = await adminClient
    .from("operacional_credenciais_acesso")
    .select("id, codigo_credencial")
    .in("id", credIds);
  const pinByCred = new Map<string, string | null>();
  for (const c of creds ?? []) {
    const row = c as { id: string; codigo_credencial?: string | null };
    pinByCred.set(String(row.id), row.codigo_credencial ?? null);
  }
  return collectOccupiedPasscodesFromRows(
    rows.map((r) => ({
      credencial_id: r.credencial_id,
      codigo_credencial: pinByCred.get(String(r.credencial_id)) ?? null,
      status_provisionamento: r.status_provisionamento,
      remote_keyboard_pwd_id: r.remote_keyboard_pwd_id,
    })),
    excludeCredencialId,
  );
}

async function getItensProvisionados(credencialId: string): Promise<ItemRow[]> {
  const { data, error } = await adminClient
    .from("operacional_credencial_itens")
    .select("id, credencial_id, lock_id_ttlock, status_provisionamento, codigo_logico_destino, remote_keyboard_pwd_id")
    .eq("credencial_id", credencialId)
    .eq("status_provisionamento", "provisionado");
  if (error || !Array.isArray(data)) return [];
  return data as ItemRow[];
}

/** Itens com delete remoto pendente (status pendente_limpeza; janela até ~2h pós-checkout). */
async function getItensPendentesLimpeza(credencialId: string): Promise<ItemRow[]> {
  const { data, error } = await adminClient
    .from("operacional_credencial_itens")
    .select("id, credencial_id, lock_id_ttlock, status_provisionamento, codigo_logico_destino, remote_keyboard_pwd_id")
    .eq("credencial_id", credencialId)
    .eq("status_provisionamento", "pendente_limpeza")
    .not("remote_keyboard_pwd_id", "is", null);
  if (error || !Array.isArray(data)) return [];
  return data as ItemRow[];
}

const NOW = () => new Date().toISOString();

async function revokeCredencial(
  credencialId: string,
  reservaId: string,
  motivo: "cancelamento" | "checkout",
): Promise<{
  credencialId: string;
  reservaId: string;
  status: string;
  itensRevogados: number;
  itensFalha: number;
  syncStatus: string;
  lastSyncError: string | null;
  erros: string[];
}> {
  const itens = await getItensProvisionados(credencialId);
  const itensPendentesLimpeza = await getItensPendentesLimpeza(credencialId);
  const erros: string[] = [];
  let revogados = 0;
  let falhas = 0;
  const now = NOW();

  for (const item of itens) {
    if (item.remote_keyboard_pwd_id == null) {
      // Encerramento apenas local: não há passcode remoto a confirmar; revogado_em = fim local.
      if (typeof console !== "undefined") {
        console.warn("[lifecycle] Item provisionado sem remote_keyboard_pwd_id (credencial_id=" + credencialId + " item_id=" + item.id + "). Encerramento apenas local; possível inconsistência de persistência.");
      }
      await adminClient
        .from("operacional_credencial_itens")
        .update({ status_provisionamento: "revogado", revogado_em: now })
        .eq("id", item.id);
      revogados++;
      continue;
    }
    if (isTtlockAvailable()) {
      try {
        await ttlockDeleteKeyboardPassword(item.lock_id_ttlock, item.remote_keyboard_pwd_id, {
          reserva_id: reservaId,
          credencial_id: credencialId,
          credencial_item_id: item.id,
          codigo_logico_destino: item.codigo_logico_destino,
        });
        await adminClient
          .from("operacional_credencial_itens")
          .update({ status_provisionamento: "revogado", revogado_em: now, ultimo_erro: null })
          .eq("id", item.id);
        revogados++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        erros.push(`${item.codigo_logico_destino}: ${msg}`);
        await adminClient
          .from("operacional_credencial_itens")
          .update({ status_provisionamento: "pendente_limpeza", ultimo_erro: msg })
          .eq("id", item.id);
        falhas++;
      }
    } else {
      // TTLock indisponível: encerramento apenas local; não há confirmação remota.
      await adminClient
        .from("operacional_credencial_itens")
        .update({
          status_provisionamento: "revogado",
          revogado_em: now,
          ultimo_erro: "TTLock indisponível; revogação apenas local.",
        })
        .eq("id", item.id);
      revogados++;
    }
  }

  for (const item of itensPendentesLimpeza) {
    if (item.remote_keyboard_pwd_id == null) continue;
    if (!isTtlockAvailable()) continue;
    try {
      await ttlockDeleteKeyboardPassword(item.lock_id_ttlock, item.remote_keyboard_pwd_id, {
        reserva_id: reservaId,
        credencial_id: credencialId,
        credencial_item_id: item.id,
        codigo_logico_destino: item.codigo_logico_destino,
      });
      await adminClient
        .from("operacional_credencial_itens")
        .update({ status_provisionamento: "revogado", revogado_em: now, ultimo_erro: null })
        .eq("id", item.id);
      revogados++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      erros.push(`${item.codigo_logico_destino}: ${msg}`);
      await adminClient
        .from("operacional_credencial_itens")
        .update({ ultimo_erro: msg })
        .eq("id", item.id);
      falhas++;
    }
  }

  let syncStatus: "ok" | "pending" | "partial" | "failed" = "ok";
  let lastSyncError: string | null = null;
  if (!isTtlockAvailable() && itens.length > 0) {
    syncStatus = "pending";
    lastSyncError = "TTLock indisponível; revogação apenas local.";
  } else if (falhas > 0) {
    syncStatus = revogados > 0 ? "partial" : "failed";
    lastSyncError = erros.slice(0, 3).join("; ");
  }

  await adminClient
    .from("operacional_credenciais_acesso")
    .update({
      status: "revogada",
      revogado_em: now,
      motivo_revogacao: motivo,
      sync_status: syncStatus,
      last_sync_attempt_at: now,
      last_sync_error: lastSyncError,
    })
    .eq("id", credencialId);

  return {
    credencialId,
    reservaId,
    status: "revogada",
    itensRevogados: revogados,
    itensFalha: falhas,
    syncStatus,
    lastSyncError,
    erros,
  };
}

async function handleLifecycleProvision(request: Request, payload: Record<string, unknown>): Promise<Response> {
  await ensureCallerAllowed(request);
  let reservaId = requireReservaId(payload);
  const idPesquisa = reservaId.trim().toLowerCase();

  let credencial = await getCredencialForProvision(idPesquisa);
  if (!credencial && isUuidLike(idPesquisa)) {
    credencial = await getCredencialPrincipalPorId(idPesquisa);
    if (credencial && typeof console !== "undefined") {
      console.warn(
        "[lifecycle] lifecycle_provision: resolvido por UUID da credencial (payload não era reserva_id). reserva_id efetivo=" +
          credencial.reserva_id,
      );
    }
  }
  if (credencial) {
    reservaId = String(credencial.reserva_id).trim().toLowerCase();
    try {
      const { data: syncExtra } = await adminClient
        .from("operacional_credenciais_acesso")
        .select("last_sync_error, codigo_credencial, provider_tipo")
        .eq("id", credencial.id)
        .maybeSingle();
      if (syncExtra && typeof syncExtra === "object") {
        const sx = syncExtra as {
          last_sync_error?: string | null;
          codigo_credencial?: string | null;
          provider_tipo?: string | null;
        };
        credencial.last_sync_error = sx.last_sync_error ?? null;
        if (sx.codigo_credencial != null) credencial.codigo_credencial = sx.codigo_credencial;
        if (sx.provider_tipo != null) credencial.provider_tipo = sx.provider_tipo;
      }
    } catch {
      // colunas sync/codigo opcionais em legado
    }
  }

  if (!credencial) {
    await insertReservaEvento(reservaId, "ttlock_credencial_nao_encontrada", "TTLock: credencial não encontrada", {
      action: "lifecycle_provision",
      credencial_id: null,
      status_final: null,
      total_itens: 0,
      provisionados: 0,
      falhas: 0,
      revogados: 0,
      erro_resumido: "Nenhuma credencial de acesso encontrada para esta reserva.",
    });
    return jsonResponse(
      {
        ok: false,
        error: "Nenhuma credencial de acesso encontrada para esta reserva.",
        reservaId,
      },
      404,
    );
  }
  if (credencial.status === "revogada") {
    await insertReservaEvento(reservaId, "ttlock_provision_bloqueado_revogada", "TTLock: provisionamento bloqueado (credencial revogada)", {
      action: "lifecycle_provision",
      credencial_id: credencial.id,
      status_final: "revogada",
      total_itens: 0,
      provisionados: 0,
      falhas: 0,
      revogados: 0,
      erro_resumido: "Não é possível provisionar credencial revogada.",
    });
    return jsonResponse(
      {
        ok: false,
        error: "Não é possível provisionar credencial revogada.",
        reservaId,
        credencialId: credencial.id,
      },
      400,
    );
  }

  const credIdForItens = String(credencial.id).trim();
  const itens = await getItensPendentes(credIdForItens);

  if (itens.length === 0) {
    const { count, error: cntErr } = await adminClient
      .from("operacional_credencial_itens")
      .select("id", { count: "exact", head: true })
      .eq("credencial_id", credIdForItens);
    if (cntErr && typeof console !== "undefined") {
      console.warn("[lifecycle] count itens por credencial", credIdForItens, cntErr.message);
    }
    if (!cntErr && count != null && count > 0) {
      const { data: diag } = await adminClient
        .from("operacional_credencial_itens")
        .select("id, status_provisionamento, codigo_logico_destino")
        .eq("credencial_id", credIdForItens);
      if (typeof console !== "undefined") {
        console.warn(
          "[lifecycle] lifecycle_provision: lista pendente vazia mas credencial tem " + count +
            " itens; diagnostico=" + JSON.stringify(diag ?? []),
        );
      }
      const rows = Array.isArray(diag) ? diag : [];
      const allProvisionado =
        rows.length === count &&
        rows.length > 0 &&
        rows.every((i) => i.status_provisionamento === "provisionado");
      if (allProvisionado) {
        if (credencial.status !== "provisionada") {
          await adminClient
            .from("operacional_credenciais_acesso")
            .update({ status: "provisionada" })
            .eq("id", credIdForItens);
        }
        await insertReservaEvento(reservaId, "ttlock_provision_ja_concluido", "TTLock: provisionamento já concluído (idempotente)", {
          action: "lifecycle_provision",
          credencial_id: credIdForItens,
          status_final: "provisionada",
          total_itens: count,
          provisionados: count,
          falhas: 0,
          revogados: 0,
          erro_resumido: null,
        });
        return jsonResponse({
          ok: true,
          idempotente: true,
          message: "Todos os itens já estavam provisionados no TTLock.",
          credencialId: credIdForItens,
          reservaId,
          status: "provisionada",
          passcode: credencial.codigo_credencial ?? null,
          totalItens: count,
          provisionados: count,
          falhas: 0,
          erros: [],
        });
      }
      await insertReservaEvento(reservaId, "ttlock_provision_sem_pendente_com_itens", "TTLock: itens na credencial sem status pendente", {
        action: "lifecycle_provision",
        credencial_id: credIdForItens,
        status_final: credencial.status,
        total_itens: count,
        provisionados: 0,
        falhas: 0,
        revogados: 0,
        erro_resumido: "Nenhum item em status_provisionamento=pendente (ver itensDiagnostic).",
      });
      return jsonResponse(
        {
          ok: false,
          error:
            "Nenhum item com status pendente para provisionar; a credencial possui itens com outro status. Verifique status_provisionamento no banco.",
          credencialId: credIdForItens,
          reservaId,
          itensDiagnostic: diag ?? [],
        },
        409,
      );
    }

    await insertReservaEvento(reservaId, "ttlock_provision_sem_itens_pendentes", "TTLock: nenhum item pendente para provisionar", {
      action: "lifecycle_provision",
      credencial_id: credencial.id,
      status_final: credencial.status,
      total_itens: 0,
      provisionados: 0,
      falhas: 0,
      revogados: 0,
      erro_resumido: null,
    });
    return jsonResponse({
      ok: true,
      idempotente: true,
      message: "Nenhum item pendente para provisionar.",
      credencialId: credencial.id,
      reservaId,
      status: credencial.status,
      passcode: credencial.codigo_credencial ?? null,
      totalItens: 0,
      provisionados: 0,
      falhas: 0,
      erros: [],
    });
  }

  const ttlockCtx = await loadReservaTtlockFormatContext(reservaId);
  const keyboardPwdBaseName = formatTtlockKeyboardPwdName(
    ttlockCtx.apartamento,
    ttlockCtx.principal_guest_nome ?? ttlockCtx.hospede_principal,
  );

  const allItensBefore = await getAllItensCredencial(credencial.id);
  const alreadyRemoteOk = allItensBefore.some(
    (i) => i.status_provisionamento === "provisionado" && i.remote_keyboard_pwd_id != null,
  );
  const lockIds = [
    ...new Set(allItensBefore.map((i) => String(i.lock_id_ttlock || "").trim()).filter(Boolean)),
  ];
  const localBlocked = await listOccupiedPasscodesOnLocks(lockIds, credencial.id);
  const rejectedPins = new Set<string>();

  let passcode = credencial.codigo_credencial
    ? String(credencial.codigo_credencial).trim()
    : "";
  // Credencial já com sucesso remoto: nunca trocar PIN. Senão: aleatório + evitar colisão local (global por lock).
  if (!alreadyRemoteOk) {
    if (!passcode || localBlocked.has(passcode)) {
      if (passcode) rejectedPins.add(passcode);
      passcode = allocateNewTtlockPasscode(new Set([...localBlocked, ...rejectedPins]));
    }
  } else if (!passcode) {
    passcode = allocateNewTtlockPasscode(localBlocked);
  }

  const credencialPatch: Record<string, unknown> = {
    status: "provisionando",
    codigo_credencial: passcode,
    provider_tipo: "ttlock_passcode",
  };

  let upErr = (
    await adminClient
      .from("operacional_credenciais_acesso")
      .update(credencialPatch)
      .eq("id", credencial.id)
  ).error;

  if (upErr) {
    // Fallback: só status se colunas TTLock ausentes (legado).
    upErr = (
      await adminClient
        .from("operacional_credenciais_acesso")
        .update({ status: "provisionando" })
        .eq("id", credencial.id)
    ).error;
  }
  if (upErr) {
    throw new HttpError(
      "Falha ao atualizar credencial para provisionamento: " + upErr.message,
      500,
    );
  }

  await insertReservaEvento(reservaId, "ttlock_provision_iniciado", "TTLock: provisionamento iniciado", {
    action: "lifecycle_provision_iniciado",
    credencial_id: credencial.id,
    status_final: "provisionando",
    total_itens: itens.length,
    provisionados: 0,
    falhas: 0,
    revogados: 0,
    erro_resumido: null,
  });

  // Janela civil do hotel (America/Campo_Grande), nunca "13:00" interpretado como UTC.
  const { data: reservaDatas } = await adminClient
    .from("operacional_reservas")
    .select("check_in_previsto, check_out_previsto")
    .eq("id", reservaId)
    .maybeSingle();
  const checkIn = (reservaDatas as { check_in_previsto?: string } | null)?.check_in_previsto;
  const checkOut = (reservaDatas as { check_out_previsto?: string } | null)?.check_out_previsto;
  let validoDeIso = String(credencial.valido_de ?? "");
  let validoAteIso = String(credencial.valido_ate ?? "");
  if (checkIn && checkOut) {
    const corrected = resolveDefaultCredentialValidityIso(checkIn, checkOut);
    const storedDe = new Date(credencial.valido_de).getTime();
    const storedAte = new Date(credencial.valido_ate).getTime();
    const wantDe = new Date(corrected.valido_de).getTime();
    const wantAte = new Date(corrected.valido_ate).getTime();
    if (storedDe !== wantDe || storedAte !== wantAte) {
      await adminClient
        .from("operacional_credenciais_acesso")
        .update({ valido_de: corrected.valido_de, valido_ate: corrected.valido_ate })
        .eq("id", credencial.id);
      validoDeIso = corrected.valido_de;
      validoAteIso = corrected.valido_ate;
    }
  }
  const { startDateMs: validoDeMs, endDateMs: validoAteMs } = validityIsoToTtlockMs(
    validoDeIso,
    validoAteIso,
  );
  const erros: string[] = [];
  const now = NOW();

  if (!isTtlockAvailable()) {
    if (typeof console !== "undefined") {
      console.warn(
        "[lifecycle] TTLock indisponível: env CLIENT_ID=" +
          !!ttlockClientId +
          " SECRET=" +
          !!ttlockClientSecret +
          " USER=" +
          !!ttlockUsername +
          " PWD=" +
          !!ttlockPassword,
      );
    }
    const msg = "TTLock não configurado (variáveis de ambiente).";
    erros.push(msg);
    for (const item of itens) {
      await adminClient
        .from("operacional_credencial_itens")
        .update({ status_provisionamento: "falhou", ultimo_erro: msg })
        .eq("id", item.id);
    }
    const after = await getAllItensCredencial(credencial.id);
    const resolved = resolveProvisionCredentialStatus(after);
    await adminClient
      .from("operacional_credenciais_acesso")
      .update({ status: resolved.status })
      .eq("id", credencial.id);
    await insertReservaEvento(reservaId, "ttlock_provision_ttlock_indisponivel", "TTLock: provisionamento sem API (variáveis ausentes)", {
      action: "lifecycle_provision_concluido",
      credencial_id: credencial.id,
      status_final: resolved.status,
      total_itens: after.length,
      provisionados: resolved.provisionados,
      falhas: resolved.falhas,
      revogados: 0,
      erro_resumido: msg,
    });
    return jsonResponse(
      {
        ok: false,
        error: msg,
        message: "Provisionamento falhou; TTLock indisponível.",
        credencialId: credencial.id,
        reservaId,
        status: resolved.status,
        totalItens: after.length,
        provisionados: resolved.provisionados,
        falhas: resolved.falhas,
        erros,
      },
      503,
    );
  }

  let collisionAttempt = 0;
  let workingItens = itens;
  let rollbackFailed = false;
  let hadTransientPending = false;
  let lastTransientClass = "transient";
  const shortRetryMax = Number(Deno.env.get("TTLOCK_PROVISION_SHORT_RETRY_MAX") || TTLOCK_PROVISION_SHORT_RETRY_MAX);
  const shortDelayMs = Number(Deno.env.get("TTLOCK_PROVISION_SHORT_DELAY_MS") || TTLOCK_PROVISION_SHORT_DELAY_MS);
  const shortBudgetMs = Number(Deno.env.get("TTLOCK_PROVISION_SHORT_BUDGET_MS") || TTLOCK_PROVISION_SHORT_BUDGET_MS);
  const phase2Max = Number(Deno.env.get("TTLOCK_PROVISION_PHASE2_MAX") || TTLOCK_PROVISION_PHASE2_MAX);
  const budget: ShortRetryBudget = {
    sleptMs: 0,
    maxBudgetMs: Number.isFinite(shortBudgetMs) ? shortBudgetMs : TTLOCK_PROVISION_SHORT_BUDGET_MS,
  };
  const priorTransient = parseTransientRetryState(credencial.last_sync_error);
  let phase2Count = priorTransient?.phase === 2 ? priorTransient.count : 0;

  while (workingItens.length > 0) {
    let roundCollision = false;
    hadTransientPending = false;
    const provisionedThisRound: Array<{ item: ItemRow; keyboardPwdId: number }> = [];

    for (const item of workingItens) {
      if (roundCollision) {
        await adminClient
          .from("operacional_credencial_itens")
          .update({
            status_provisionamento: "falhou",
            ultimo_erro: "Abortado: colisão de passcode em outro lock da mesma tentativa.",
          })
          .eq("id", item.id);
        erros.push(`${item.codigo_logico_destino}: abortado por colisão no mesmo round`);
        continue;
      }

      await adminClient
        .from("operacional_credencial_itens")
        .update({ status_provisionamento: "provisionando" })
        .eq("id", item.id);

      const result = await attemptProvisionLockWithSamePinRetry({
        passcode,
        shortRetryMax: Number.isFinite(shortRetryMax) ? shortRetryMax : TTLOCK_PROVISION_SHORT_RETRY_MAX,
        shortDelayMs: Number.isFinite(shortDelayMs) ? shortDelayMs : TTLOCK_PROVISION_SHORT_DELAY_MS,
        budget,
        sleepFn: delay,
        addPasscode: () =>
          ttlockAddKeyboardPassword(
            item.lock_id_ttlock,
            passcode,
            validoDeMs,
            validoAteMs,
            keyboardPwdBaseName,
            {
              reserva_id: reservaId,
              credencial_id: credencial.id,
              credencial_item_id: item.id,
              codigo_logico_destino: item.codigo_logico_destino,
            },
          ),
        listPasscodes: () => ttlockListKeyboardPasswords(item.lock_id_ttlock),
        onAttemptLog: (info) => {
          logTtlockLifecycle({
            action: "provision",
            source: "edge_function",
            reserva_id: reservaId,
            credencial_id: credencial.id,
            credencial_item_id: item.id,
            codigo_logico_destino: item.codigo_logico_destino,
            lock_id: item.lock_id_ttlock,
            status:
              info.status === "reconciled"
                ? "success"
                : info.status === "error"
                  ? "error"
                  : "start",
            error_message: info.classification
              ? `class=${info.classification.class};transient=${info.classification.transient};retry_count=${info.attempt}`
              : info.status === "reconciled"
                ? "reconciled_after_uncertain"
                : undefined,
            timestamp: new Date().toISOString(),
          });
        },
      });

      if (result.ok) {
        await adminClient
          .from("operacional_credencial_itens")
          .update({
            status_provisionamento: "provisionado",
            provisionado_em: now,
            ultimo_erro: null,
            remote_keyboard_pwd_id: result.keyboardPwdId,
          })
          .eq("id", item.id);
        provisionedThisRound.push({ item, keyboardPwdId: result.keyboardPwdId });
        continue;
      }

      if (typeof console !== "undefined") {
        console.warn(
          "[lifecycle] TTLock provision item FAIL",
          item.codigo_logico_destino,
          "class=" + result.classification.class,
          "transient=" + result.classification.transient,
          "error=" + result.message,
        );
      }
      erros.push(`${item.codigo_logico_destino}: ${result.message}`);

      if (result.classification.class === "collision") {
        roundCollision = true;
        await adminClient
          .from("operacional_credencial_itens")
          .update({ status_provisionamento: "falhou", ultimo_erro: result.message })
          .eq("id", item.id);
        continue;
      }

      if (!result.stillRetryable) {
        await adminClient
          .from("operacional_credencial_itens")
          .update({ status_provisionamento: "falhou", ultimo_erro: result.message })
          .eq("id", item.id);
        continue;
      }

      // Transitório: manter provisionando; NÃO rollback dos locks OK.
      hadTransientPending = true;
      lastTransientClass = result.classification.class;
      const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
      await adminClient
        .from("operacional_credencial_itens")
        .update({
          status_provisionamento: "provisionando",
          ultimo_erro: formatProvisionItemTransientError({
            classification: result.classification,
            retryCount: result.attempts,
            nextRetryAt,
            phase: 2,
          }),
        })
        .eq("id", item.id);
    }

    workingItens = await getItensPendentes(credencial.id);
    if (workingItens.length === 0 && !roundCollision) break;
    if (!roundCollision) break;

    if (
      shouldRollbackPartialPasscodeAttempt({
        collisionOnAnyLock: true,
        provisionedInRound: provisionedThisRound.length,
        credentialNeverFullyProvisioned: !alreadyRemoteOk,
      })
    ) {
      for (const { item, keyboardPwdId } of provisionedThisRound) {
        try {
          await ttlockDeleteKeyboardPassword(
            item.lock_id_ttlock,
            keyboardPwdId,
            {
              reserva_id: reservaId,
              credencial_id: credencial.id,
              credencial_item_id: item.id,
              codigo_logico_destino: item.codigo_logico_destino,
            },
          );
          await adminClient
            .from("operacional_credencial_itens")
            .update({
              status_provisionamento: "pendente",
              remote_keyboard_pwd_id: null,
              provisionado_em: null,
              ultimo_erro: null,
            })
            .eq("id", item.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          rollbackFailed = true;
          erros.push(`${item.codigo_logico_destino}: rollback falhou: ${msg}`);
          await adminClient
            .from("operacional_credencial_itens")
            .update({
              status_provisionamento: "pendente_limpeza",
              ultimo_erro: `Rollback após colisão -3007 falhou: ${msg}`,
            })
            .eq("id", item.id);
        }
      }
      if (rollbackFailed) {
        await insertReservaEvento(
          reservaId,
          "ttlock_provision_rollback_failed",
          "TTLock: rollback após colisão de passcode falhou",
          {
            action: "lifecycle_provision_rollback_failed",
            credencial_id: credencial.id,
            status_final: "falhou",
            total_itens: (await getAllItensCredencial(credencial.id)).length,
            provisionados: 0,
            falhas: 0,
            revogados: 0,
            erro_resumido: erros.slice(0, 3).join("; "),
          },
        );
        break;
      }
    }

    if (
      !canRetryWithNewPasscode({
        collisionOnAnyLock: true,
        credentialNeverFullyProvisioned: !alreadyRemoteOk,
        collisionAttempt,
        maxAttempts: TTLOCK_PASSCODE_COLLISION_RETRY_MAX,
        rollbackFailed,
      })
    ) {
      break;
    }

    collisionAttempt++;
    rejectedPins.add(passcode);
    localBlocked.add(passcode);
    passcode = allocateNewTtlockPasscode(new Set([...localBlocked, ...rejectedPins]));
    await adminClient
      .from("operacional_credenciais_acesso")
      .update({ codigo_credencial: passcode, provider_tipo: "ttlock_passcode" })
      .eq("id", credencial.id);
    await insertReservaEvento(reservaId, "ttlock_provision_retry", "TTLock: retry com novo PIN após colisão", {
      action: "lifecycle_provision_retry",
      credencial_id: credencial.id,
      status_final: "provisionando",
      total_itens: 0,
      provisionados: 0,
      falhas: 0,
      revogados: 0,
      erro_resumido: `tentativa=${collisionAttempt + 1}`,
    });
    for (const item of await getItensPendentes(credencial.id)) {
      await adminClient
        .from("operacional_credencial_itens")
        .update({
          status_provisionamento: "pendente",
          ultimo_erro: null,
          remote_keyboard_pwd_id: null,
          provisionado_em: null,
        })
        .eq("id", item.id);
    }
    const allAfter = await getAllItensCredencial(credencial.id);
    for (const item of allAfter) {
      if (item.status_provisionamento === "falhou" && item.remote_keyboard_pwd_id == null) {
        await adminClient
          .from("operacional_credencial_itens")
          .update({ status_provisionamento: "pendente", ultimo_erro: null })
          .eq("id", item.id);
      }
    }
    workingItens = await getItensPendentes(credencial.id);
  }

  let finalItens = await getAllItensCredencial(credencial.id);
  let resolved = resolveProvisionCredentialStatus(finalItens);
  let retryable = false;
  const nowIso = NOW();

  if (rollbackFailed) {
    resolved = {
      ...resolved,
      status: resolved.provisionados > 0 ? "parcial" : "falhou",
      allReady: false,
      inProgress: 0,
    };
    await adminClient
      .from("operacional_credenciais_acesso")
      .update({
        status: resolved.status,
        sync_status: "failed",
        last_sync_attempt_at: nowIso,
        last_sync_error: "Rollback após colisão de passcode falhou; intervenção necessária.",
      })
      .eq("id", credencial.id);
  } else if (hadTransientPending) {
    phase2Count += 1;
    if (phase2Count > phase2Max) {
      for (const item of finalItens) {
        if (
          item.status_provisionamento === "provisionando" ||
          item.status_provisionamento === "pendente"
        ) {
          await adminClient
            .from("operacional_credencial_itens")
            .update({
              status_provisionamento: "falhou",
              ultimo_erro: item.ultimo_erro || "Retry transitório TTLock esgotado (fase 2).",
            })
            .eq("id", item.id);
        }
      }
      finalItens = await getAllItensCredencial(credencial.id);
      resolved = resolveProvisionCredentialStatus(finalItens);
      await adminClient
        .from("operacional_credenciais_acesso")
        .update({
          status: resolved.status,
          sync_status: "failed",
          last_sync_attempt_at: nowIso,
          last_sync_error: encodeTransientRetryState({
            phase: 2,
            count: phase2Count,
            errorClass: lastTransientClass,
            nextEligibleAt: null,
          }),
        })
        .eq("id", credencial.id);
    } else {
      retryable = true;
      const nextEligibleAt = new Date(Date.now() + 60_000).toISOString();
      resolved = { ...resolved, status: "provisionando", allReady: false };
      await adminClient
        .from("operacional_credenciais_acesso")
        .update({
          status: "provisionando",
          sync_status: "pending",
          last_sync_attempt_at: nowIso,
          last_sync_error: encodeTransientRetryState({
            phase: 2,
            count: phase2Count,
            errorClass: lastTransientClass,
            nextEligibleAt,
          }),
        })
        .eq("id", credencial.id);
      await insertReservaEvento(
        reservaId,
        "ttlock_provision_retry_transiente",
        "TTLock: aguardando retry transitório (mesmo PIN)",
        {
          action: "lifecycle_provision_retry_transiente",
          credencial_id: credencial.id,
          status_final: "provisionando",
          total_itens: finalItens.length,
          provisionados: resolved.provisionados,
          falhas: 0,
          revogados: 0,
          erro_resumido: `phase=2;count=${phase2Count};class=${lastTransientClass};transient=true`,
        },
      );
    }
  } else {
    await adminClient
      .from("operacional_credenciais_acesso")
      .update({
        status: resolved.status,
        last_sync_attempt_at: nowIso,
        ...(resolved.allReady ? { sync_status: "ok", last_sync_error: null } : {}),
      })
      .eq("id", credencial.id);
  }

  const statusFinal = resolved.status;
  const provisionados = resolved.provisionados;
  const falhas = resolved.falhas;
  const erroResumidoConclusao = erros.length ? erros.slice(0, 3).join("; ") : null;

  if (statusFinal === "provisionada") {
    await insertReservaEvento(reservaId, "ttlock_provision_sucesso", "TTLock: provisionamento concluído", {
      action: "lifecycle_provision_concluido",
      credencial_id: credencial.id,
      status_final: statusFinal,
      total_itens: finalItens.length,
      provisionados,
      falhas,
      revogados: 0,
      erro_resumido: erroResumidoConclusao,
    });
  } else if (statusFinal === "provisionando" || retryable) {
    // Evento de retry transitório já registrado acima quando aplicável.
  } else if (statusFinal === "parcial") {
    await insertReservaEvento(reservaId, "ttlock_provision_parcial", "TTLock: provisionamento parcial", {
      action: "lifecycle_provision_concluido",
      credencial_id: credencial.id,
      status_final: statusFinal,
      total_itens: finalItens.length,
      provisionados,
      falhas,
      revogados: 0,
      erro_resumido: erroResumidoConclusao,
    });
  } else {
    await insertReservaEvento(reservaId, "ttlock_provision_falhou", "TTLock: provisionamento falhou", {
      action: "lifecycle_provision_concluido",
      credencial_id: credencial.id,
      status_final: statusFinal,
      total_itens: finalItens.length,
      provisionados,
      falhas,
      revogados: 0,
      erro_resumido: erroResumidoConclusao,
    });
  }

  if (resolved.allReady) {
    return jsonResponse({
      ok: true,
      message: "Provisionamento concluído.",
      credencialId: credencial.id,
      reservaId,
      status: statusFinal,
      passcode,
      totalItens: finalItens.length,
      provisionados,
      falhas,
      erros,
      retryable: false,
    });
  }

  if (retryable || statusFinal === "provisionando") {
    return jsonResponse(
      {
        ok: false,
        retryable: true,
        error: "Provisionamento em andamento: aguardando confirmação da TTLock (retry automático).",
        message: "Provisionando senha — aguardando confirmação da TTLock.",
        credencialId: credencial.id,
        reservaId,
        status: "provisionando",
        totalItens: finalItens.length,
        provisionados,
        falhas,
        erros,
      },
      202,
    );
  }

  return jsonResponse(
    {
      ok: false,
      retryable: false,
      error:
        statusFinal === "parcial"
          ? "Provisionamento parcial: todos os locks obrigatórios precisam estar provisionados."
          : "Provisionamento falhou em um ou mais locks obrigatórios.",
      message:
        statusFinal === "parcial"
          ? "Provisionamento parcial (alguns itens falharam)."
          : "Provisionamento falhou em todos os itens.",
      credencialId: credencial.id,
      reservaId,
      status: statusFinal,
      totalItens: finalItens.length,
      provisionados,
      falhas,
      erros,
    },
    409,
  );
}

async function handleCancelOrCheckout(
  request: Request,
  payload: Record<string, unknown>,
  motivo: "cancelamento" | "checkout",
): Promise<Response> {
  await ensureCallerAllowed(request);
  const reservaId = requireReservaId(payload);

  const credencial = await getCredencialPorReserva(reservaId);
  if (!credencial) {
    await insertReservaEvento(reservaId, "ttlock_revogacao_sem_credencial", "TTLock: revogação não aplicada (sem credencial)", {
      action: motivo === "checkout" ? "lifecycle_checkout" : "lifecycle_cancel",
      credencial_id: null,
      status_final: null,
      total_itens: 0,
      provisionados: 0,
      falhas: 0,
      revogados: 0,
      erro_resumido: "Reserva sem credencial operacional.",
    });
    return jsonResponse(
      {
        ok: false,
        error: "Reserva sem credencial operacional. Nenhuma credencial de acesso encontrada para esta reserva.",
        reservaId,
      },
      404,
    );
  }
  if (credencial.status === "revogada") {
    await insertReservaEvento(reservaId, "ttlock_revogacao_idempotente", "TTLock: revogação idempotente (já revogada)", {
      action: motivo === "checkout" ? "lifecycle_checkout" : "lifecycle_cancel",
      credencial_id: credencial.id,
      status_final: "revogada",
      total_itens: 0,
      provisionados: 0,
      falhas: 0,
      revogados: 0,
      erro_resumido: null,
    });
    return jsonResponse({
      ok: true,
      idempotente: true,
      message: "Credencial já revogada (idempotente).",
      credencialId: credencial.id,
      reservaId,
      status: "revogada",
      itensRevogados: 0,
      itensFalha: 0,
      syncStatus: credencial.sync_status ?? null,
      lastSyncError: credencial.last_sync_error,
    });
  }

  const result = await revokeCredencial(credencial.id, reservaId, motivo);
  const totalItensRevogacao = result.itensRevogados + result.itensFalha;
  const erroRev = result.lastSyncError ?? (result.erros.length ? result.erros.slice(0, 3).join("; ") : null);
  if (motivo === "checkout") {
    await insertReservaEvento(reservaId, "ttlock_checkout_executado", "TTLock: checkout e revogação executados", {
      action: "lifecycle_checkout",
      credencial_id: result.credencialId,
      status_final: result.status,
      total_itens: totalItensRevogacao,
      provisionados: 0,
      falhas: result.itensFalha,
      revogados: result.itensRevogados,
      erro_resumido: erroRev,
    });
  } else {
    await insertReservaEvento(reservaId, "ttlock_cancelamento_executado", "TTLock: cancelamento e revogação executados", {
      action: "lifecycle_cancel",
      credencial_id: result.credencialId,
      status_final: result.status,
      total_itens: totalItensRevogacao,
      provisionados: 0,
      falhas: result.itensFalha,
      revogados: result.itensRevogados,
      erro_resumido: erroRev,
    });
  }
  return jsonResponse({
    ok: true,
    message: motivo === "cancelamento" ? "Cancelamento executado (acesso revogado)." : "Checkout executado (acesso revogado).",
    ...result,
    divergencia: result.itensFalha > 0 || result.syncStatus === "pending",
  });
}

const gerarNovaSenhaInFlight = new Set<string>();

/**
 * Gera nova senha TTLock: revoga a anterior, provisiona passcode novo e devolve o resultado.
 * Se a revogação remota falhar, marca pendente_limpeza e NÃO cria/envia senha nova.
 */
async function handleGerarNovaSenha(request: Request, payload: Record<string, unknown>): Promise<Response> {
  await ensureCallerAllowed(request);
  const reservaId = requireReservaId(payload).trim().toLowerCase();
  const usuarioId =
    typeof payload.usuario_id === "string" && payload.usuario_id.trim()
      ? payload.usuario_id.trim()
      : null;
  const motivo =
    typeof payload.motivo === "string" && payload.motivo.trim()
      ? payload.motivo.trim()
      : "gerar_nova_senha";

  if (gerarNovaSenhaInFlight.has(reservaId)) {
    return jsonResponse(
      {
        ok: false,
        error: "Geração de nova senha já em andamento para esta reserva.",
        reservaId,
        em_andamento: true,
      },
      409,
    );
  }

  gerarNovaSenhaInFlight.add(reservaId);
  try {
    const credencial = await getCredencialForProvision(reservaId);
    if (!credencial) {
      return jsonResponse(
        { ok: false, error: "Nenhuma credencial de acesso encontrada para esta reserva.", reservaId },
        404,
      );
    }
    if (credencial.status === "revogada") {
      return jsonResponse(
        { ok: false, error: "Não é possível gerar nova senha para credencial revogada.", reservaId },
        400,
      );
    }
    if (credencial.status === "provisionando") {
      return jsonResponse(
        {
          ok: false,
          error: "Provisionamento em andamento; tente novamente em instantes.",
          reservaId,
          em_andamento: true,
        },
        409,
      );
    }

    const passcodeAnterior = credencial.codigo_credencial ?? null;
    const credId = String(credencial.id).trim();
    const now = NOW();
    const erros: string[] = [];
    let revogados = 0;
    let limpezaPendente = 0;

    await adminClient
      .from("operacional_credenciais_acesso")
      .update({ status: "provisionando" })
      .eq("id", credId);

    const { data: itensRaw } = await adminClient
      .from("operacional_credencial_itens")
      .select(
        "id, credencial_id, lock_id_ttlock, status_provisionamento, codigo_logico_destino, remote_keyboard_pwd_id",
      )
      .eq("credencial_id", credId);
    const itens = Array.isArray(itensRaw) ? (itensRaw as ItemRow[]) : [];

    for (const item of itens) {
      const status = item.status_provisionamento;
      const hasRemote = item.remote_keyboard_pwd_id != null;

      if (status === "pendente_limpeza" || (hasRemote && (status === "provisionado" || status === "falhou"))) {
        if (!hasRemote) {
          await adminClient
            .from("operacional_credencial_itens")
            .update({
              status_provisionamento: "pendente",
              remote_keyboard_pwd_id: null,
              codigo_enviado: null,
              ultimo_erro: null,
              provisionado_em: null,
              revogado_em: null,
            })
            .eq("id", item.id);
          continue;
        }
        if (!isTtlockAvailable()) {
          erros.push(`${item.codigo_logico_destino}: TTLock indisponível para revogar senha anterior.`);
          await adminClient
            .from("operacional_credencial_itens")
            .update({
              status_provisionamento: "pendente_limpeza",
              ultimo_erro: "TTLock indisponível ao gerar nova senha.",
            })
            .eq("id", item.id);
          limpezaPendente++;
          continue;
        }
        try {
          await ttlockDeleteKeyboardPassword(item.lock_id_ttlock, item.remote_keyboard_pwd_id!, {
            reserva_id: reservaId,
            credencial_id: credId,
            credencial_item_id: item.id,
            codigo_logico_destino: item.codigo_logico_destino,
          });
          await adminClient
            .from("operacional_credencial_itens")
            .update({
              status_provisionamento: "pendente",
              remote_keyboard_pwd_id: null,
              codigo_enviado: null,
              ultimo_erro: null,
              provisionado_em: null,
              revogado_em: null,
            })
            .eq("id", item.id);
          revogados++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          erros.push(`${item.codigo_logico_destino}: ${msg}`);
          await adminClient
            .from("operacional_credencial_itens")
            .update({
              status_provisionamento: "pendente_limpeza",
              ultimo_erro: msg,
            })
            .eq("id", item.id);
          limpezaPendente++;
        }
        continue;
      }

      if (
        status === "provisionado" ||
        status === "falhou" ||
        status === "revogado" ||
        status === "provisionando"
      ) {
        await adminClient
          .from("operacional_credencial_itens")
          .update({
            status_provisionamento: "pendente",
            remote_keyboard_pwd_id: null,
            codigo_enviado: null,
            ultimo_erro: null,
            provisionado_em: null,
          })
          .eq("id", item.id);
      }
    }

    if (limpezaPendente > 0) {
      await adminClient
        .from("operacional_credenciais_acesso")
        .update({
          status: passcodeAnterior ? "parcial" : "falhou",
          sync_status: "partial",
          last_sync_attempt_at: now,
          last_sync_error: erros.slice(0, 3).join("; ") || "Limpeza remota pendente.",
        })
        .eq("id", credId);

      await insertReservaEvento(
        reservaId,
        "gerar_nova_senha_falha_limpeza",
        "Gerar nova senha bloqueada: limpeza remota pendente",
        {
          action: "lifecycle_gerar_nova_senha",
          credencial_id: credId,
          passcode_anterior_substituido: !!passcodeAnterior,
          limpeza_pendente: limpezaPendente,
          revogados,
          usuario_id: usuarioId,
          motivo,
          erro_resumido: erros.slice(0, 3).join("; "),
        },
      );

      return jsonResponse(
        {
          ok: false,
          error:
            "Não foi possível revogar a senha anterior em todas as fechaduras. Pendência de limpeza registrada; nova senha não foi gerada.",
          reservaId,
          credencialId: credId,
          passcodeAnterior,
          limpezaPendente,
          revogados,
          erros,
          bloqueadoPorLimpeza: true,
        },
        409,
      );
    }

    const novoPasscode = generateRandomTtlockPasscode(passcodeAnterior);
    const upNew = await adminClient
      .from("operacional_credenciais_acesso")
      .update({
        codigo_credencial: novoPasscode,
        provider_tipo: "ttlock_passcode",
        status: "pendente",
        revogado_em: null,
        motivo_revogacao: null,
        sync_status: "pending",
        last_sync_attempt_at: now,
        last_sync_error: null,
      })
      .eq("id", credId);
    if (upNew.error) {
      throw new HttpError(
        "Falha ao persistir nova senha na credencial: " + upNew.error.message,
        500,
      );
    }

    await insertReservaEvento(
      reservaId,
      "gerar_nova_senha_iniciado",
      "Geração de nova senha TTLock iniciada",
      {
        action: "lifecycle_gerar_nova_senha",
        credencial_id: credId,
        passcode_anterior_substituido: !!passcodeAnterior,
        revogados,
        usuario_id: usuarioId,
        motivo,
        em: now,
      },
    );

    const provisionRes = await handleLifecycleProvision(request, { reservaId });
    const provisionBody = (await provisionRes.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const provisionOk = provisionRes.ok && provisionBody.ok !== false;
    const falhas = Number(provisionBody.falhas ?? 0);
    const provisionados = Number(provisionBody.provisionados ?? 0);
    const passcodeFinal =
      typeof provisionBody.passcode === "string" && provisionBody.passcode
        ? provisionBody.passcode
        : novoPasscode;

    if (!provisionOk || falhas > 0 || provisionados <= 0) {
      await insertReservaEvento(
        reservaId,
        "gerar_nova_senha_falha",
        "Falha ao provisionar nova senha TTLock",
        {
          action: "lifecycle_gerar_nova_senha",
          credencial_id: credId,
          passcode_anterior_substituido: !!passcodeAnterior,
          revogados,
          provisionados,
          falhas,
          usuario_id: usuarioId,
          motivo,
          erro_resumido:
            (typeof provisionBody.error === "string" && provisionBody.error) ||
            (Array.isArray(provisionBody.erros) ? provisionBody.erros.slice(0, 3).join("; ") : null),
        },
      );
      return jsonResponse(
        {
          ok: false,
          error:
            (typeof provisionBody.error === "string" && provisionBody.error) ||
            "Falha ao provisionar a nova senha nas fechaduras. Nenhuma mensagem foi enviada.",
          reservaId,
          credencialId: credId,
          passcodeAnterior,
          passcode: null,
          revogados,
          provisionados,
          falhas,
          erros: provisionBody.erros ?? erros,
        },
        400,
      );
    }

    await insertReservaEvento(
      reservaId,
      "gerar_nova_senha_sucesso",
      "Nova senha TTLock provisionada",
      {
        action: "lifecycle_gerar_nova_senha",
        credencial_id: credId,
        passcode_anterior_substituido: !!passcodeAnterior,
        revogados,
        provisionados,
        usuario_id: usuarioId,
        motivo,
        em: new Date().toISOString(),
      },
    );

    return jsonResponse({
      ok: true,
      message: "Nova senha gerada e provisionada.",
      reservaId,
      credencialId: credId,
      passcode: passcodeFinal,
      passcodeAnterior,
      revogados,
      provisionados,
      falhas: 0,
      limpezaPendente: 0,
      status: provisionBody.status ?? "provisionada",
    });
  } finally {
    gerarNovaSenhaInFlight.delete(reservaId);
  }
}

/** Lista credenciais com itens pendentes de limpeza remota (revogado + ultimo_erro). Base para job/cron até 2h pós-checkout. */
async function listPendingCleanup(request: Request): Promise<Response> {
  await ensureCallerAllowed(request);
  const { data: credenciais } = await adminClient
    .from("operacional_credenciais_acesso")
    .select("id, reserva_id")
    .eq("status", "revogada");
  if (!Array.isArray(credenciais) || credenciais.length === 0) {
    return jsonResponse({ credenciais: [] });
  }
  const out: { credencial_id: string; reserva_id: string; itens_pendentes_limpeza: number }[] = [];
  for (const c of credenciais as { id: string; reserva_id: string }[]) {
    const itens = await getItensPendentesLimpeza(c.id);
    if (itens.length > 0) {
      out.push({ credencial_id: c.id, reserva_id: c.reserva_id, itens_pendentes_limpeza: itens.length });
    }
  }
  return jsonResponse({ credenciais: out });
}

async function getSyncSummary(request: Request, reservaId: string): Promise<Response> {
  await ensureCallerAllowed(request);
  const credencial = await getCredencialPorReserva(reservaId);
  if (!credencial) {
    return jsonResponse({
      reservaId,
      temCredencial: false,
      credencialId: null,
      status: null,
      syncStatus: null,
      lastSyncAttemptAt: null,
      lastSyncError: null,
      resumo: "Sem credencial operacional",
    });
  }
  const { data: itens } = await adminClient
    .from("operacional_credencial_itens")
    .select("status_provisionamento, ultimo_erro")
    .eq("credencial_id", credencial.id);
  const provisionados = (itens ?? []).filter((i: { status_provisionamento: string }) => i.status_provisionamento === "provisionado").length;
  const pendentesLimpeza = (itens ?? []).filter((i: { status_provisionamento: string }) => i.status_provisionamento === "pendente_limpeza").length;
  const comErro = (itens ?? []).filter((i: { ultimo_erro: unknown }) => i.ultimo_erro != null).length;
  let resumo = credencial.status;
  if (credencial.sync_status) resumo += ` | sync: ${credencial.sync_status}`;
  if (comErro > 0) resumo += ` | ${comErro} item(ns) com erro`;
  if (pendentesLimpeza > 0) resumo += ` | ${pendentesLimpeza} pendente(s) limpeza`;
  if (provisionados > 0 && credencial.status !== "revogada") resumo += ` | ${provisionados} provisionado(s)`;

  return jsonResponse({
    reservaId,
    temCredencial: true,
    credencialId: credencial.id,
    status: credencial.status,
    syncStatus: credencial.sync_status ?? null,
    lastSyncAttemptAt: credencial.last_sync_attempt_at ?? null,
    lastSyncError: credencial.last_sync_error ?? null,
    resumo,
  });
}

async function retrySync(request: Request, payload: Record<string, unknown>): Promise<Response> {
  await ensureCallerAllowed(request);
  const reservaId = pickReservaId(payload);
  const credencialId =
    String(payload.credencialId ?? payload.credencial_id ?? "").trim() ||
    undefined;
  if (!credencialId && !reservaId) {
    return jsonResponse({
      ok: false,
      error: "Informe credencialId (ou credencial_id) ou reservaId (ou reserva_id / reservationId / id).",
    }, 400);
  }

  let cid = credencialId;
  let rid = reservaId;
  if (!cid && rid) {
    const credencial = await getCredencialPorReserva(rid);
    if (!credencial) {
      return jsonResponse({ ok: false, error: "Reserva sem credencial.", reservaId: rid }, 404);
    }
    cid = credencial.id;
    rid = credencial.reserva_id;
  } else if (cid && !rid) {
    const { data: cred } = await adminClient
      .from("operacional_credenciais_acesso")
      .select("reserva_id")
      .eq("id", cid)
      .single();
    rid = (cred as { reserva_id?: string } | null)?.reserva_id ?? "";
  }

  const credencial = await adminClient
    .from("operacional_credenciais_acesso")
    .select("id, status, reserva_id")
    .eq("id", cid!)
    .single()
    .then((r) => r.data as { id: string; status: string; reserva_id: string } | null);
  if (!credencial) {
    return jsonResponse({ ok: false, error: "Credencial não encontrada.", credencialId: cid }, 404);
  }

  const reservaIdRetry = (rid && rid.trim()) ? rid.trim() : String(credencial.reserva_id ?? "").trim();
  if (!reservaIdRetry) {
    return jsonResponse({ ok: false, error: "Não foi possível resolver reserva_id para retry.", credencialId: cid }, 400);
  }

  if (credencial.status === "revogada") {
    const result = await revokeCredencial(credencial.id, reservaIdRetry, "cancelamento");
    const totalItensRetry = result.itensRevogados + result.itensFalha;
    const erroRetry = result.lastSyncError ?? (result.erros.length ? result.erros.slice(0, 3).join("; ") : null);
    await insertReservaEvento(reservaIdRetry, "ttlock_retry_sync_executado", "TTLock: reprocessar sincronização (revogação remota)", {
      action: "retry_sync",
      credencial_id: result.credencialId,
      status_final: result.status,
      total_itens: totalItensRetry,
      provisionados: 0,
      falhas: result.itensFalha,
      revogados: result.itensRevogados,
      erro_resumido: erroRetry,
    });
    return jsonResponse({
      ok: true,
      message: "Retry executado (revogação remota nos itens ainda provisionados).",
      ...result,
    });
  }

  // Credencial ativa: não revogar passcodes aqui; use script para alteração de validade.
  return jsonResponse(
    { ok: false, error: "Retry pela Edge Function só para credencial revogada. Para credencial ativa use: npm run debug:ttlock-retry-pending -- <credencial_id>" },
    400,
  );
}

/**
 * Ajusta somente valido_de/valido_ate da credencial e dos passcodes remotos existentes.
 * Não lê, não altera e não retorna senha.
 */
async function handleLifecycleUpdateValidity(
  request: Request,
  payload: Record<string, unknown>,
): Promise<Response> {
  await ensureCallerAllowed(request);

  if (!isTtlockAvailable()) {
    return jsonResponse(
      { ok: false, error: "TTLock não configurado (variáveis de ambiente).", database_updated: false },
      503,
    );
  }

  const result = await executeLifecycleUpdateValidity(payload, {
    async getCredencial(credencialId) {
      const row = await getCredencialPrincipalPorId(credencialId);
      if (!row) return null;
      return {
        id: row.id,
        reserva_id: row.reserva_id,
        status: row.status,
        valido_de: row.valido_de,
        valido_ate: row.valido_ate,
      };
    },
    async getItens(credencialId) {
      const { data, error } = await adminClient
        .from("operacional_credencial_itens")
        .select(
          "id, codigo_logico_destino, lock_id_ttlock, remote_keyboard_pwd_id, status_provisionamento",
        )
        .eq("credencial_id", credencialId);
      if (error) {
        throw new HttpError("Falha ao listar itens da credencial: " + error.message, 500);
      }
      return (Array.isArray(data) ? data : []) as Array<{
        id: string;
        codigo_logico_destino: string;
        lock_id_ttlock: string | number | null;
        remote_keyboard_pwd_id: number | null;
        status_provisionamento: string;
      }>;
    },
    async getReserva(reservaId) {
      const { data } = await adminClient
        .from("operacional_reservas")
        .select("check_in_previsto, check_out_previsto")
        .eq("id", reservaId)
        .maybeSingle();
      if (!data) return null;
      return data as { check_in_previsto: string; check_out_previsto: string };
    },
    async changeItemValidity({ item, startDateMs, endDateMs }) {
      await ttlockChangeKeyboardPasswordValidity(
        item.lock_id_ttlock!,
        item.remote_keyboard_pwd_id!,
        startDateMs,
        endDateMs,
        {
          credencial_id: String(payload.credencial_id ?? payload.credencialId ?? "").trim() || undefined,
          credencial_item_id: item.id,
          codigo_logico_destino: item.codigo_logico_destino,
        },
      );
    },
    async updateCredencialValidity({ credencialId, valido_de, valido_ate }) {
      const { error } = await adminClient
        .from("operacional_credenciais_acesso")
        .update({
          valido_de,
          valido_ate,
          last_sync_attempt_at: new Date().toISOString(),
          last_sync_error: null,
          sync_status: "ok",
        })
        .eq("id", credencialId);
      if (error) {
        // Colunas sync_* podem não existir; tenta update mínimo.
        const { error: err2 } = await adminClient
          .from("operacional_credenciais_acesso")
          .update({ valido_de, valido_ate })
          .eq("id", credencialId);
        if (err2) {
          throw new HttpError(
            "Validade remota OK, mas falha ao gravar no banco: " + err2.message,
            500,
          );
        }
      }
    },
  });

  if (result.ok) {
    const credencialId = result.credencial_id;
    const { data: credRow } = await adminClient
      .from("operacional_credenciais_acesso")
      .select("reserva_id")
      .eq("id", credencialId)
      .maybeSingle();
    const reservaId = (credRow as { reserva_id?: string } | null)?.reserva_id;
    if (reservaId) {
      await insertReservaEvento(
        reservaId,
        result.idempotent ? "ttlock_validity_idempotent" : "ttlock_validity_updated",
        result.idempotent
          ? "TTLock: validade já estava correta (idempotente)"
          : "TTLock: validade da credencial atualizada",
        {
          action: "lifecycle_update_validity",
          credencial_id: credencialId,
          valido_de: result.valido_de,
          valido_ate: result.valido_ate,
          itens_atualizados: result.itens_atualizados,
          database_updated: result.database_updated,
          idempotent: !!result.idempotent,
        },
      );
    }
    return jsonResponse({
      ok: true,
      message: result.idempotent
        ? "Validade já estava aplicada; nenhuma alteração."
        : "Validade atualizada nos itens remotos e no banco.",
      credencial_id: result.credencial_id,
      valido_de: result.valido_de,
      valido_ate: result.valido_ate,
      itens_atualizados: result.itens_atualizados,
      itens: result.itens,
      database_updated: result.database_updated,
      idempotent: !!result.idempotent,
    });
  }

  return jsonResponse(
    {
      ok: false,
      error: result.error,
      credencial_id: result.credencial_id,
      itens_alterados: result.itens_alterados,
      itens_falha: result.itens_falha,
      database_updated: false,
    },
    result.status,
  );
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestBody = (await request.json()) as Record<string, unknown>;
    const action = String(requestBody.action ?? "").trim();
    const payload = resolvePayloadRecord(requestBody);
    if (typeof console !== "undefined") console.log("[lifecycle] action=" + action);

    if (action === "lifecycle_cancel") {
      return await handleCancelOrCheckout(request, payload, "cancelamento");
    }
    if (action === "lifecycle_checkout") {
      return await handleCancelOrCheckout(request, payload, "checkout");
    }
    if (action === "sync_summary") {
      const reservaId = requireReservaId(payload);
      return await getSyncSummary(request, reservaId);
    }
    if (action === "retry_sync") {
      return await retrySync(request, payload);
    }
    if (action === "lifecycle_provision") {
      return await handleLifecycleProvision(request, payload);
    }
    if (action === "lifecycle_gerar_nova_senha") {
      return await handleGerarNovaSenha(request, payload);
    }
    if (action === "lifecycle_update_validity") {
      return await handleLifecycleUpdateValidity(request, payload);
    }
    if (action === "list_pending_cleanup") {
      return await listPendingCleanup(request);
    }

    return jsonResponse(
      {
        error:
          "Ação não suportada. Use: lifecycle_cancel, lifecycle_checkout, lifecycle_provision, lifecycle_gerar_nova_senha, lifecycle_update_validity, sync_summary, retry_sync, list_pending_cleanup.",
      },
      400,
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ error: error.message }, error.status);
    }
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Erro inesperado na edge function." },
      500,
    );
  }
});
