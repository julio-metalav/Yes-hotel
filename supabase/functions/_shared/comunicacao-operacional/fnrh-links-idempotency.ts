/**
 * Idempotência de envio automático de links FNRH (por canal).
 * Manual NÃO usa esta trava — reenvio explícito do operador permanece livre.
 */

export type FnrhLinksCanal = "email" | "whatsapp";

export type FnrhLinksEnvioRegistro = {
  canal: string;
  status: string;
  hospede_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** Eventos automáticos: canal com sucesso não deve reenviar no mesmo tipo_evento. */
export function isAutomaticFnrhLinksEvent(tipoEvento: string | null | undefined): boolean {
  const t = String(tipoEvento ?? "").trim();
  if (!t || t === "manual") return false;
  return true;
}

export function isSuccessfulFnrhLinksStatus(status: string | null | undefined): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "enviada" || s === "simulado";
}

/**
 * Chave conceitual: reserva + FNRH + tipo_evento + canal.
 * Exige metadata.tipo_evento e metadata.fnrh_hospede_id alinhados.
 */
export function hasSuccessfulFnrhChannelSend(input: {
  registros: FnrhLinksEnvioRegistro[];
  tipoEvento: string;
  fnrhHospedeId: string;
  canal: FnrhLinksCanal;
  hospedeId?: string | null;
}): boolean {
  if (!isAutomaticFnrhLinksEvent(input.tipoEvento)) return false;
  const fnrhId = String(input.fnrhHospedeId ?? "").trim();
  if (!fnrhId) return false;
  const hospedeId = input.hospedeId != null ? String(input.hospedeId).trim() : "";

  for (const row of input.registros) {
    if (String(row.canal ?? "").trim() !== input.canal) continue;
    if (!isSuccessfulFnrhLinksStatus(row.status)) continue;
    if (hospedeId && row.hospede_id != null && String(row.hospede_id).trim() !== hospedeId) {
      continue;
    }
    const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as Record<
      string,
      unknown
    >;
    if (String(meta.tipo_evento ?? "").trim() !== input.tipoEvento) continue;
    if (String(meta.fnrh_hospede_id ?? "").trim() !== fnrhId) continue;
    return true;
  }
  return false;
}

/** Aplica skip de canal já entregue no plano (sem remover o outro canal). */
export function applyFnrhChannelIdempotency(input: {
  tipoEvento: string;
  fnrhHospedeId: string;
  hospedeId?: string | null;
  tryEmail: boolean;
  tryWhatsapp: boolean;
  registros: FnrhLinksEnvioRegistro[];
}): {
  tryEmail: boolean;
  tryWhatsapp: boolean;
  skipEmail: boolean;
  skipWhatsapp: boolean;
} {
  const skipEmail =
    input.tryEmail &&
    hasSuccessfulFnrhChannelSend({
      registros: input.registros,
      tipoEvento: input.tipoEvento,
      fnrhHospedeId: input.fnrhHospedeId,
      canal: "email",
      hospedeId: input.hospedeId,
    });
  const skipWhatsapp =
    input.tryWhatsapp &&
    hasSuccessfulFnrhChannelSend({
      registros: input.registros,
      tipoEvento: input.tipoEvento,
      fnrhHospedeId: input.fnrhHospedeId,
      canal: "whatsapp",
      hospedeId: input.hospedeId,
    });
  return {
    tryEmail: input.tryEmail && !skipEmail,
    tryWhatsapp: input.tryWhatsapp && !skipWhatsapp,
    skipEmail,
    skipWhatsapp,
  };
}
