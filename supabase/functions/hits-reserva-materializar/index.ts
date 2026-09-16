/**
 * Edge: cria o vínculo operacional mínimo de uma reserva do HITS, sob demanda.
 *
 * Existe por um motivo só: a FNRH é por hóspede e depende de
 * `operacional_hospedes` (que dispara o trigger de `fnrh_hospedes` com
 * `link_token`). A reserva lida do HITS vive apenas em memória no painel, então
 * não há ficha nem link para oferecer. Aqui o vínculo passa a existir.
 *
 * Reaproveita tudo o que já existe: a leitura vai pelo gateway, a normalização é
 * a mesma do painel, e a ficha continua sendo criada pelo trigger.
 *
 * Escopo estrito — grava apenas em `operacional_reservas` e
 * `operacional_hospedes`. Não escreve no HITS, não cria ficha à mão, não
 * sobrescreve registro existente, e não toca status de reserva, quarto,
 * check-in, pagamento, credencial ou TTLock.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  assertHitsGatewayReadReady,
  getHitsGatewayReadConfig,
} from "../../../src/lib/integrations/hits/hits-gateway-read.ts";
import { normalizeHitsDetailToSynced } from "../../../src/lib/integrations/hits/normalize-hits-detail-to-synced.ts";
import { calcularPosicoesFaltantes } from "../../../src/lib/integrations/hits/hits-ocupacao.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Mesma allowlist de id usada pelo gateway. */
const RESERVATION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Origem fixa: é o que o índice único de idempotência usa. */
const ORIGEM_HITS = "hits";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function denoEnv(): Record<string, string | undefined> {
  const keys = [
    "HITS_GATEWAY_URL",
    "HITS_GATEWAY_TOKEN",
    "HITS_GATEWAY_READ_ENABLED",
    "HITS_GATEWAY_TIMEOUT_MS",
  ];
  const env: Record<string, string | undefined> = {};
  for (const k of keys) env[k] = Deno.env.get(k) ?? undefined;
  return env;
}

function ymdOrNull(value: unknown): string | null {
  const s = String(value ?? "").slice(0, 10);
  return YMD_RE.test(s) ? s : null;
}

/** 23505 = unique_violation: outro clique simultâneo ganhou a corrida. */
function isUniqueViolation(error: unknown): boolean {
  return String((error as { code?: string } | null)?.code ?? "") === "23505";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const body = (await req.json().catch(() => null)) as
    | { external_reservation_id?: unknown }
    | null;
  const externalId = String(body?.external_reservation_id ?? "").trim();
  if (!externalId || !RESERVATION_ID_RE.test(externalId)) {
    return json({ ok: false, error: "external_reservation_id inválido." }, 400);
  }

  const config = getHitsGatewayReadConfig(denoEnv());
  const gate = assertHitsGatewayReadReady(config);
  if (!gate.ok) {
    return json(
      { ok: false, error: gate.reason, message: gate.message },
      gate.reason === "gateway_read_disabled" ? 403 : 503,
    );
  }

  // 1. Detalhe real no HITS — é dele que saem datas, apartamento e idEntity.
  let detail: Record<string, unknown>;
  try {
    const res = await fetch(
      `${gate.config.baseUrl}/v1/reservations/${encodeURIComponent(externalId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${gate.config.token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(gate.config.requestTimeoutMs),
      },
    );
    if (res.status === 404) {
      return json({ ok: false, error: "reserva_nao_encontrada_no_hits" }, 404);
    }
    if (!res.ok) {
      console.error("[HITS_MATERIALIZAR] leitura falhou", { http_status: res.status });
      return json({ ok: false, error: "gateway_read_failed" }, 502);
    }
    detail = (await res.json()) as Record<string, unknown>;
  } catch (_e) {
    console.error("[HITS_MATERIALIZAR] falha de rede na leitura");
    return json({ ok: false, error: "gateway_read_failed" }, 502);
  }

  let synced;
  try {
    synced = normalizeHitsDetailToSynced(detail, null);
  } catch (_e) {
    return json({ ok: false, error: "detalhe_hits_invalido" }, 502);
  }

  // Datas vêm do HITS. Sem elas não se inventa `current_date`: o painel filtra
  // por dia operacional e uma data chutada esconderia a reserva da grade.
  const checkIn = ymdOrNull(synced.checkIn);
  const checkOut = ymdOrNull(synced.checkOut);
  if (!checkIn || !checkOut) {
    return json({ ok: false, error: "reserva_sem_datas_no_hits" }, 422);
  }

  // 2. Reserva operacional: reusa se já existe (índice único parcial em
  //    origem_externa + external_reservation_id garante unicidade).
  async function findReserva(): Promise<{ id: string } | null> {
    const { data } = await admin
      .from("operacional_reservas")
      .select("id")
      .eq("origem_externa", ORIGEM_HITS)
      .eq("external_reservation_id", externalId)
      .maybeSingle();
    return (data as { id: string } | null) ?? null;
  }

  let reserva = await findReserva();
  let reservaCriada = false;
  if (!reserva) {
    const { data, error } = await admin
      .from("operacional_reservas")
      .insert({
        apartamento: synced.apartmentCode || "",
        hospede_principal: synced.mainGuestName || "",
        check_in_previsto: checkIn,
        check_out_previsto: checkOut,
        origem_externa: ORIGEM_HITS,
        external_reservation_id: externalId,
      })
      .select("id")
      .single();
    if (error) {
      // Corrida com outro clique: o vencedor já criou — reusa.
      if (!isUniqueViolation(error)) {
        console.error("[HITS_MATERIALIZAR] insert reserva falhou", { code: error.code });
        return json({ ok: false, error: "falha_ao_criar_reserva" }, 500);
      }
      reserva = await findReserva();
    } else {
      reserva = data as { id: string };
      reservaCriada = true;
    }
  }
  if (!reserva) {
    return json({ ok: false, error: "falha_ao_criar_reserva" }, 500);
  }

  // 3. Um operacional_hospedes por PAX com idEntity — o trigger existente cria
  //    a fnrh_hospedes com link_token. Hóspede já vinculado é reusado como está:
  //    nada é sobrescrito, e ficha preenchida permanece intacta.
  const hospedes: Array<{ id_entity: string; criado: boolean }> = [];
  for (const guest of synced.guests ?? []) {
    const idEntity = String(guest.externalGuestId ?? "").trim();
    if (!idEntity) continue;

    const { data: existente } = await admin
      .from("operacional_hospedes")
      .select("id")
      .eq("reserva_id", reserva.id)
      .eq("pms_external_guest_id", idEntity)
      .maybeSingle();
    if (existente) {
      hospedes.push({ id_entity: idEntity, criado: false });
      continue;
    }

    const email = (guest.email ?? "").trim();
    const telefone = (guest.phone ?? "").trim();
    const { error } = await admin.from("operacional_hospedes").insert({
      reserva_id: reserva.id,
      nome: (guest.name ?? "").trim(),
      principal: guest.isPrincipal === true,
      email,
      whatsapp: telefone,
      // Só é "pronto para envio" quem tem como receber o link.
      status_operacional: email || telefone ? "pronto_para_envio" : "aguardando_contato",
      origem_cadastro: "existente_incompleto",
      modo_coleta_fnrh: "preenchimento_completo",
      pms_external_guest_id: idEntity,
    });
    if (error && !isUniqueViolation(error)) {
      console.error("[HITS_MATERIALIZAR] insert hóspede falhou", { code: error.code });
      return json({ ok: false, error: "falha_ao_criar_hospede" }, 500);
    }
    hospedes.push({ id_entity: idEntity, criado: !error });
  }

  // 4. Completa a ocupação declarada pelo HITS com posições sem PAX.
  //    Reserva de 2 adultos com 1 idEntity cadastrado é o caso comum; sem isto
  //    a segunda pessoa ficaria sem ficha. Mesmo payload do "Adicionar hóspede"
  //    do painel (ui/checkin-operacional-mvp.js:1415) — e sem
  //    pms_external_guest_id, porque não se inventa idEntity. A ficha e o
  //    link_token continuam vindo do trigger operacional_hospedes_criar_fnrh.
  const { data: ativos } = await admin
    .from("operacional_hospedes")
    .select("id")
    .eq("reserva_id", reserva.id)
    .or("removed_from_reservation.is.null,removed_from_reservation.eq.false");
  const hospedesAtivos = (ativos ?? []).length;
  const faltam = calcularPosicoesFaltantes(synced.totalGuests, hospedesAtivos);

  let posicoesCriadas = 0;
  for (let i = 0; i < faltam; i += 1) {
    const { error } = await admin.from("operacional_hospedes").insert({
      reserva_id: reserva.id,
      nome: "Novo hóspede",
      principal: false,
      status_operacional: "nao_identificado",
      origem_cadastro: "novo",
      modo_coleta_fnrh: "preenchimento_completo",
      tentativas_envio: 0,
    });
    if (error) {
      console.error("[HITS_MATERIALIZAR] insert posição falhou", { code: error.code });
      break;
    }
    posicoesCriadas += 1;
  }

  // Resposta sem PII: ids técnicos e contadores.
  return json({
    ok: true,
    reserva_id: reserva.id,
    external_reservation_id: externalId,
    reserva_criada: reservaCriada,
    hospedes,
    hospedes_total: hospedes.length,
    ocupacao: {
      declarada_hits: Number(synced.totalGuests) || 1,
      hospedes_ativos: hospedesAtivos,
      posicoes_criadas: posicoesCriadas,
    },
  });
});
