import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { readDigisacEnv, sendDigisacMessage, maskPhoneForLog, normalizePhoneDigits } from "./digisac-provider.ts";
import { registrarOperacionalComunicacaoEnvio, previewCorpo } from "./registro-envio.ts";
import type { ComunicacaoProposito } from "./types.ts";

const PREVIEW_MAX = 80;

export type OutboundWhatsappConversaResult = {
  ok: boolean;
  error?: string;
  messageId?: string;
  provider_message_id?: string | null;
  /** Valor gravado em comunicacao_mensagens.status_envio */
  status_envio_gravado: "mock_enviado" | "enviada" | "falha";
  transporte: "digisac_stub" | "digisac";
};

/**
 * Envio WhatsApp operacional para conversa existente (central de comunicação).
 * Persiste comunicacao_mensagens + operacional_comunicacao_envios.
 */
export async function outboundWhatsappParaConversa(
  admin: SupabaseClient,
  params: { conversaId: string; text: string; proposito: ComunicacaoProposito },
): Promise<OutboundWhatsappConversaResult> {
  const { data: conv, error: convError } = await admin
    .from("comunicacao_conversas")
    .select("id, canal, telefone, reserva_id, hospede_id")
    .eq("id", params.conversaId)
    .maybeSingle();

  if (convError || !conv) {
    return {
      ok: false,
      error: "Conversa não encontrada.",
      status_envio_gravado: "falha",
      transporte: "digisac_stub",
    };
  }
  if (conv.canal !== "whatsapp") {
    return {
      ok: false,
      error: "Canal da conversa deve ser whatsapp.",
      status_envio_gravado: "falha",
      transporte: "digisac_stub",
    };
  }
  const telefone = String(conv.telefone || "").trim();
  if (!telefone) {
    return {
      ok: false,
      error: "Conversa sem telefone.",
      status_envio_gravado: "falha",
      transporte: "digisac_stub",
    };
  }

  const cfg = readDigisacEnv();
  const previewText = previewCorpo(params.text, PREVIEW_MAX);

  const { data: msg, error: insertError } = await admin
    .from("comunicacao_mensagens")
    .insert({
      conversa_id: params.conversaId,
      direcao: "saida",
      tipo_mensagem: "texto",
      mensagem: params.text,
      status_envio: "enviando",
    })
    .select("id, created_at")
    .single();

  if (insertError || !msg) {
    return {
      ok: false,
      error: insertError?.message ?? "Falha ao gravar mensagem.",
      status_envio_gravado: "falha",
      transporte: "digisac_stub",
    };
  }

  const digi = await sendDigisacMessage(cfg, { telefoneRaw: telefone, text: params.text });
  const mask = maskPhoneForLog(normalizePhoneDigits(telefone));

  let statusGravado: "mock_enviado" | "enviada" | "falha" = "falha";
  if (digi.ok) {
    statusGravado = digi.provider_used === "digisac_stub" ? "mock_enviado" : "enviada";
    await admin
      .from("comunicacao_mensagens")
      .update({
        status_envio: statusGravado,
        provider_message_id: digi.provider_message_id ?? null,
        metadata: { provider: digi.provider_used, canal_operacional: "digisac" },
      })
      .eq("id", msg.id);
  } else {
    await admin
      .from("comunicacao_mensagens")
      .update({
        status_envio: "falha",
        metadata: { error: digi.error ?? "Falha DigiSac.", provider: digi.provider_used },
      })
      .eq("id", msg.id);
  }

  await admin
    .from("comunicacao_conversas")
    .update({
      ultima_mensagem_em: msg.created_at,
      ultima_mensagem_preview: previewText,
    })
    .eq("id", params.conversaId);

  const statusRegistro = digi.ok
    ? (digi.provider_used === "digisac_stub" ? "simulado" as const : "enviada" as const)
    : "falha" as const;

  await registrarOperacionalComunicacaoEnvio(admin, {
    reserva_id: conv.reserva_id,
    conversa_id: conv.id,
    hospede_id: conv.hospede_id,
    proposito: params.proposito,
    canal: "whatsapp",
    destinatario_mascara: mask,
    corpo_preview: previewCorpo(params.text),
    status: statusRegistro,
    provider: digi.provider_used === "digisac_stub" ? "digisac_stub" : "digisac",
    provider_message_id: digi.provider_message_id ?? null,
    metadata: { conversa_id: params.conversaId, message_row_id: msg.id },
    erro: digi.ok ? null : digi.error ?? null,
  });

  return {
    ok: digi.ok,
    error: digi.error,
    messageId: msg.id,
    provider_message_id: digi.provider_message_id ?? null,
    status_envio_gravado: statusGravado,
    transporte: digi.provider_used === "digisac_stub" ? "digisac_stub" : "digisac",
  };
}

/**
 * Localiza ou cria conversa WhatsApp por (canal, telefone) — índice único 0013.
 */
async function findOrCreateConversaWhatsappTransacional(
  admin: SupabaseClient,
  params: { telefoneDigits: string; reservaId: string; hospedeId: string },
): Promise<{ conversaId: string | null; error: string | null }> {
  const { telefoneDigits, reservaId, hospedeId } = params;
  const { data: found, error: selErr } = await admin
    .from("comunicacao_conversas")
    .select("id")
    .eq("canal", "whatsapp")
    .eq("telefone", telefoneDigits)
    .maybeSingle();
  if (selErr) {
    return { conversaId: null, error: selErr.message };
  }
  if (found?.id) {
    return { conversaId: found.id, error: null };
  }
  const { data: created, error: insErr } = await admin
    .from("comunicacao_conversas")
    .insert({
      canal: "whatsapp",
      telefone: telefoneDigits,
      reserva_id: reservaId,
      hospede_id: hospedeId,
      status: "aberta",
    })
    .select("id")
    .single();
  if (!insErr && created?.id) {
    return { conversaId: created.id, error: null };
  }
  const code = (insErr as { code?: string } | null)?.code ?? "";
  const msg = insErr?.message ?? "";
  if (code === "23505" || msg.toLowerCase().includes("duplicate")) {
    const { data: retry, error: retryErr } = await admin
      .from("comunicacao_conversas")
      .select("id")
      .eq("canal", "whatsapp")
      .eq("telefone", telefoneDigits)
      .maybeSingle();
    if (retryErr) return { conversaId: null, error: retryErr.message };
    if (retry?.id) return { conversaId: retry.id, error: null };
  }
  return { conversaId: null, error: insErr?.message ?? "insert comunicacao_conversas falhou" };
}

/**
 * WhatsApp transacional (FNRH, senha): DigiSac + trilha em comunicacao_* (mesmo padrão de outboundWhatsappParaConversa).
 */
export async function outboundWhatsappTransacional(
  admin: SupabaseClient,
  params: {
    reservaId: string;
    hospedeId: string;
    telefoneRaw: string;
    text: string;
    proposito: ComunicacaoProposito;
    /** Metadados extras (ex.: tipo_evento / fnrh_hospede_id para idempotência). */
    metadataExtra?: Record<string, unknown> | null;
  },
): Promise<{ ok: boolean; error?: string; provider_message_id?: string }> {
  const telefoneDigits = normalizePhoneDigits(params.telefoneRaw);
  const mask = maskPhoneForLog(telefoneDigits);
  const previewText = previewCorpo(params.text, PREVIEW_MAX);
  const cfg = readDigisacEnv();

  const { conversaId, error: convErr } = telefoneDigits
    ? await findOrCreateConversaWhatsappTransacional(admin, {
      telefoneDigits,
      reservaId: params.reservaId,
      hospedeId: params.hospedeId,
    })
    : { conversaId: null as string | null, error: "telefone sem dígitos" };

  if (!telefoneDigits && typeof console !== "undefined") {
    console.warn("[comunicacao-operacional] transacional: telefone sem dígitos; inbox omitido");
  } else if (!conversaId && typeof console !== "undefined") {
    console.warn(
      "[comunicacao-operacional] transacional: conversa inbox não disponível; DigiSac segue. Motivo:",
      convErr ?? "desconhecido",
    );
  }

  let msgRowId: string | null = null;
  let msgCreatedAt: string | null = null;
  if (conversaId) {
    const { data: msg, error: msgInsErr } = await admin
      .from("comunicacao_mensagens")
      .insert({
        conversa_id: conversaId,
        direcao: "saida",
        tipo_mensagem: "texto",
        mensagem: params.text,
        status_envio: "enviando",
      })
      .select("id, created_at")
      .single();
    if (msgInsErr || !msg) {
      if (typeof console !== "undefined") {
        console.warn(
          "[comunicacao-operacional] transacional: insert comunicacao_mensagens falhou:",
          msgInsErr?.message ?? "sem id",
        );
      }
    } else {
      msgRowId = msg.id;
      msgCreatedAt = typeof msg.created_at === "string" ? msg.created_at : null;
    }
  }

  const digi = await sendDigisacMessage(cfg, { telefoneRaw: params.telefoneRaw, text: params.text });

  if (conversaId && msgRowId) {
    if (digi.ok) {
      const statusGravado = digi.provider_used === "digisac_stub" ? "mock_enviado" : "enviada";
      await admin
        .from("comunicacao_mensagens")
        .update({
          status_envio: statusGravado,
          provider_message_id: digi.provider_message_id ?? null,
          metadata: {
            provider: digi.provider_used,
            canal_operacional: "digisac",
            proposito: params.proposito,
          },
        })
        .eq("id", msgRowId);
      await admin
        .from("comunicacao_conversas")
        .update({
          ultima_mensagem_em: msgCreatedAt ?? new Date().toISOString(),
          ultima_mensagem_preview: previewText,
        })
        .eq("id", conversaId);
    } else {
      await admin
        .from("comunicacao_mensagens")
        .update({
          status_envio: "falha",
          metadata: {
            error: digi.error ?? "Falha DigiSac.",
            provider: digi.provider_used,
            proposito: params.proposito,
          },
        })
        .eq("id", msgRowId);
    }
  } else if (digi.ok && typeof console !== "undefined") {
    console.warn(
      "[comunicacao-operacional] transacional: DigiSac OK mas inbox incompleto (conversa=" +
        Boolean(conversaId) +
        " mensagem=" +
        Boolean(msgRowId) +
        ")",
    );
  }

  const statusRegistro = digi.ok
    ? (digi.provider_used === "digisac_stub" ? "simulado" as const : "enviada" as const)
    : "falha" as const;

  await registrarOperacionalComunicacaoEnvio(admin, {
    reserva_id: params.reservaId,
    conversa_id: conversaId,
    hospede_id: params.hospedeId,
    proposito: params.proposito,
    canal: "whatsapp",
    destinatario_mascara: mask,
    corpo_preview: previewCorpo(params.text),
    status: statusRegistro,
    provider: digi.provider_used === "digisac_stub" ? "digisac_stub" : "digisac",
    provider_message_id: digi.provider_message_id ?? null,
    metadata: {
      fluxo: "transacional",
      message_row_id: msgRowId,
      inbox_ok: Boolean(conversaId && msgRowId),
      ...(params.metadataExtra && typeof params.metadataExtra === "object"
        ? params.metadataExtra
        : {}),
    },
    erro: digi.ok ? null : digi.error ?? null,
  });

  if (digi.ok) {
    return { ok: true, provider_message_id: digi.provider_message_id };
  }
  return { ok: false, error: digi.error };
}
