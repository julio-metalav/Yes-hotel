/**
 * Outbound — MVP 3 Fase 2 + Fase 4.2 Meta Cloud API.
 * Recebe POST com conversa_id e text; valida JWT; insere mensagem (enviando);
 * chama adapter mock ou Meta Cloud API conforme WHATSAPP_USE_MOCK;
 * atualiza mensagem (enviada/falha) e conversa; responde JSON.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

/** Fase 4.2: Meta Cloud API — env vars (uso real quando WHATSAPP_USE_MOCK !== 'true'). */
const whatsappUseMock = Deno.env.get("WHATSAPP_USE_MOCK") ?? "true";
const whatsappAccessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
const whatsappPhoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
const whatsappGraphVersion = Deno.env.get("WHATSAPP_GRAPH_API_VERSION") ?? "v21.0";
const whatsappInternalTestToken = Deno.env.get("WHATSAPP_INTERNAL_TEST_TOKEN")?.trim() ?? "";

const PREVIEW_MAX_LEN = 80;

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
  if (!whatsappInternalTestToken) return false;
  const token = request.headers.get("x-whatsapp-internal-test-token")?.trim() ?? "";
  return token.length > 0 && token === whatsappInternalTestToken;
}

interface SendBody {
  conversa_id?: string;
  text?: string;
}

function parseBody(body: unknown): SendBody {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as SendBody;
  }
  return {};
}

type AdapterResult = { ok: boolean; provider_message_id?: string; error?: string };

/** Adaptador mock: sucesso por padrão; falha se text contiver "__fail__". */
function mockAdapterSend(telefone: string, text: string): AdapterResult {
  if (text.includes("__fail__")) {
    return { ok: false, error: "Mock: falha simulada (texto contem __fail__)." };
  }
  return {
    ok: true,
    provider_message_id: "mock-" + Date.now(),
  };
}

/** Fase 4.2: Adaptador Meta Cloud API — POST graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages */
async function cloudApiAdapterSend(telefone: string, text: string): Promise<AdapterResult> {
  if (!whatsappAccessToken || !whatsappPhoneNumberId) {
    return { ok: false, error: "Meta Cloud API: WHATSAPP_ACCESS_TOKEN e WHATSAPP_PHONE_NUMBER_ID obrigatorios." };
  }
  const to = telefone.replace(/\D/g, "");
  if (!to) return { ok: false, error: "Telefone invalido (sem digitos)." };

  const url = `https://graph.facebook.com/${whatsappGraphVersion}/${whatsappPhoneNumberId}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${whatsappAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = (data && typeof data === "object" && "error" in data && data.error && typeof data.error === "object" && "message" in data.error)
        ? String((data.error as { message?: unknown }).message)
        : `HTTP ${res.status}`;
      return { ok: false, error: `Meta Cloud API: ${msg}` };
    }

    const messages = data?.messages;
    const provider_message_id = Array.isArray(messages) && messages[0] && typeof messages[0].id === "string"
      ? messages[0].id
      : undefined;

    return { ok: true, provider_message_id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro de rede ao chamar Meta Cloud API.";
    return { ok: false, error: message };
  }
}

function preview(text: string): string {
  const t = text.trim();
  if (t.length <= PREVIEW_MAX_LEN) return t;
  return t.slice(0, PREVIEW_MAX_LEN - 3) + "...";
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Metodo permitido: POST." }, 405);
  }

  const internalTest = hasInternalTestAccess(request);
  const auth = internalTest ? { user: { id: "internal-test" } } : await ensureAuth(request);
  if (!auth) {
    return jsonResponse({ ok: false, error: "Nao autorizado. Envie Authorization: Bearer <jwt>." }, 401);
  }

  let body: SendBody;
  try {
    body = parseBody(await request.json());
  } catch {
    return jsonResponse({ ok: false, error: "Body JSON invalido." }, 400);
  }

  const conversaId = typeof body.conversa_id === "string" ? body.conversa_id.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";

  if (!conversaId) {
    return jsonResponse({ ok: false, error: "conversa_id obrigatorio." }, 400);
  }
  if (text === "") {
    return jsonResponse({ ok: false, error: "text obrigatorio." }, 400);
  }

  const { data: conv, error: convError } = await admin
    .from("comunicacao_conversas")
    .select("id, canal, telefone")
    .eq("id", conversaId)
    .maybeSingle();

  if (convError || !conv) {
    return jsonResponse({ ok: false, error: "Conversa nao encontrada." }, 404);
  }
  if (conv.canal !== "whatsapp") {
    return jsonResponse({ ok: false, error: "Canal da conversa deve ser whatsapp." }, 400);
  }

  const telefone = conv.telefone || "";
  if (!telefone) {
    return jsonResponse({ ok: false, error: "Conversa sem telefone." }, 400);
  }

  const previewText = preview(text);

  const { data: msg, error: insertError } = await admin
    .from("comunicacao_mensagens")
    .insert({
      conversa_id: conversaId,
      direcao: "saida",
      tipo_mensagem: "texto",
      mensagem: text,
      status_envio: "enviando",
    })
    .select("id, created_at")
    .single();

  if (insertError || !msg) {
    console.error("[send-whatsapp-message] insert error", insertError);
    return jsonResponse({ ok: false, error: insertError?.message ?? "Falha ao gravar mensagem." }, 500);
  }

  const result = whatsappUseMock === "true"
    ? mockAdapterSend(telefone, text)
    : await cloudApiAdapterSend(telefone, text);

  const usoMock = whatsappUseMock === "true";

  if (result.ok) {
    await admin
      .from("comunicacao_mensagens")
      .update({
        status_envio: usoMock ? "mock_enviado" : "enviada",
        provider_message_id: result.provider_message_id ?? null,
      })
      .eq("id", msg.id);
  } else {
    await admin
      .from("comunicacao_mensagens")
      .update({
        status_envio: "falha",
        metadata: { error: result.error ?? "Falha no envio." },
      })
      .eq("id", msg.id);
  }

  await admin
    .from("comunicacao_conversas")
    .update({
      ultima_mensagem_em: msg.created_at,
      ultima_mensagem_preview: previewText,
    })
    .eq("id", conversaId);

  if (result.ok) {
    return jsonResponse({
      ok: true,
      messageId: msg.id,
      provider_message_id: result.provider_message_id ?? null,
      transporte: usoMock ? "simulado" : "whatsapp",
      status_envio_gravado: usoMock ? "mock_enviado" : "enviada",
    }, 200);
  }

  return jsonResponse({
    ok: false,
    error: result.error ?? "Falha no envio.",
    messageId: msg.id,
  }, 200);
});
