/**
 * Webhook inbound (Fase 1) + callback status (Fase 3) + Meta Cloud API (Fase 4.2).
 * - GET: verificação Meta (hub.mode, hub.verify_token, hub.challenge) → 200 + challenge ou 403.
 * - POST: valida assinatura X-Hub-Signature-256 se WHATSAPP_APP_SECRET; reconhece payload Meta (object/entry) ou fallback teste (from, messageId, text / type=status).
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Fase 4.2: Webhook Meta */
const whatsappWebhookVerifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
const whatsappAppSecret = Deno.env.get("WHATSAPP_APP_SECRET");

// --- Payload interno normalizado (após adapter)
interface InboundPayload {
  from: string;
  messageId: string;
  text: string;
  raw?: Record<string, unknown>;
  /** Meta: value.contacts (para auditabilidade). */
  raw_contacts?: unknown;
  /** Origem do número usado: wa_id ou from. */
  chosen_phone_source?: "wa_id" | "from";
  /** Número efetivamente usado (já normalizado), para metadata. */
  chosen_phone?: string;
}

/** Payload interno para callback de status (Fase 3 + 4.2 enviada da Meta). */
type StatusValue = "enviada" | "entregue" | "lida" | "falha";
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
  const { from, messageId, text, raw, raw_contacts, chosen_phone_source, chosen_phone } = payload;

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

  // 3. Inserir mensagem (metadata com raw + origem do telefone para auditabilidade)
  const metadata = raw
    ? {
        raw,
        raw_message: raw,
        raw_contacts: raw_contacts ?? undefined,
        chosen_phone_source: chosen_phone_source ?? "from",
        chosen_phone: chosen_phone ?? from,
      }
    : null;
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
 * status pode vir como enviada|sent, entregue|delivered, lida|read, falha|failed.
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
  if (rawStatus === "enviada" || rawStatus === "sent") status = "enviada";
  else if (rawStatus === "entregue" || rawStatus === "delivered" || rawStatus === "delivery") status = "entregue";
  else if (rawStatus === "lida" || rawStatus === "read" || rawStatus === "read_at") status = "lida";
  else if (rawStatus === "falha" || rawStatus === "failed" || rawStatus === "error") status = "falha";
  else throw new Error("status invalido. Use enviada, entregue, lida ou falha.");

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

// --- Fase 4.2: Verificação GET da Meta (hub.mode, hub.verify_token, hub.challenge)
function handleWebhookGet(request: Request): Response | null {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) return null;
  if (!whatsappWebhookVerifyToken || token !== whatsappWebhookVerifyToken) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }
  return new Response(challenge, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/plain" },
  });
}

// --- Fase 4.2: Validação assinatura X-Hub-Signature-256 (HMAC-SHA256 do body com App Secret)
async function validateHubSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!whatsappAppSecret || !signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expectedHex = signatureHeader.slice(7).toLowerCase().trim();

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(whatsappAppSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody),
  );
  const actualHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expectedHex.length !== actualHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ actualHex.charCodeAt(i);
  }
  return diff === 0;
}

// --- Fase 4.2: Detectar payload real da Meta (object + entry)
function isMetaPayload(body: unknown): body is { object: string; entry?: unknown[] } {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return o.object === "whatsapp_business_account" && Array.isArray(o.entry);
}

// --- Fase 4.2: Mapear status Meta (sent -> enviada, delivered -> entregue, read -> lida, failed -> falha)
function metaStatusToInternal(meta: string): StatusValue | null {
  const s = String(meta).toLowerCase();
  if (s === "sent") return "enviada";
  if (s === "delivered") return "entregue";
  if (s === "read") return "lida";
  if (s === "failed") return "falha";
  return null;
}

// --- Fase 4.2: Extrair StatusPayload[] e InboundPayload[] do body Meta
function extractMetaPayloads(body: { object?: string; entry?: Array<{ changes?: Array<{ value?: Record<string, unknown> }> }> }): {
  statuses: StatusPayload[];
  inbounds: InboundPayload[];
} {
  const statuses: StatusPayload[] = [];
  const inbounds: InboundPayload[] = [];
  const entries = body.entry ?? [];

  for (const entry of entries) {
    const changes = entry.changes ?? [];
    for (const change of changes) {
      const value = change.value;
      if (!value || typeof value !== "object") continue;

      const valueStatuses = value.statuses;
      if (Array.isArray(valueStatuses)) {
        for (const st of valueStatuses) {
          const id = st?.id;
          const status = st?.status;
          if (id && typeof id === "string" && status) {
            const internal = metaStatusToInternal(String(status));
            if (internal) statuses.push({ provider_message_id: id, status: internal });
          }
        }
      }

      const valueMessages = value.messages;
      const valueContacts = value.contacts;
      if (Array.isArray(valueMessages)) {
        for (let i = 0; i < valueMessages.length; i++) {
          const msg = valueMessages[i];
          if (!msg || typeof msg !== "object") continue;
          const from = (msg as Record<string, unknown>).from;
          const id = (msg as Record<string, unknown>).id;
          const type = (msg as Record<string, unknown>).type;
          const textObj = (msg as Record<string, unknown>).text;
          const fromStr = from != null ? String(from) : "";
          const idStr = id != null ? String(id) : "";
          let text = "(mensagem sem texto)";
          if (type === "text" && textObj && typeof textObj === "object" && "body" in textObj) {
            text = String((textObj as { body?: unknown }).body ?? "").trim() || text;
          }
          if (!fromStr || !idStr) continue;
          // Preferir wa_id do contato (canônico) quando existir; fallback para message.from
          const contact = Array.isArray(valueContacts) && valueContacts[i] && typeof valueContacts[i] === "object"
            ? (valueContacts[i] as Record<string, unknown>)
            : null;
          const waId = contact?.wa_id != null ? String(contact.wa_id).trim() : "";
          let phone: string;
          let source: "wa_id" | "from";
          if (waId) {
            phone = normalizePhone(waId);
            source = "wa_id";
          } else {
            phone = normalizePhone(fromStr);
            source = "from";
          }
          inbounds.push({
            from: phone,
            messageId: idStr,
            text,
            raw: msg as Record<string, unknown>,
            raw_contacts: valueContacts ?? undefined,
            chosen_phone_source: source,
            chosen_phone: phone,
          });
        }
      }
    }
  }

  return { statuses, inbounds };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method === "GET") {
    const getResponse = handleWebhookGet(request);
    if (getResponse) return getResponse;
    return jsonResponse({ error: "GET sem parametros de verificacao ou token invalido." }, 400);
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Metodo permitido: GET (verificacao) ou POST." }, 405);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse({ error: "Falha ao ler body." }, 400);
  }

  if (whatsappAppSecret) {
    const signature = request.headers.get("X-Hub-Signature-256");
    const valid = await validateHubSignature(rawBody, signature);
    if (!valid) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }
  }

  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return jsonResponse({ error: "Body JSON invalido." }, 400);
  }

  try {
    if (isMetaPayload(body)) {
      const { statuses, inbounds } = extractMetaPayloads(body);
      for (const payload of statuses) await handleStatusCallback(payload);
      for (const payload of inbounds) await handleInbound(payload);
      return emptyOk();
    }

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
