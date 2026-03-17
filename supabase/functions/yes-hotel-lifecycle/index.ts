/**
 * Yes Hotel — Lifecycle TTLock (Fase 3.2).
 * Ações: lifecycle_provision, cancelamento, checkout, sync_summary, retry_sync.
 * Autenticação: usuário interno (admin ou recepção) via Supabase Auth.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import md5 from "npm:md5";

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
const ttlockTokenUrl = Deno.env.get("TTLOCK_TOKEN_URL") || "https://euapi.ttlock.com/oauth2/token";
const ttlockApiBase = (Deno.env.get("TTLOCK_API_BASE_URL") || "https://euapi.ttlock.com").replace(/\/+$/, "");

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

const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getCallerProfile(request: Request): Promise<{ role: string; active: boolean } | null> {
  const authHeader = request.headers.get("Authorization") ?? "";
  const hasBearer = /^\s*Bearer\s+/i.test(authHeader);
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (typeof console !== "undefined") {
    console.log("[lifecycle] getCallerProfile authHeaderPresent=" + (authHeader.length > 0) + " hasBearer=" + hasBearer + " tokenLen=" + token.length);
  }
  if (!token) return null;
  let authUserId: string | null = null;
  try {
    const claimsResult = await anonClient.auth.getClaims(token);
    if (claimsResult.error) {
      if (typeof console !== "undefined") console.warn("[lifecycle] getClaims error", claimsResult.error.message);
      throw claimsResult.error;
    }
    if (claimsResult.data?.claims?.sub) authUserId = claimsResult.data.claims.sub as string;
  } catch (claimsErr) {
    if (typeof console !== "undefined") console.warn("[lifecycle] getClaims threw", claimsErr instanceof Error ? claimsErr.message : String(claimsErr));
    const userResult = await anonClient.auth.getUser(token);
    if (userResult.error || !userResult.data?.user?.id) {
      if (typeof console !== "undefined") console.warn("[lifecycle] getUser fallback error", userResult.error?.message ?? "no user");
      return null;
    }
    authUserId = userResult.data.user.id;
  }
  if (!authUserId) return null;
  const { data: row, error: rowError } = await adminClient
    .from("usuarios_internos")
    .select("perfil_usuario, ativo")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (rowError || !row) return null;
  return { role: row.perfil_usuario, active: !!row.ativo };
}

async function ensureCallerAllowed(request: Request): Promise<void> {
  const profile = await getCallerProfile(request);
  if (!profile || !profile.active || (profile.role !== "admin" && profile.role !== "recepcao")) {
    throw new Error("Apenas admin ou recepção ativos podem executar esta ação.");
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

async function ttlockDeleteKeyboardPassword(lockId: string | number, keyboardPwdId: number): Promise<void> {
  const token = await getTtlockToken();
  const lockIdNum = typeof lockId === "string" ? parseInt(lockId, 10) : lockId;
  const body = {
    clientId: ttlockClientId,
    accessToken: token,
    lockId: lockIdNum,
    keyboardPwdId,
    deleteType: 2,
    date: Date.now(),
  };
  const res = await fetch(`${ttlockApiBase}/v3/keyboardPwd/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { errcode?: number; errmsg?: string };
  if (!res.ok || (data.errcode != null && data.errcode !== 0)) {
    throw new Error(data.errmsg ?? `Delete passcode: ${res.status}`);
  }
}

/** Cria passcode temporário na fechadura (addType=2, via gateway). Retorna keyboardPwdId. */
async function ttlockAddKeyboardPassword(
  lockId: string | number,
  keyboardPwd: string,
  startDateMs: number,
  endDateMs: number,
  keyboardPwdName?: string,
): Promise<number> {
  const token = await getTtlockToken();
  const lockIdNum = typeof lockId === "string" ? parseInt(lockId, 10) : lockId;
  const body: Record<string, string | number> = {
    clientId: ttlockClientId,
    accessToken: token,
    lockId: lockIdNum,
    keyboardPwd,
    startDate: startDateMs,
    endDate: endDateMs,
    addType: 2,
    date: Date.now(),
  };
  if (keyboardPwdName != null) body.keyboardPwdName = keyboardPwdName;
  const res = await fetch(`${ttlockApiBase}/v3/keyboardPwd/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { keyboardPwdId?: number; errcode?: number; errmsg?: string };
  if (typeof console !== "undefined") {
    console.log("[lifecycle] TTLock add passcode res.status=" + res.status + " errcode=" + (data.errcode ?? "n/a") + " errmsg=" + (data.errmsg ?? "n/a") + " keyboardPwdId=" + (data.keyboardPwdId ?? "n/a"));
  }
  if (!res.ok || (data.errcode != null && data.errcode !== 0)) {
    if (typeof console !== "undefined") console.warn("[lifecycle] TTLock add passcode FAIL body=" + JSON.stringify(data));
    throw new Error(data.errmsg ?? `Add passcode: ${res.status}`);
  }
  if (typeof data.keyboardPwdId !== "number") {
    if (typeof console !== "undefined") console.warn("[lifecycle] TTLock add passcode no keyboardPwdId body=" + JSON.stringify(data));
    throw new Error("TTLock add passcode: resposta sem keyboardPwdId");
  }
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

async function getCredencialForProvision(reservaId: string): Promise<CredencialForProvision | null> {
  const normalizedId = String(reservaId ?? "").trim().toLowerCase();
  if (!normalizedId) return null;
  if (typeof console !== "undefined") console.log("[lifecycle] getCredencialForProvision reservaId=" + normalizedId);
  const { data, error } = await adminClient
    .from("operacional_credenciais_acesso")
    .select("id, reserva_id, status, valido_de, valido_ate")
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
    .select("id, credencial_id, lock_id_ttlock, status_provisionamento, codigo_logico_destino")
    .eq("credencial_id", credencialId)
    .eq("status_provisionamento", "provisionado");
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
  const erros: string[] = [];
  let revogados = 0;
  let falhas = 0;
  const now = NOW();

  for (const item of itens) {
    if (item.remote_keyboard_pwd_id == null) {
      await adminClient
        .from("operacional_credencial_itens")
        .update({ status_provisionamento: "revogado", revogado_em: now })
        .eq("id", item.id);
      revogados++;
      continue;
    }
    if (isTtlockAvailable()) {
      try {
        await ttlockDeleteKeyboardPassword(item.lock_id_ttlock, item.remote_keyboard_pwd_id);
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
    } else {
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

const PASSCODE_LENGTH = 6;
const PASSCODE_MIN = 10 ** (PASSCODE_LENGTH - 1);
const PASSCODE_MAX = 10 ** PASSCODE_LENGTH - 1;

function generateTemporaryPasscode(): string {
  const n = Math.floor(PASSCODE_MIN + Math.random() * (PASSCODE_MAX - PASSCODE_MIN + 1));
  return String(n).padStart(PASSCODE_LENGTH, "0");
}

async function handleLifecycleProvision(request: Request, payload: Record<string, unknown>): Promise<Response> {
  await ensureCallerAllowed(request);
  const reservaId = ensureText(payload.reservaId, "reservaId");

  const credencial = await getCredencialForProvision(reservaId);
  if (!credencial) {
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

  let passcode = credencial.codigo_credencial ?? null;
  if (!passcode) {
    passcode = generateTemporaryPasscode();
  }

  await adminClient
    .from("operacional_credenciais_acesso")
    .update({ status: "provisionando" })
    .eq("id", credencial.id);

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
    return jsonResponse({
      ok: true,
      message: "Provisionamento tentado; TTLock indisponível.",
      credencialId: credencial.id,
      reservaId,
      status: falhas === itens.length ? "falhou" : "parcial",
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
        `Yes-${item.codigo_logico_destino}`,
      );
      await adminClient
        .from("operacional_credencial_itens")
        .update({
          status_provisionamento: "provisionado",
          provisionado_em: now,
          ultimo_erro: null,
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
  return jsonResponse({
    ok: true,
    message: motivo === "cancelamento" ? "Cancelamento executado (acesso revogado)." : "Checkout executado (acesso revogado).",
    ...result,
    divergencia: result.itensFalha > 0 || result.syncStatus === "pending",
  });
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
  const comErro = (itens ?? []).filter((i: { ultimo_erro: unknown }) => i.ultimo_erro != null).length;
  let resumo = credencial.status;
  if (credencial.sync_status) resumo += ` | sync: ${credencial.sync_status}`;
  if (comErro > 0) resumo += ` | ${comErro} item(ns) com erro`;
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
    .select("id, status")
    .eq("id", cid!)
    .single()
    .then((r) => r.data as { id: string; status: string } | null);
  if (!credencial) {
    return jsonResponse({ ok: false, error: "Credencial não encontrada.", credencialId: cid }, 404);
  }

  if (credencial.status === "revogada") {
    const result = await revokeCredencial(credencial.id, rid!, "cancelamento");
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

    return jsonResponse(
      { error: "Ação não suportada. Use: lifecycle_cancel, lifecycle_checkout, lifecycle_provision, sync_summary, retry_sync." },
      400,
    );
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Erro inesperado na edge function." },
      500,
    );
  }
});
