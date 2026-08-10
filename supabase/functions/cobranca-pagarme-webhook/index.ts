/**
 * Webhook Pagar.me — notificação apenas (NÃO prova de pagamento).
 * verify_jwt = false SOMENTE nesta função.
 *
 * Fluxo: idempotência event_id → extrai IDs → GET server-to-server → valida → grava.
 *
 * NÃO deployar / NÃO configurar webhook real em produção neste checkpoint.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createCobrancaPagarmeService } from "../../../src/lib/application/yes-hotel/cobranca-pagarme-service.ts";
import { createPagarmeClient } from "../../../src/lib/integrations/pagarme/client.ts";
import { getPagarmeConfig } from "../../../src/lib/integrations/pagarme/config.ts";
import { createSupabaseCobrancaPagarmeRepository } from "../../../src/lib/infrastructure/supabase/yes-hotel/cobranca-pagarme-repository.ts";

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
