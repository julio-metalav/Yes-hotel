/**
 * Edge: cria o vínculo operacional mínimo de uma reserva do HITS, sob demanda.
 *
 * Existe por um motivo só: a FNRH é por hóspede e depende de
 * `operacional_hospedes` (que dispara o trigger de `fnrh_hospedes` com
 * `link_token`). A reserva lida do HITS vive apenas em memória no painel, então
 * não há ficha nem link para oferecer. Aqui o vínculo passa a existir.
 *
 * Reaproveita tudo o que já existe: a leitura vai pelo gateway, a normalização é
 * a mesma do painel, e a escrita é a mesma da materialização automática
 * (src/lib/integrations/hits/hits-materializar.ts). A ficha continua sendo
 * criada pelo trigger.
 *
 * Escopo estrito — grava apenas em `operacional_reservas` e
 * `operacional_hospedes`. Não escreve no HITS, não cria ficha à mão, não
 * sobrescreve registro existente, e não toca status de reserva, quarto,
 * check-in, credencial ou TTLock. Não envia nada (FNRH, senha, WhatsApp,
 * e-mail): MATERIALIZAR ≠ ENVIAR. O financeiro (saldo/total/classificação/
 * pagamento_status) vem do detalhe HITS já normalizado: gravado no insert e,
 * para reserva materializada antes disso, preenchido uma única vez
 * (backfill guardado por saldo nulo).
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  assertHitsGatewayReadReady,
  fetchHitsGuestRevenues,
  getHitsGatewayReadConfig,
  HITS_GUEST_LOOKUP_MAX_POR_CICLO,
} from "../../../src/lib/integrations/hits/hits-gateway-read.ts";
import { aplicarContatoOficialNaReserva } from "../../../src/lib/integrations/hits/hits-contato.ts";
import { normalizeHitsDetailToSynced } from "../../../src/lib/integrations/hits/normalize-hits-detail-to-synced.ts";
import { materializarReservaSincronizada } from "../../../src/lib/integrations/hits/hits-materializar.ts";

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
    "HITS_GATEWAY_PROD_READ_ENABLED",
    "HITS_GATEWAY_TIMEOUT_MS",
  ];
  const env: Record<string, string | undefined> = {};
  for (const k of keys) env[k] = Deno.env.get(k) ?? undefined;
  return env;
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

  // 1b. Contato oficial: o detalhe da reserva (ReservationDetailGuestDto) não
  //     tem celular — ele só existe em GuestRevenueDto. Um GET por hóspede COM
  //     idEntity desta reserva (sequencial, cadenciado, com teto), para que a
  //     materialização sob demanda também não grave o fixo havendo celular.
  //     Falha aqui não derruba nada: cai no fallback contactPhone/contactMail.
  const entityIds = (synced.guests ?? [])
    .map((g) => String(g.externalGuestId ?? "").trim())
    .filter(Boolean);
  let enriquecimento = { solicitados: entityIds.length, lidos: 0, falhas: 0 };
  if (entityIds.length > 0) {
    try {
      const guests = await fetchHitsGuestRevenues({
        config: gate.config,
        entityIds,
        maxLookups: HITS_GUEST_LOOKUP_MAX_POR_CICLO,
      });
      enriquecimento = {
        solicitados: entityIds.length,
        lidos: guests.lidos,
        falhas: guests.falhas,
      };
      synced = aplicarContatoOficialNaReserva(synced, guests.porEntityId);
    } catch (_e) {
      enriquecimento = { solicitados: entityIds.length, lidos: 0, falhas: entityIds.length };
    }
  }

  // 2–4. Mesma escrita da materialização automática (helper compartilhado).
  const out = await materializarReservaSincronizada({
    admin,
    externalId,
    synced,
    log: (msg, extra) => console.error(msg, extra ?? {}),
  });
  if (!out.ok) {
    return json({ ok: false, error: out.error }, out.status);
  }

  // Resposta sem PII: ids técnicos e contadores; sem valores financeiros.
  return json({
    ok: true,
    reserva_id: out.reserva_id,
    external_reservation_id: out.external_reservation_id,
    reserva_criada: out.reserva_criada,
    financeiro: out.financeiro,
    hospedes: out.hospedes,
    hospedes_total: out.hospedes_total,
    enriquecimento,
    ocupacao: out.ocupacao,
  });
});
