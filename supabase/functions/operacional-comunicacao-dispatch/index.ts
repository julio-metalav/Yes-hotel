/**
 * Camada única de envio WhatsApp operacional (DigiSac stub/real).
 * POST JSON: { conversa_id, text, proposito?: "chat_operador" | "generico" }
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { outboundWhatsappParaConversa } from "../_shared/comunicacao-operacional/outbound-whatsapp.ts";
import type { ComunicacaoProposito } from "../_shared/comunicacao-operacional/types.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-whatsapp-internal-test-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios.");
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const internalTestToken = Deno.env.get("WHATSAPP_INTERNAL_TEST_TOKEN")?.trim() ?? "";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function ensureAuth(request: Request): Promise<{ user: { id: string } } | null> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  if (!token) return null;
  if (!supabaseAnonKey) return null;
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) return null;
  return { user };
}

function hasInternalTestAccess(request: Request): boolean {
  if (!internalTestToken) return false;
  const token = request.headers.get("x-whatsapp-internal-test-token")?.trim() ?? "";
  return token.length > 0 && token === internalTestToken;
}

interface Body {
  conversa_id?: string;
  text?: string;
  proposito?: string;
}

function parseProposito(raw: string | undefined): ComunicacaoProposito {
  const p = (raw ?? "").trim();
  if (p === "generico") return "generico";
  return "chat_operador";
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Método permitido: POST." }, 405);
  }

  const internalTest = hasInternalTestAccess(request);
  const auth = internalTest ? { user: { id: "internal-test" } } : await ensureAuth(request);
  if (!auth) {
    return jsonResponse({ ok: false, error: "Não autorizado. Envie Authorization: Bearer <jwt>." }, 401);
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonResponse({ ok: false, error: "Body JSON inválido." }, 400);
  }

  const conversaId = typeof body.conversa_id === "string" ? body.conversa_id.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const proposito = parseProposito(body.proposito);

  if (!conversaId) {
    return jsonResponse({ ok: false, error: "conversa_id obrigatório." }, 400);
  }
  if (!text) {
    return jsonResponse({ ok: false, error: "text obrigatório." }, 400);
  }

  const result = await outboundWhatsappParaConversa(admin, {
    conversaId,
    text,
    proposito,
  });

  if (result.ok) {
    return jsonResponse({
      ok: true,
      messageId: result.messageId,
      provider_message_id: result.provider_message_id ?? null,
      transporte: result.transporte,
      status_envio_gravado: result.status_envio_gravado,
      canal_operacional: "digisac",
    }, 200);
  }

  return jsonResponse({
    ok: false,
    error: result.error ?? "Falha no envio.",
    messageId: result.messageId,
    canal_operacional: "digisac",
  }, 200);
});
