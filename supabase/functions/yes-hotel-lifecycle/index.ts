/**
 * Yes Hotel — Lifecycle TTLock (Fase 3.2).
 * Ações: cancelamento, checkout, sync_summary, retry_sync.
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
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data, error } = await anonClient.auth.getClaims(token);
  if (error || !data?.claims?.sub) return null;
  const authUserId = data.claims.sub as string;
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
  return !!(ttlockClientId && ttlockClientSecret && ttlockUsername && ttlockPassword);
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getTtlockToken(): Promise<string> {
  if (!isTtlockAvailable()) throw new Error("TTLock não configurado (variáveis de ambiente).");
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  const passwordMd5 = String((md5 as (s: string) => string)(ttlockPassword)).toLowerCase();
  const body = new URLSearchParams({
    client_id: ttlockClientId,
    client_secret: ttlockClientSecret,
    username: ttlockUsername,
    password: passwordMd5,
    grant_type: "password",
  });
  const res = await fetch(ttlockTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
  if (!res.ok || data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(data.errmsg ?? `TTLock token: ${res.status}`);
  }
  const token = data.access_token;
  if (!token) throw new Error("TTLock: resposta sem access_token");
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

type CredencialRow = {
  id: string;
  reserva_id: string;
  status: string;
  sync_status: string | null;
  last_sync_attempt_at: string | null;
  last_sync_error: string | null;
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
  const { data, error } = await adminClient
    .from("operacional_credenciais_acesso")
    .select("id, reserva_id, status, sync_status, last_sync_attempt_at, last_sync_error")
    .eq("reserva_id", reservaId)
    .maybeSingle();
  if (error || !data) return null;
  return data as CredencialRow;
}

async function getItensProvisionados(credencialId: string): Promise<ItemRow[]> {
  const { data, error } = await adminClient
    .from("operacional_credencial_itens")
    .select("id, credencial_id, lock_id_ttlock, status_provisionamento, remote_keyboard_pwd_id, codigo_logico_destino")
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

    return jsonResponse({ error: "Ação não suportada. Use: lifecycle_cancel, lifecycle_checkout, sync_summary, retry_sync." }, 400);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Erro inesperado na edge function." },
      500,
    );
  }
});
