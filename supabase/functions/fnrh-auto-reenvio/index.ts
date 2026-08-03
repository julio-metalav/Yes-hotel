/**
 * Job temporal FNRH:
 * - D-1 (24h antes): check_in_previsto = amanhã
 * - D0 07h: check_in_previsto = hoje
 *
 * Reusa send-fnrh-links e evita duplicidade por reserva+gatilho+check-in.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { resolveFnrhPublicBaseUrl } from "../_shared/fnrh-public-link.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-fnrh-scheduler-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const schedulerToken = (Deno.env.get("FNRH_SCHEDULER_TOKEN") ?? "").trim();
const timezone = (Deno.env.get("YES_HOTEL_TIMEZONE") ?? "America/Sao_Paulo").trim();

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type TriggerType = "d-3" | "d-1" | "d0-07h";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toDateInTimeZone(date: Date, tz: string): Date {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const [d, t] = s.split(", ");
  const [y, m, dd] = d.split("-");
  const [hh, mm, ss] = t.split(":");
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(dd), Number(hh), Number(mm), Number(ss)));
}

function getLocalDateISO(date: Date, tz: string): string {
  const d = toDateInTimeZone(date, tz);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function shiftDateISO(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, "0")}-${String(base.getUTCDate()).padStart(2, "0")}`;
}

async function alreadyTriggeredForCheckin(reservaId: string, triggerType: TriggerType, checkInPrevisto: string): Promise<boolean> {
  const { data, error } = await admin
    .from("operacional_reserva_eventos")
    .select("detalhe")
    .eq("reserva_id", reservaId)
    .eq("tipo", "envio_auto_fnrh");
  if (error || !Array.isArray(data) || data.length === 0) return false;
  for (const row of data as { detalhe?: string | null }[]) {
    const detalhe = String(row.detalhe ?? "").trim();
    if (!detalhe) continue;
    try {
      const parsed = JSON.parse(detalhe) as { tipo_evento?: string; check_in_previsto?: string };
      if ((parsed.tipo_evento ?? "") === triggerType && (parsed.check_in_previsto ?? "") === checkInPrevisto) return true;
    } catch {
      const hasTrigger = detalhe.includes(`"tipo_evento":"${triggerType}"`) || detalhe.includes(`"tipo_evento": "${triggerType}"`);
      const hasCheckin = detalhe.includes(`"check_in_previsto":"${checkInPrevisto}"`) || detalhe.includes(`"check_in_previsto": "${checkInPrevisto}"`);
      if (hasTrigger && hasCheckin) return true;
    }
  }
  return false;
}

async function runTrigger(triggerType: TriggerType, baseUrl: string): Promise<Record<string, unknown>> {
  const now = new Date();
  const todayLocal = getLocalDateISO(now, timezone);
  const checkInDate =
    triggerType === "d-3"
      ? shiftDateISO(todayLocal, 3)
      : triggerType === "d-1"
        ? shiftDateISO(todayLocal, 1)
        : todayLocal;
  const localDate = todayLocal;

  const { data: reservas, error: errR } = await admin
    .from("operacional_reservas")
    .select("id, check_in_previsto")
    .eq("check_in_previsto", checkInDate);

  if (errR) {
    return {
      trigger: triggerType,
      localDate,
      checkInDate,
      error: errR.message,
      processadas: 0,
      enviadas: 0,
      puladasDuplicidade: 0,
    };
  }

  let processadas = 0;
  let enviadas = 0;
  let puladasDuplicidade = 0;
  const erros: string[] = [];

  for (const r of (reservas ?? []) as { id: string; check_in_previsto: string }[]) {
    processadas++;
    const { count: pendentesCount } = await admin
      .from("fnrh_hospedes")
      .select("id", { count: "exact", head: true })
      .eq("reserva_id", r.id)
      .in("status", ["pendente", "rascunho", "pendente_confirmacao"]);
    if ((pendentesCount ?? 0) <= 0) {
      continue;
    }
    const duplicate = await alreadyTriggeredForCheckin(r.id, triggerType, r.check_in_previsto);
    if (duplicate) {
      puladasDuplicidade++;
      continue;
    }
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/send-fnrh-links`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": supabaseAnonKey || serviceRoleKey,
          "Authorization": `Bearer ${supabaseAnonKey || serviceRoleKey}`,
        },
        body: JSON.stringify({
          reserva_id: r.id,
          tipo_evento: triggerType,
          check_in_previsto: r.check_in_previsto,
          job_date: localDate,
          base_url: baseUrl,
        }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || !data.ok) {
        erros.push(`reserva ${r.id}: ${data.error ?? data.message ?? `HTTP ${res.status}`}`);
        continue;
      }
      enviadas++;
    } catch (e) {
      erros.push(`reserva ${r.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    trigger: triggerType,
    localDate,
    checkInDate,
    processadas,
    enviadas,
    puladasDuplicidade,
    erros: erros.length ? erros : undefined,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Método não permitido." }, 405);

  if (schedulerToken) {
    const token = (req.headers.get("x-fnrh-scheduler-token") ?? "").trim();
    if (!token || token !== schedulerToken) {
      return jsonResponse({ ok: false, error: "Não autorizado." }, 401);
    }
  }

  const body = (await req.json().catch(() => ({}))) as {
    trigger?: "d-3" | "d-1" | "d0-07h" | "all";
    base_url?: string;
  };

  const trigger = body.trigger ?? "all";
  const baseUrl = resolveFnrhPublicBaseUrl({
    override: body.base_url,
    envValue: Deno.env.get("FNRH_PUBLIC_BASE_URL"),
  });
  const results: Record<string, unknown>[] = [];

  if (trigger === "all" || trigger === "d-3") {
    results.push(await runTrigger("d-3", baseUrl));
  }
  if (trigger === "all" || trigger === "d-1") {
    results.push(await runTrigger("d-1", baseUrl));
  }
  if (trigger === "all" || trigger === "d0-07h") {
    results.push(await runTrigger("d0-07h", baseUrl));
  }

  return jsonResponse({ ok: true, timezone, results }, 200);
});

