/**
 * Edge administrativa: cobrança Pagar.me.
 * JWT obrigatório (verify_jwt default true no gateway).
 * Perfis: admin | recepcao.
 *
 * Ações: classificar_comissionamento | criar | cancelar
 *
 * NÃO deployar em produção neste checkpoint.
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
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY sao obrigatorias.",
  );
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

function createRequestClient(request: Request) {
  return createClient(supabaseUrl!, supabaseAnonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: { Authorization: request.headers.get("Authorization") ?? "" },
    },
  });
}

async function getCallerProfile(request: Request) {
  const requestClient = createRequestClient(request);
  const {
    data: { user },
    error: userError,
  } = await requestClient.auth.getUser();
  if (userError || !user) return null;

  const { data: profileRow, error: profileError } = await adminClient
    .from("usuarios_internos")
    .select("id, auth_user_id, perfil_usuario, ativo, nome, email_login")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (profileError || !profileRow) return null;
  return {
    id: String(profileRow.id),
    role: String(profileRow.perfil_usuario ?? "").trim().toLowerCase(),
    active: profileRow.ativo === true,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const caller = await getCallerProfile(request);
    if (!caller || !caller.active) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    if (caller.role !== "admin" && caller.role !== "recepcao") {
      return jsonResponse({ error: "forbidden", message: "Perfil nao autorizado." }, 403);
    }

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(payload.action ?? "").trim();

    const env = denoEnv();
    const config = getPagarmeConfig(env);
    const client = createPagarmeClient({ config, env });
    const repo = createSupabaseCobrancaPagarmeRepository(adminClient);
    const service = createCobrancaPagarmeService({ repo, client });

    if (action === "classificar_comissionamento") {
      const result = await service.classificarComissionamento({
        reservaId: String(payload.reserva_id ?? ""),
        classificacao: String(payload.classificacao ?? ""),
      });
      if (!result.ok) {
        return jsonResponse({ error: result.error.code, message: result.error.message }, result.error.httpStatus);
      }
      return jsonResponse({ ok: true, ...result.data });
    }

    if (action === "criar") {
      const result = await service.criar({
        reservaId: String(payload.reserva_id ?? ""),
        metodo: String(payload.metodo ?? ""),
        valorCentavos: Number(payload.valor_centavos),
        operadorUserId: caller.id,
      });
      if (!result.ok) {
        return jsonResponse(
          {
            error: result.error.code,
            message: result.error.message,
            details: result.error.details,
          },
          result.error.httpStatus,
        );
      }
      return jsonResponse({ ok: true, ...result.data });
    }

    if (action === "cancelar") {
      const result = await service.cancelar({
        cobrancaId: String(payload.cobranca_id ?? ""),
      });
      if (!result.ok) {
        return jsonResponse(
          {
            error: result.error.code,
            message: result.error.message,
            details: result.error.details,
          },
          result.error.httpStatus,
        );
      }
      return jsonResponse({ ok: true, ...result.data });
    }

    return jsonResponse(
      {
        error: "action_invalida",
        message: 'action deve ser "classificar_comissionamento", "criar" ou "cancelar".',
      },
      400,
    );
  } catch (error) {
    console.error("[cobranca-pagarme-admin]", {
      message: error instanceof Error ? error.message : "erro",
    });
    return jsonResponse({ error: "internal_error" }, 500);
  }
});
