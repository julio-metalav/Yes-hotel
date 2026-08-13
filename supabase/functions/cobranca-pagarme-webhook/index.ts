/**
 * Webhook Pagar.me — notificação apenas (NÃO prova de pagamento).
 * verify_jwt = false SOMENTE nesta função.
 *
 * Fluxo: extrai hints → prefilter candidato local → (se local) idempotência
 * event_id → GET server-to-server → valida → grava. Sem candidato: 200 silencioso.
 *
 * NÃO deployar / NÃO configurar webhook real em produção neste checkpoint.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createCobrancaPagarmeService } from "../../../src/lib/application/yes-hotel/cobranca-pagarme-service.ts";
import { createPagarmeClient } from "../../../src/lib/integrations/pagarme/client.ts";
import { getPagarmeConfig } from "../../../src/lib/integrations/pagarme/config.ts";
import { createSupabaseCobrancaPagarmeRepository } from "../../../src/lib/infrastructure/supabase/yes-hotel/cobranca-pagarme-repository.ts";
import { isFinanceiroLiberadoParaAcesso } from "../../../src/lib/domain/yes-hotel/guest-access-messages.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios.");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function denoEnv(): Record<string, string | undefined> {
  const keys = [
    "PAGARME_ENV",
    "PAGARME_INTEGRATION_ENABLED",
    "PAGARME_SECRET_KEY",
    "PAGARME_CORE_API_BASE_URL",
    "PAGARME_CHECKOUT_API_BASE_URL",
    "PAGARME_API_BASE_URL",
    "PAGARME_REQUEST_TIMEOUT_MS",
    "PAGARME_PIX_EXPIRES_IN_SECONDS",
  ];
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = Deno.env.get(k) ?? undefined;
  return out;
}

const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function sumPagarmePaidCentavos(reservaId: string): Promise<number> {
  const { data, error } = await adminClient
    .from("operacional_cobrancas_pagarme")
    .select("valor_centavos, status")
    .eq("reserva_id", reservaId)
    .eq("status", "paid");
  if (error || !data) return 0;
  let total = 0;
  for (const row of data as Array<{ valor_centavos?: number }>) {
    const v = Number(row.valor_centavos);
    if (Number.isInteger(v) && v > 0) total += v;
  }
  return total;
}

/**
 * Após quitação Pagar.me + FNRH completa: dispara o mesmo fluxo de requisitos
 * (acesso_liberado + send-senha). Idempotente via senha_enviada_em.
 */
async function maybeDispararLiberacaoAposPagarme(cobrancaId: string | null | undefined): Promise<void> {
  if (!cobrancaId) return;
  try {
    const { data: cob } = await adminClient
      .from("operacional_cobrancas_pagarme")
      .select("reserva_id")
      .eq("id", cobrancaId)
      .maybeSingle();
    const reservaId = String((cob as { reserva_id?: string } | null)?.reserva_id ?? "").trim();
    if (!reservaId) return;

    const { data: reserva } = await adminClient
      .from("operacional_reservas")
      .select(
        "id, pagamento_status, senha_enviada_em, acesso_liberado, classificacao_comissionamento, status_reserva, reservation_balance_due, fnrh_status_agregado",
      )
      .eq("id", reservaId)
      .maybeSingle();
    if (!reserva) return;

    const statusReserva = String(
      (reserva as { status_reserva?: string }).status_reserva ?? "",
    ).toLowerCase();
    if (statusReserva.includes("cancel")) return;
    if ((reserva as { senha_enviada_em?: string | null }).senha_enviada_em) return;
    if (
      String((reserva as { fnrh_status_agregado?: string }).fnrh_status_agregado ?? "").trim() !==
      "fnrh_completo"
    ) {
      return;
    }

    const paidTotal = await sumPagarmePaidCentavos(reservaId);
    if (
      !isFinanceiroLiberadoParaAcesso({
        pagamento_status: (reserva as { pagamento_status?: string }).pagamento_status,
        classificacao_comissionamento: (reserva as { classificacao_comissionamento?: string })
          .classificacao_comissionamento,
        reservation_balance_due: (reserva as { reservation_balance_due?: number | null })
          .reservation_balance_due,
        pagarme_paid_centavos_total: paidTotal,
      })
    ) {
      return;
    }

    if (!(reserva as { acesso_liberado?: boolean }).acesso_liberado) {
      await adminClient
        .from("operacional_reservas")
        .update({ acesso_liberado: true, updated_at: new Date().toISOString() })
        .eq("id", reservaId);
    }

    const sendUrl = `${supabaseUrl}/functions/v1/send-senha`;
    const res = await fetch(sendUrl, {
      method: "POST",
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceRoleKey}`,
      },
      body: JSON.stringify({
        reserva_id: reservaId,
        manual: false,
        origem: "requisitos",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[cobranca-pagarme-webhook] liberação pós-pago falhou:", data);
      await adminClient.from("operacional_reserva_eventos").insert({
        reserva_id: reservaId,
        tipo: "falha_enviar_credenciais",
        titulo: "Falha ao enviar credenciais",
        detalhe: JSON.stringify({
          origem: "requisitos_pos_pagarme",
          erro: (data as { error?: string }).error || res.statusText,
        }),
      });
    }
  } catch (error) {
    console.warn("[cobranca-pagarme-webhook] maybeDispararLiberacaoAposPagarme:", error);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const payload = await request.json().catch(() => null);
    if (payload == null) {
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const env = denoEnv();
    const config = getPagarmeConfig(env);
    const client = createPagarmeClient({ config, env });
    const repo = createSupabaseCobrancaPagarmeRepository(adminClient);
    const service = createCobrancaPagarmeService({ repo, client });

    const result = await service.processWebhook(payload);
    if (!result.ok) {
      // Eventos malformados: 400; ambíguos: 502 (Pagar.me pode retentar).
      return jsonResponse(
        { error: result.error.code, message: result.error.message },
        result.error.httpStatus,
      );
    }

    if (result.data.payment_registered && !result.data.duplicate_event) {
      await maybeDispararLiberacaoAposPagarme(result.data.cobranca_id);
    }

    // Duplicata ou processado: sempre 200 para evitar storm de retries desnecessários
    // quando o evento já foi registrado.
    return jsonResponse({ ok: true, ...result.data }, 200);
  } catch (error) {
    console.error("[cobranca-pagarme-webhook]", {
      message: error instanceof Error ? error.message : "erro",
    });
    return jsonResponse({ error: "internal_error" }, 500);
  }
});
