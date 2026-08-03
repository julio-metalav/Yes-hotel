/**
 * Job temporal de liberação de credenciais (13h Campo Grande/MS) + retry de falhas.
 * Chamável por scheduler. Configuração versionada pendente:
 *   docs/YES_HOTEL_SENHA_AUTO_ENVIO_SCHEDULER.md
 *   supabase/pending/senha-auto-envio-cron.sql
 * (cron remoto NÃO aplicado nesta etapa.)
 *
 * POST body:
 *   { mode?: "13h" | "retry", limit?: number }
 * Auth:
 *   Authorization: Bearer <service_role>
 *   ou header x-senha-scheduler-token se SENHA_SCHEDULER_TOKEN estiver definido.
 *
 * Reusa send-senha + lifecycle (via liberar acesso) — sem integração paralela.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-senha-scheduler-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const schedulerToken = (Deno.env.get("SENHA_SCHEDULER_TOKEN") ?? "").trim();
const timezone = (
  Deno.env.get("YES_HOTEL_TIMEZONE") ?? "America/Campo_Grande"
).trim();
const AUTO_HOUR = 13;

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Mode = "13h" | "retry";

interface ReservaRow {
  id: string;
  apartamento: string | null;
  pagamento_status: string | null;
  fnrh_status_agregado: string | null;
  senha_enviada_em: string | null;
  acesso_liberado: boolean | null;
  entrou_no_apto: boolean | null;
  check_in_previsto: string | null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getZonedParts(date: Date, tz: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || "0";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  return {
    year,
    month,
    day,
    hour,
    minute,
    dateYmd: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    horaLocal: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

function authorize(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth === `Bearer ${serviceRoleKey}`) return true;
  if (schedulerToken) {
    const header = (req.headers.get("x-senha-scheduler-token") ?? "").trim();
    if (header && header === schedulerToken) return true;
  }
  return false;
}

async function hasValidCredential(reservaId: string): Promise<boolean> {
  const { data } = await admin
    .from("operacional_credenciais_acesso")
    .select("codigo_credencial, status")
    .eq("reserva_id", reservaId)
    .eq("tipo_credencial", "principal")
    .maybeSingle();
  const code = (data as { codigo_credencial?: string | null } | null)
    ?.codigo_credencial;
  return !!(code && String(code).trim());
}

async function lastOpenFailure(
  reservaId: string,
): Promise<"geracao" | "envio" | null> {
  const { data } = await admin
    .from("operacional_reserva_eventos")
    .select("tipo, criado_em")
    .eq("reserva_id", reservaId)
    .in("tipo", [
      "falha_gerar_senha",
      "falha_enviar_credenciais",
      "envio_auto_senha",
      "envio_manual_senha",
      "retry_credenciais_sucesso",
      "credencial_liberacao_aplicada",
    ])
    .order("criado_em", { ascending: false })
    .limit(20);
  if (!Array.isArray(data) || data.length === 0) return null;
  for (const row of data as { tipo?: string }[]) {
    const tipo = row.tipo || "";
    if (
      tipo === "envio_auto_senha" ||
      tipo === "envio_manual_senha" ||
      tipo === "retry_credenciais_sucesso" ||
      tipo === "credencial_liberacao_aplicada"
    ) {
      return null;
    }
    if (tipo === "falha_gerar_senha") return "geracao";
    if (tipo === "falha_enviar_credenciais") return "envio";
  }
  return null;
}

async function ensureAccess(reservaId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: reserva } = await admin
    .from("operacional_reservas")
    .select("acesso_liberado")
    .eq("id", reservaId)
    .maybeSingle();
  if (!(reserva as { acesso_liberado?: boolean } | null)?.acesso_liberado) {
    const { error } = await admin
      .from("operacional_reservas")
      .update({ acesso_liberado: true, updated_at: new Date().toISOString() })
      .eq("id", reservaId);
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true };
}

async function callSendSenha(
  reservaId: string,
  origem: string,
  manual: boolean,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const res = await fetch(`${supabaseUrl}/functions/v1/send-senha`, {
    method: "POST",
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify({
      reserva_id: reservaId,
      manual,
      origem,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    skipped?: boolean;
    error?: string;
    message?: string;
  };
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error || data.message || res.statusText };
  }
  return { ok: true, skipped: !!data.skipped };
}

async function registerEvent(
  reservaId: string,
  tipo: string,
  titulo: string,
  detalhe: Record<string, unknown>,
): Promise<void> {
  await admin.from("operacional_reserva_eventos").insert({
    reserva_id: reservaId,
    tipo,
    titulo,
    detalhe: JSON.stringify(detalhe),
  });
}

async function processOne13h(reserva: ReservaRow): Promise<{
  status: "enviada" | "ignorada" | "falha";
  motivo?: string;
}> {
  if (reserva.senha_enviada_em) {
    return { status: "ignorada", motivo: "ja_enviada" };
  }
  if (reserva.entrou_no_apto) {
    return { status: "ignorada", motivo: "encerrada" };
  }

  const access = await ensureAccess(reserva.id);
  if (!access.ok) {
    await registerEvent(reserva.id, "falha_gerar_senha", "Falha ao gerar senha", {
      origem: "horario_13h",
      erro: access.error || null,
    });
    return { status: "falha", motivo: (access.error || "gerar").slice(0, 120) };
  }

  const send = await callSendSenha(reserva.id, "horario_13h", false);
  if (!send.ok) {
    const isGen =
      (send.error || "").toLowerCase().includes("credencial") ||
      (send.error || "").toLowerCase().includes("provision");
    await registerEvent(
      reserva.id,
      isGen ? "falha_gerar_senha" : "falha_enviar_credenciais",
      isGen ? "Falha ao gerar senha" : "Falha ao enviar credenciais",
      { origem: "horario_13h", erro: send.error || null },
    );
    return { status: "falha", motivo: (send.error || "enviar").slice(0, 120) };
  }
  if (send.skipped) return { status: "ignorada", motivo: "ja_enviada" };
  return { status: "enviada" };
}

async function processOneRetry(reserva: ReservaRow): Promise<{
  status: "enviada" | "ignorada" | "falha";
  motivo?: string;
}> {
  if (reserva.senha_enviada_em) {
    return { status: "ignorada", motivo: "ja_enviada" };
  }
  if (reserva.entrou_no_apto) {
    return { status: "ignorada", motivo: "encerrada" };
  }

  const falha = await lastOpenFailure(reserva.id);
  if (!falha) return { status: "ignorada", motivo: "sem_falha_aberta" };

  const temCredencial = await hasValidCredential(reserva.id);
  const reutilizar = falha === "envio" && temCredencial;

  await registerEvent(
    reserva.id,
    "retry_credenciais_iniciado",
    "Nova tentativa de liberação de credenciais",
    {
      origem: "retry_automatico",
      falha_anterior: falha,
      reutilizar_credencial: reutilizar,
    },
  );

  if (!reutilizar) {
    const access = await ensureAccess(reserva.id);
    if (!access.ok) {
      await registerEvent(reserva.id, "falha_gerar_senha", "Falha ao gerar senha", {
        origem: "retry_automatico",
        erro: access.error || null,
      });
      return { status: "falha", motivo: (access.error || "gerar").slice(0, 120) };
    }
  }

  const send = await callSendSenha(reserva.id, "retry_automatico", false);
  if (!send.ok) {
    const isGen =
      !reutilizar &&
      ((send.error || "").toLowerCase().includes("credencial") ||
        (send.error || "").toLowerCase().includes("provision"));
    await registerEvent(
      reserva.id,
      isGen ? "falha_gerar_senha" : "falha_enviar_credenciais",
      isGen ? "Falha ao gerar senha" : "Falha ao enviar credenciais",
      { origem: "retry_automatico", erro: send.error || null },
    );
    return { status: "falha", motivo: (send.error || "enviar").slice(0, 120) };
  }

  await registerEvent(
    reserva.id,
    "retry_credenciais_sucesso",
    "Retry de credenciais concluído",
    {
      origem: "retry_automatico",
      reutilizar_credencial: reutilizar,
      skipped: !!send.skipped,
    },
  );

  if (send.skipped) return { status: "ignorada", motivo: "ja_enviada" };
  return { status: "enviada" };
}

async function run13h(): Promise<Record<string, unknown>> {
  const agora = new Date();
  const zoned = getZonedParts(agora, timezone);
  const encontradasQuery = await admin
    .from("operacional_reservas")
    .select(
      "id, apartamento, pagamento_status, fnrh_status_agregado, senha_enviada_em, acesso_liberado, entrou_no_apto, check_in_previsto",
    )
    .eq("check_in_previsto", zoned.dateYmd);

  const reservas = (encontradasQuery.data || []) as ReservaRow[];
  const encontradas = reservas.length;

  if (zoned.hour < AUTO_HOUR) {
    return {
      ok: true,
      mode: "13h",
      timezone,
      dateYmd: zoned.dateYmd,
      horaLocal: zoned.horaLocal,
      antesDas13h: true,
      encontradas,
      processadas: encontradas,
      enviadas: 0,
      ignoradas: encontradas,
      falhas: 0,
      falhasDetalhe: [],
    };
  }

  let enviadas = 0;
  let ignoradas = 0;
  let falhas = 0;
  const falhasDetalhe: Array<{ reservaId: string; motivo: string }> = [];

  for (const reserva of reservas) {
    try {
      const result = await processOne13h(reserva);
      if (result.status === "enviada") enviadas += 1;
      else if (result.status === "falha") {
        falhas += 1;
        falhasDetalhe.push({
          reservaId: reserva.id,
          motivo: result.motivo || "falha",
        });
      } else ignoradas += 1;
    } catch (error) {
      falhas += 1;
      falhasDetalhe.push({
        reservaId: reserva.id,
        motivo:
          error instanceof Error
            ? error.message.slice(0, 120)
            : "erro_inesperado",
      });
    }
  }

  return {
    ok: true,
    mode: "13h",
    timezone,
    dateYmd: zoned.dateYmd,
    horaLocal: zoned.horaLocal,
    antesDas13h: false,
    encontradas,
    processadas: encontradas,
    enviadas,
    ignoradas,
    falhas,
    falhasDetalhe,
  };
}

async function runRetry(limit: number): Promise<Record<string, unknown>> {
  const { data: failEvents } = await admin
    .from("operacional_reserva_eventos")
    .select("reserva_id, tipo, criado_em")
    .in("tipo", ["falha_gerar_senha", "falha_enviar_credenciais"])
    .order("criado_em", { ascending: false })
    .limit(200);

  const seen = new Set<string>();
  const candidateIds: string[] = [];
  for (const row of (failEvents || []) as {
    reserva_id?: string;
    tipo?: string;
  }[]) {
    const id = row.reserva_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    candidateIds.push(id);
    if (candidateIds.length >= limit) break;
  }

  let enviadas = 0;
  let ignoradas = 0;
  let falhas = 0;
  const falhasDetalhe: Array<{ reservaId: string; motivo: string }> = [];
  let processadas = 0;

  for (const reservaId of candidateIds) {
    const { data: reserva } = await admin
      .from("operacional_reservas")
      .select(
        "id, apartamento, pagamento_status, fnrh_status_agregado, senha_enviada_em, acesso_liberado, entrou_no_apto, check_in_previsto",
      )
      .eq("id", reservaId)
      .maybeSingle();
    if (!reserva) {
      ignoradas += 1;
      continue;
    }
    processadas += 1;
    try {
      const result = await processOneRetry(reserva as ReservaRow);
      if (result.status === "enviada") enviadas += 1;
      else if (result.status === "falha") {
        falhas += 1;
        falhasDetalhe.push({
          reservaId,
          motivo: result.motivo || "falha",
        });
      } else ignoradas += 1;
    } catch (error) {
      falhas += 1;
      falhasDetalhe.push({
        reservaId,
        motivo:
          error instanceof Error
            ? error.message.slice(0, 120)
            : "erro_inesperado",
      });
    }
  }

  return {
    ok: true,
    mode: "retry",
    timezone,
    encontradas: candidateIds.length,
    processadas,
    enviadas,
    ignoradas,
    falhas,
    falhasDetalhe,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Método não permitido." }, 405);
  }
  if (!authorize(req)) {
    return jsonResponse({ ok: false, error: "Não autorizado." }, 401);
  }

  let body: { mode?: string; limit?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }

  const mode = (body.mode === "retry" ? "retry" : "13h") as Mode;
  const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));

  try {
    if (mode === "retry") {
      return jsonResponse(await runRetry(limit));
    }
    return jsonResponse(await run13h());
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error:
          error instanceof Error ? error.message.slice(0, 200) : "erro_inesperado",
      },
      500,
    );
  }
});
