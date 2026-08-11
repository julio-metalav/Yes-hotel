/**
 * Política global: comunicação AO HÓSPEDE tenta e-mail e WhatsApp
 * de forma independente quando ambos os contatos são válidos.
 * Sucesso em um canal NÃO impede tentativa no outro.
 *
 * Mensagens internas à equipe NÃO usam esta regra.
 */

export type GuestChannelKind = "email" | "whatsapp";

/** Resultado por canal após tentativa (ou ausência de contato). */
export type GuestChannelStatus = "enviado" | "falhou" | "indisponivel";

export type GuestChannelPlan = {
  tryEmail: boolean;
  tryWhatsapp: boolean;
};

export type GuestChannelAttempt = {
  status: GuestChannelStatus;
  error?: string | null;
};

export type GuestMultichannelAggregate = {
  email: GuestChannelStatus;
  whatsapp: GuestChannelStatus;
  /** true se pelo menos um canal entregou */
  delivered: boolean;
  /** true só se houve tentativa e nenhum canal entregou */
  failedTotal: boolean;
  emailOk: boolean;
  whatsappOk: boolean;
  /** Valor sugerido para operacional_hospedes.ultimo_envio_canal */
  ultimoEnvioCanal: "email" | "whatsapp" | "ambos" | null;
  errors: string[];
};

export type GuestCommunicationAudience = "hospede" | "interno";

/**
 * Contato válido = string não vazia após trim.
 * Não inventa contatos.
 */
export function hasValidGuestContact(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Planeja canais para comunicação AO HÓSPEDE.
 * Interno → nenhum canal de hóspede (caller não deve usar este helper).
 */
export function planGuestChannels(
  email: string | null | undefined,
  whatsapp: string | null | undefined,
  audience: GuestCommunicationAudience = "hospede",
): GuestChannelPlan {
  if (audience !== "hospede") {
    return { tryEmail: false, tryWhatsapp: false };
  }
  return {
    tryEmail: hasValidGuestContact(email),
    tryWhatsapp: hasValidGuestContact(whatsapp),
  };
}

/**
 * Agrega resultados independentes por canal.
 * Partial success (um ok, outro falha) => delivered=true.
 */
export function aggregateGuestChannelResults(
  emailAttempt: GuestChannelAttempt | null | undefined,
  whatsappAttempt: GuestChannelAttempt | null | undefined,
): GuestMultichannelAggregate {
  const email: GuestChannelStatus = emailAttempt?.status ?? "indisponivel";
  const whatsapp: GuestChannelStatus = whatsappAttempt?.status ?? "indisponivel";
  const emailOk = email === "enviado";
  const whatsappOk = whatsapp === "enviado";
  const delivered = emailOk || whatsappOk;

  const triedSomething =
    (emailAttempt != null && email !== "indisponivel") ||
    (whatsappAttempt != null && whatsapp !== "indisponivel");

  const failedTotal = triedSomething && !delivered;

  let ultimoEnvioCanal: GuestMultichannelAggregate["ultimoEnvioCanal"] = null;
  if (emailOk && whatsappOk) ultimoEnvioCanal = "ambos";
  else if (emailOk) ultimoEnvioCanal = "email";
  else if (whatsappOk) ultimoEnvioCanal = "whatsapp";

  const errors: string[] = [];
  if (email === "falhou" && emailAttempt?.error) errors.push(String(emailAttempt.error));
  if (whatsapp === "falhou" && whatsappAttempt?.error) {
    errors.push(String(whatsappAttempt.error));
  }

  return {
    email,
    whatsapp,
    delivered,
    failedTotal,
    emailOk,
    whatsappOk,
    ultimoEnvioCanal,
    errors,
  };
}

/**
 * Garante que o mesmo recurso de negócio (link/senha) é reutilizado nos dois canais.
 * Não cria recurso novo — apenas valida igualdade.
 */
export function assertSameGuestResource(
  resourceEmail: string | null | undefined,
  resourceWhatsapp: string | null | undefined,
): boolean {
  const a = (resourceEmail ?? "").trim();
  const b = (resourceWhatsapp ?? "").trim();
  if (!a || !b) return true;
  return a === b;
}

/** Short-circuit proibido para hóspede: sucesso e-mail NÃO deve pular WhatsApp. */
export function shouldAttemptWhatsappAfterEmail(
  plan: GuestChannelPlan,
  _emailSucceeded: boolean,
): boolean {
  return plan.tryWhatsapp;
}

/** Short-circuit proibido: sucesso WhatsApp NÃO deve pular e-mail. */
export function shouldAttemptEmailAfterWhatsapp(
  plan: GuestChannelPlan,
  _whatsappSucceeded: boolean,
): boolean {
  return plan.tryEmail;
}
