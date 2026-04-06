/**
 * Yes Hotel — Lifecycle TTLock (Fase 3.2).
 * Ações: lifecycle_provision, cancelamento, checkout, sync_summary, retry_sync.
 * Autenticação: usuário interno (admin ou recepção) via Supabase Auth.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import md5 from "npm:md5";
import {
  deriveTtlockPasscodeFromReservation,
  formatTtlockKeyboardPwdName,
} from "../_shared/ttlock-credential-format.ts";

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
  const res = await fetch(`${ttlockApiBase}/v3/keyboardPwd/add`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
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

type CredencialRow = {
  id: string;
  reserva_id: string;
  status: string;
  sync_status?: string | null;
  last_sync_attempt_at?: string | null;
  last_sync_error?: string | null;
};

/** Credencial com campos necessários para provisionamento TTLock (apenas colunas do schema base 0006). */
type CredencialForProvision = {
  id: string;
  reserva_id: string;
  status: string;
  valido_de: string;
  valido_ate: string;
  codigo_credencial?: string | null;
  provider_tipo?: string | null;
};

type ItemRow = {
  id: string;
  credencial_id: string;
  lock_id_ttlock: string;
  status_provisionamento: string;
  remote_keyboard_pwd_id: number | null;
  codigo_logico_destino: string;
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

async function getCredencialForProvision(reservaId: string): Promise<CredencialForProvision | null> {
  const normalizedId = String(reservaId ?? "").trim().toLowerCase();
  if (!normalizedId) return null;
  if (typeof console !== "undefined") console.log("[lifecycle] getCredencialForProvision reservaId=" + normalizedId);
  const { data, error } = await adminClient
    .from("operacional_credenciais_acesso")
    .select("id, reserva_id, status, valido_de, valido_ate, codigo_credencial, provider_tipo")
    .eq("reserva_id", normalizedId)
    .eq("tipo_credencial", "principal")
    .limit(1)
    .maybeSingle();
  if (error) {
    if (typeof console !== "undefined") console.warn("[lifecycle] getCredencialForProvision error", error.message);
    return null;
  }
  if (!data) return null;
  return data as CredencialForProvision;
}

async function getItensPendentes(credencialId: string): Promise<ItemRow[]> {
  const { data, error } = await adminClient
    .from("operacional_credencial_itens")
    .select("id, credencial_id, lock_id_ttlock, status_provisionamento, codigo_logico_destino")
    .eq("credencial_id", credencialId)
    .eq("status_provisionamento", "pendente");
  if (error || !Array.isArray(data)) return [];
  return data as ItemRow[];
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
  const reservaId = ensureText(payload.reservaId, "reservaId");

  const credencial = await getCredencialForProvision(reservaId);
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

  const itens = await getItensPendentes(credencial.id);

  if (itens.length === 0) {
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

  let passcode = credencial.codigo_credencial ?? null;
  if (!passcode) {
    passcode = deriveTtlockPasscodeFromReservation(ttlockCtx.external_reservation_id, reservaId);
  }

  const credencialPatch: Record<string, unknown> = { status: "provisionando" };
  if (!credencial.codigo_credencial) {
    credencialPatch.codigo_credencial = passcode;
    credencialPatch.provider_tipo = "ttlock_passcode";
  }

  await adminClient
    .from("operacional_credenciais_acesso")
    .update(credencialPatch)
    .eq("id", credencial.id);

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

  const validoDeMs = new Date(credencial.valido_de).getTime();
  const validoAteMs = new Date(credencial.valido_ate).getTime();
  const erros: string[] = [];
  let provisionados = 0;
  let falhas = 0;
  const now = NOW();

  if (!isTtlockAvailable()) {
    if (typeof console !== "undefined") console.warn("[lifecycle] TTLock indisponível: env CLIENT_ID=" + (!!ttlockClientId) + " SECRET=" + (!!ttlockClientSecret) + " USER=" + (!!ttlockUsername) + " PWD=" + (!!ttlockPassword));
    const msg = "TTLock não configurado (variáveis de ambiente).";
    erros.push(msg);
    for (const item of itens) {
      await adminClient
        .from("operacional_credencial_itens")
        .update({ status_provisionamento: "falhou", ultimo_erro: msg })
        .eq("id", item.id);
      falhas++;
    }
    await adminClient
      .from("operacional_credenciais_acesso")
      .update({ status: falhas === itens.length ? "falhou" : "parcial" })
      .eq("id", credencial.id);
    const st = falhas === itens.length ? "falhou" : "parcial";
    await insertReservaEvento(reservaId, "ttlock_provision_ttlock_indisponivel", "TTLock: provisionamento sem API (variáveis ausentes)", {
      action: "lifecycle_provision_concluido",
      credencial_id: credencial.id,
      status_final: st,
      total_itens: itens.length,
      provisionados: 0,
      falhas: itens.length,
      revogados: 0,
      erro_resumido: msg,
    });
    return jsonResponse({
      ok: true,
      message: "Provisionamento tentado; TTLock indisponível.",
      credencialId: credencial.id,
      reservaId,
      status: st,
      passcode,
      totalItens: itens.length,
      provisionados: 0,
      falhas: itens.length,
      erros,
    });
  }

  for (const item of itens) {
    await adminClient
      .from("operacional_credencial_itens")
      .update({ status_provisionamento: "provisionando" })
      .eq("id", item.id);

    try {
      const keyboardPwdId = await ttlockAddKeyboardPassword(
        item.lock_id_ttlock,
        passcode!,
        validoDeMs,
        validoAteMs,
        keyboardPwdBaseName,
        { reserva_id: reservaId, credencial_id: credencial.id, credencial_item_id: item.id, codigo_logico_destino: item.codigo_logico_destino },
      );
      await adminClient
        .from("operacional_credencial_itens")
        .update({
          status_provisionamento: "provisionado",
          provisionado_em: now,
          ultimo_erro: null,
          remote_keyboard_pwd_id: keyboardPwdId,
        })
        .eq("id", item.id);
      provisionados++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (typeof console !== "undefined") console.warn("[lifecycle] TTLock provision item FAIL", item.codigo_logico_destino, "error=" + msg, e instanceof Error ? e.stack : String(e));
      erros.push(`${item.codigo_logico_destino}: ${msg}`);
      await adminClient
        .from("operacional_credencial_itens")
        .update({ status_provisionamento: "falhou", ultimo_erro: msg })
        .eq("id", item.id);
      falhas++;
    }
  }

  let statusFinal: "provisionada" | "parcial" | "falhou" = "provisionada";
  if (falhas > 0 && provisionados > 0) statusFinal = "parcial";
  else if (falhas === itens.length) statusFinal = "falhou";

  await adminClient
    .from("operacional_credenciais_acesso")
    .update({ status: statusFinal })
    .eq("id", credencial.id);

  const erroResumidoConclusao = erros.length ? erros.slice(0, 3).join("; ") : null;
  if (statusFinal === "provisionada") {
    await insertReservaEvento(reservaId, "ttlock_provision_sucesso", "TTLock: provisionamento concluído", {
      action: "lifecycle_provision_concluido",
      credencial_id: credencial.id,
      status_final: statusFinal,
      total_itens: itens.length,
      provisionados,
      falhas,
      revogados: 0,
      erro_resumido: erroResumidoConclusao,
    });
  } else if (statusFinal === "parcial") {
    await insertReservaEvento(reservaId, "ttlock_provision_parcial", "TTLock: provisionamento parcial", {
      action: "lifecycle_provision_concluido",
      credencial_id: credencial.id,
      status_final: statusFinal,
      total_itens: itens.length,
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
      total_itens: itens.length,
      provisionados,
      falhas,
      revogados: 0,
      erro_resumido: erroResumidoConclusao,
    });
  }

  return jsonResponse({
    ok: true,
    message:
      statusFinal === "provisionada"
        ? "Provisionamento concluído."
        : statusFinal === "parcial"
          ? "Provisionamento parcial (alguns itens falharam)."
          : "Provisionamento falhou em todos os itens.",
    credencialId: credencial.id,
    reservaId,
    status: statusFinal,
    passcode: passcode!,
    totalItens: itens.length,
    provisionados,
    falhas,
    erros,
  });
}

async function handleCancelOrCheckout(
  request: Request,
  payload: Record<string, unknown>,
  motivo: "cancelamento" | "checkout",
): Promise<Response> {
  await ensureCallerAllowed(request);
  const reservaId = ensureText(payload.reservaId, "reservaId");

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
  const reservaId = (payload.reservaId as string)?.trim();
  const credencialId = (payload.credencialId as string)?.trim();
  if (!credencialId && !reservaId) {
    return jsonResponse({ ok: false, error: "Informe credencialId ou reservaId." }, 400);
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

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const requestBody = (await request.json()) as { action?: string; payload?: Record<string, unknown> };
    const action = (requestBody.action ?? "").trim();
    const payload = requestBody.payload ?? {};
    if (typeof console !== "undefined") console.log("[lifecycle] action=" + action);

    if (action === "lifecycle_cancel") {
      return await handleCancelOrCheckout(request, payload, "cancelamento");
    }
    if (action === "lifecycle_checkout") {
      return await handleCancelOrCheckout(request, payload, "checkout");
    }
    if (action === "sync_summary") {
      const reservaId = ensureText(payload.reservaId, "reservaId");
      return await getSyncSummary(request, reservaId);
    }
    if (action === "retry_sync") {
      return await retrySync(request, payload);
    }
    if (action === "lifecycle_provision") {
      return await handleLifecycleProvision(request, payload);
    }
    if (action === "list_pending_cleanup") {
      return await listPendingCleanup(request);
    }

    return jsonResponse(
      { error: "Ação não suportada. Use: lifecycle_cancel, lifecycle_checkout, lifecycle_provision, sync_summary, retry_sync, list_pending_cleanup." },
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
