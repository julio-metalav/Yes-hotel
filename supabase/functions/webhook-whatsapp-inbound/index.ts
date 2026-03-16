/**
 * Webhook inbound mínimo (Fase 1) + callback de status entregue/lida (Fase 3).
 * - Inbound: POST com from, messageId, text → localizar ou criar conversa, inserir mensagem, 200.
 * - Status: POST com type='status', provider_message_id, status (entregue|lida|falha) → atualizar status_envio com precedência, 200.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// --- Payload interno normalizado (após adapter)
interface InboundPayload {
  from: string;
  messageId: string;
  text: string;
  raw?: Record<string, unknown>;
}

/** Payload interno para callback de status (Fase 3). */
type StatusValue = "entregue" | "lida" | "falha";
interface StatusPayload {
  provider_message_id: string;
  status: StatusValue;
}

const PREVIEW_MAX_LEN = 80;

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function emptyOk(): Response {
  return new Response(null, { status: 200, headers: corsHeaders });
}

/** Normaliza telefone: E.164 sem "+". Remove não-dígitos; se 10 ou 11 dígitos sem prefixo 55, adiciona 55. */
function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) {
    return "55" + digits;
  }
  return digits || value.trim().replace(/^\+/, "");
}

/**
 * Adapter mínimo: aceita payload já no formato interno (from, messageId, text)
 * ou campos alternativos comuns (from -> phone/sender, messageId -> id/message_id, text -> body/message).
 * Para teste manual: POST com { "from": "5511999990001", "messageId": "test-1", "text": "Olá" }.
 */
function parseInboundBody(body: unknown): InboundPayload {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const fromRaw = o.from ?? o.phone ?? o.sender ?? o.from_number ?? "";
  const messageIdRaw = o.messageId ?? o.id ?? o.message_id ?? o.provider_message_id ?? "";
  const textRaw = o.text ?? o.body ?? o.message ?? o.content ?? "";

  const from = String(fromRaw).trim();
  const messageId = String(messageIdRaw).trim();
  const text = String(textRaw ?? "").trim();

  if (!from) throw new Error("Campo from (ou phone/sender) obrigatorio.");
  if (!messageId) throw new Error("Campo messageId (ou id/message_id) obrigatorio.");

  return {
    from: normalizePhone(from),
    messageId,
    text: text || "(mensagem sem texto)",
    raw: o.raw != null && typeof o.raw === "object" ? (o.raw as Record<string, unknown>) : undefined,
  };
}

function preview(text: string): string {
  const t = text.trim();
  if (t.length <= PREVIEW_MAX_LEN) return t;
  return t.slice(0, PREVIEW_MAX_LEN - 3) + "...";
}

async function handleInbound(payload: InboundPayload): Promise<void> {
  const { from, messageId, text, raw } = payload;

  // 1. Idempotência
  const { data: existingMsg } = await supabase
    .from("comunicacao_mensagens")
    .select("id")
    .eq("provider_message_id", messageId)
    .limit(1)
    .maybeSingle();

  if (existingMsg) return;

  // 2. Localizar ou criar conversa
  const canal = "whatsapp";
  let conversaId: string;

  const { data: existingConv } = await supabase
    .from("comunicacao_conversas")
    .select("id")
    .eq("canal", canal)
    .eq("telefone", from)
    .limit(1)
    .maybeSingle();

  if (existingConv) {
    conversaId = existingConv.id;
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from("comunicacao_conversas")
      .insert({
        canal,
        telefone: from,
        status: "aberta",
      })
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        const { data: retry } = await supabase
          .from("comunicacao_conversas")
          .select("id")
          .eq("canal", canal)
          .eq("telefone", from)
          .limit(1)
          .maybeSingle();
        if (!retry) throw insertError;
        conversaId = retry.id;
      } else {
        throw insertError;
      }
    } else {
      conversaId = inserted!.id;
    }
  }

  // 3. Inserir mensagem
  const metadata = raw ? { raw } : null;
  const { error: msgError } = await supabase.from("comunicacao_mensagens").insert({
    conversa_id: conversaId,
    direcao: "entrada",
    tipo_mensagem: "texto",
    mensagem: text,
    provider_message_id: messageId,
    metadata,
    status_envio: null,
  });

  if (msgError) throw msgError;

  // 4. Atualizar conversa
  const previewText = preview(text);
  await supabase
    .from("comunicacao_conversas")
    .update({
      ultima_mensagem_em: new Date().toISOString(),
      ultima_mensagem_preview: previewText,
    })
    .eq("id", conversaId);

  // 5. Evento opcional
  await supabase.from("comunicacao_eventos").insert({
    conversa_id: conversaId,
    tipo_evento: "mensagem_recebida",
    payload: { messageId, preview: previewText },
  });
}

/** Ordem de precedência: enviada < entregue < lida. falha é caso separado. */
function getStatusRank(s: string | null): number {
  if (!s) return 0;
  if (s === "enviada" || s === "enviando" || s === "local" || s === "mock_enviado") return 1;
  if (s === "entregue") return 2;
  if (s === "lida") return 3;
  if (s === "falha") return 0;
  return 0;
}

/** Só atualiza se o novo status for igual ou mais avançado; não regride. falha pode sobrescrever enviada/enviando. */
function shouldUpdateStatus(current: string | null, newStatus: StatusValue): boolean {
  const curRank = getStatusRank(current);
  if (newStatus === "falha") return curRank <= 1;
  const newRank = getStatusRank(newStatus);
  return newRank >= curRank;
}

/**
 * Adapter payload de status: aceita type='status' ou event='status' com provider_message_id e status.
 * status pode vir como entregue|delivered|entregue, lida|read|lida, falha|failed|falha.
 */
function parseStatusBody(body: unknown): StatusPayload {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const isStatus = o.type === "status" || o.event === "status" || o.kind === "status";
  if (!isStatus) throw new Error("Payload de status deve ter type, event ou kind igual a 'status'.");

  const pid = o.provider_message_id ?? o.message_id ?? o.id ?? "";
  const provider_message_id = String(pid).trim();
  if (!provider_message_id) throw new Error("provider_message_id obrigatorio no callback de status.");

  const rawStatus = String(o.status ?? o.delivery_status ?? "").trim().toLowerCase();
  let status: StatusValue;
  if (rawStatus === "entregue" || rawStatus === "delivered" || rawStatus === "delivery") status = "entregue";
  else if (rawStatus === "lida" || rawStatus === "read" || rawStatus === "read_at") status = "lida";
  else if (rawStatus === "falha" || rawStatus === "failed" || rawStatus === "error") status = "falha";
  else throw new Error("status invalido. Use entregue, lida ou falha.");

  return { provider_message_id, status };
}

async function handleStatusCallback(payload: StatusPayload): Promise<void> {
  const { provider_message_id, status } = payload;

  const { data: msg, error: selError } = await supabase
    .from("comunicacao_mensagens")
    .select("id, conversa_id, status_envio")
    .eq("provider_message_id", provider_message_id)
    .limit(1)
    .maybeSingle();

  if (selError || !msg) return;

  if (!shouldUpdateStatus(msg.status_envio, status)) return;

  await supabase
    .from("comunicacao_mensagens")
    .update({ status_envio: status })
    .eq("id", msg.id);

  await supabase.from("comunicacao_eventos").insert({
    conversa_id: msg.conversa_id,
    tipo_evento: "status_atualizado",
    payload: { provider_message_id, status },
  });
}

function isStatusCallback(body: unknown): boolean {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return o.type === "status" || o.event === "status" || o.kind === "status";
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Metodo permitido: POST." }, 405);
  }

  try {
    const body = await request.json();

    if (isStatusCallback(body)) {
      const payload = parseStatusBody(body);
      await handleStatusCallback(payload);
      return emptyOk();
    }

    const payload = parseInboundBody(body);
    await handleInbound(payload);
    return emptyOk();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro inesperado no webhook.";
    console.error("[webhook-whatsapp-inbound]", message, err);
    if (message.includes("obrigatorio") || message.includes("invalido") || message.includes("deve ter")) {
      return jsonResponse({ error: message }, 400);
    }
    return jsonResponse({ error: message }, 500);
  }
});
