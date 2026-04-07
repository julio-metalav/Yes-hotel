import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { OperacionalComunicacaoEnvioInsert } from "./types.ts";

export async function registrarOperacionalComunicacaoEnvio(
  admin: SupabaseClient,
  row: OperacionalComunicacaoEnvioInsert,
): Promise<void> {
  const { error } = await admin.from("operacional_comunicacao_envios").insert({
    reserva_id: row.reserva_id ?? null,
    conversa_id: row.conversa_id ?? null,
    hospede_id: row.hospede_id ?? null,
    proposito: row.proposito,
    canal: row.canal,
    destinatario_mascara: row.destinatario_mascara,
    corpo_preview: row.corpo_preview,
    status: row.status,
    provider: row.provider,
    provider_message_id: row.provider_message_id ?? null,
    metadata: row.metadata ?? null,
    erro: row.erro ?? null,
  });
  if (error && typeof console !== "undefined") {
    console.warn("[comunicacao-operacional] registrarOperacionalComunicacaoEnvio", error.message);
  }
}

export function previewCorpo(text: string, max = 200): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 3) + "...";
}

export function maskEmailForLog(email: string): string {
  const e = email.trim();
  const at = e.indexOf("@");
  if (at <= 0) return "***";
  if (at === 1) return `*${e.slice(at)}`;
  return `${e[0]}***${e.slice(at - 1)}`;
}
