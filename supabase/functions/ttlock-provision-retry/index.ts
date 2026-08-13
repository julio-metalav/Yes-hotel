/**
 * Worker fase 2: retoma provisionamento TTLock e send-senha sem operador.
 *
 * Auth: service_role Bearer OU x-access-tolerance-token (mesmo cron outbox/poller).
 * NÃO gera PIN novo. NÃO marca sucesso na mão. Reentra lifecycle_provision
 * idempotente e send-senha (gate 3/3).
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { constantTimeEqual } from "../../../src/lib/integrations/ttlock/access-ingest/constant-time.ts";
import { classifyTtlockPhase2Candidate } from "../../../src/lib/domain/yes-hotel/ttlock-provision-phase2.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-access-tolerance-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
const processorToken = (Deno.env.get("ACCESS_TOLERANCE_PROCESSOR_TOKEN") ?? "").trim();

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function authorize(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ") && serviceRoleKey) {
    const t = auth.slice("Bearer ".length).trim();
    if (t && constantTimeEqual(t, serviceRoleKey)) return true;
  }
  if (processorToken) {
    const h = (req.headers.get("x-access-tolerance-token") ?? "").trim();
    if (h && constantTimeEqual(h, processorToken)) return true;
  }
  return false;
}

function isRetryEnabled(): boolean {
  return (Deno.env.get("YES_HOTEL_TTLOCK_PROVISION_RETRY_ENABLED") ?? "true")
    .trim()
    .toLowerCase() !== "false";
}

async function callLifecycleProvision(reservaId: string): Promise<{
  ok: boolean;
  status?: string;
  error?: string;
}> {
  const res = await fetch(`${supabaseUrl}/functions/v1/yes-hotel-lifecycle`, {
    method: "POST",
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      "x-yes-internal-caller": "ttlock-provision-retry",
    },
    body: JSON.stringify({ action: "lifecycle_provision", payload: { reservaId } }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    status?: string;
    error?: string;
  };
  return {
    ok: data.ok === true || res.status === 202,
    status: data.status,
    error: data.error,
  };
}

async function callSendSenha(reservaId: string): Promise<{
  ok: boolean;
  skipped?: boolean;
  error?: string;
}> {
  const res = await fetch(`${supabaseUrl}/functions/v1/send-senha`, {
    method: "POST",
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      reserva_id: reservaId,
      manual: false,
      origem: "fase2_retry",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    skipped?: boolean;
    error?: string;
  };
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error || res.statusText };
  }
  return { ok: true, skipped: !!data.skipped };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Método não permitido." }, 405);
  if (!authorize(req)) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  if (!isRetryEnabled()) {
    return jsonResponse({ ok: true, skipped: true, reason: "disabled" });
  }

  let limit = 5;
  try {
    const body = (await req.json().catch(() => ({}))) as { limit?: number };
    const n = Number(body.limit);
    if (Number.isFinite(n) && n > 0) limit = Math.min(10, Math.floor(n));
  } catch {
    // body vazio
  }

  const { data: creds, error: credErr } = await admin
    .from("operacional_credenciais_acesso")
    .select("id, reserva_id, status, codigo_credencial")
    .eq("tipo_credencial", "principal")
    .in("status", ["pendente", "provisionando", "provisionada", "pronta"])
    .order("updated_at", { ascending: true })
    .limit(40);

  if (credErr) {
    return jsonResponse({ ok: false, error: credErr.message }, 500);
  }

  const list = Array.isArray(creds) ? creds : [];
  const reservaIds = [...new Set(list.map((c) => String(c.reserva_id)))];
  const { data: reservas } = reservaIds.length
    ? await admin
        .from("operacional_reservas")
        .select("id, acesso_liberado, senha_enviada_em, status_reserva")
        .in("id", reservaIds)
    : { data: [] as Array<{
        id: string;
        acesso_liberado: boolean;
        senha_enviada_em: string | null;
        status_reserva: string;
      }> };

  const reservaById = new Map(
    (reservas ?? []).map((r) => [String((r as { id: string }).id), r]),
  );

  const processed: Array<Record<string, unknown>> = [];
  let ran = 0;

  for (const cred of list) {
    if (ran >= limit) break;
    const reserva = reservaById.get(String(cred.reserva_id)) as
      | {
          acesso_liberado?: boolean;
          senha_enviada_em?: string | null;
          status_reserva?: string;
        }
      | undefined;
    if (!reserva) continue;
    const statusReserva = String(reserva.status_reserva ?? "").toLowerCase();
    if (statusReserva.includes("cancel")) continue;

    const { data: itens } = await admin
      .from("operacional_credencial_itens")
      .select("status_provisionamento, remote_keyboard_pwd_id")
      .eq("credencial_id", cred.id);

    let lastSyncError: string | null = null;
    try {
      const { data: extra } = await admin
        .from("operacional_credenciais_acesso")
        .select("last_sync_error")
        .eq("id", cred.id)
        .maybeSingle();
      lastSyncError = (extra as { last_sync_error?: string | null } | null)?.last_sync_error ?? null;
    } catch {
      lastSyncError = null;
    }

    const decision = classifyTtlockPhase2Candidate({
      credentialStatus: String(cred.status),
      codigoCredencial: (cred as { codigo_credencial?: string | null }).codigo_credencial ?? null,
      items: (itens ?? []) as {
        status_provisionamento: string;
        remote_keyboard_pwd_id: number | null;
      }[],
      senhaEnviadaEm: reserva.senha_enviada_em ?? null,
      lastSyncError,
      reservaAtiva: true,
      acessoLiberado: !!reserva.acesso_liberado,
    });

    if (!decision.run || !decision.kind) continue;
    ran += 1;

    const row: Record<string, unknown> = {
      reserva_id: cred.reserva_id,
      credencial_id: cred.id,
      kind: decision.kind,
      reason: decision.reason,
    };

    try {
      if (decision.kind === "provision_retry" || decision.kind === "status_heal") {
        const life = await callLifecycleProvision(String(cred.reserva_id));
        row.lifecycle_ok = life.ok;
        row.lifecycle_status = life.status ?? null;
        row.lifecycle_error = life.error ?? null;
      }
      const { data: reservaAfter } = await admin
        .from("operacional_reservas")
        .select("senha_enviada_em")
        .eq("id", cred.reserva_id)
        .maybeSingle();
      const alreadySent = Boolean(
        (reservaAfter as { senha_enviada_em?: string | null } | null)?.senha_enviada_em,
      );
      if (!alreadySent) {
        const send = await callSendSenha(String(cred.reserva_id));
        row.send_ok = send.ok;
        row.send_skipped = send.skipped ?? false;
        row.send_error = send.error ?? null;
      } else {
        row.send_ok = true;
        row.send_skipped = true;
      }
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
    }
    processed.push(row);
  }

  return jsonResponse({
    ok: true,
    scanned: list.length,
    processed: processed.length,
    results: processed,
  });
});
