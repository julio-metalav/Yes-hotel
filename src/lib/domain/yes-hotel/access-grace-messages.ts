/**
 * Templates do ciclo pós-primeiro-acesso / tolerância / suspensão.
 * Sem I/O e sem termos técnicos (TTLock, etc.).
 */

export type AccessGraceMessageKind =
  | "welcome_payment_only"
  | "welcome_fnrh_only"
  | "welcome_payment_and_fnrh"
  | "access_restored"
  | "access_suspended"
  | "technical_failure"
  | "internal_first_access";

export type BuildAccessGraceMessageInput = {
  payment_pending: boolean;
  fnrh_pending: boolean;
  /** Quando true: prazo especial até 09:00 (não usa texto de 1 hora). */
  presencial_diferido_efetivado?: boolean;
};

const MSG_PAYMENT_ONLY =
  "Bem-vindo ao Yes Hotel. O pagamento da sua reserva ainda está pendente. Regularize em até 1 hora para evitar a suspensão temporária das senhas de acesso ao quarto e aos portões.";

const MSG_FNRH_ONLY =
  "Bem-vindo ao Yes Hotel. Ainda existem fichas de hóspedes pendentes nesta reserva. Regularize em até 1 hora para evitar a suspensão temporária das senhas de acesso ao quarto e aos portões.";

const MSG_BOTH =
  "Bem-vindo ao Yes Hotel. O pagamento e o preenchimento das fichas de hóspedes ainda estão pendentes. Regularize em até 1 hora para evitar a suspensão temporária das senhas de acesso ao quarto e aos portões.";

const MSG_RESTORED =
  "As pendências da sua reserva foram regularizadas e seus acessos foram restabelecidos.";

const MSG_SUSPENDED =
  "As senhas de acesso ao quarto e aos portões foram suspensas temporariamente porque ainda há pendências na reserva. Regularize o pagamento e as fichas de hóspedes para restabelecer o acesso.";

const MSG_TECHNICAL =
  "Não foi possível concluir uma atualização automática do seu acesso. Por favor, fale com a recepção do Yes Hotel.";

export type AccessGraceMessage = {
  kind: AccessGraceMessageKind;
  body: string;
};

/**
 * Gera texto de pendências pós-welcome (tolerância 1h / FNRH).
 * Quando PPD está efetivado, a cobrança presencial vai em
 * guest_payment_deferred_breakfast — não misturar aqui.
 * Retorna null se não houver pendência a tratar neste template.
 */
export function buildWelcomePendingMessage(
  input: BuildAccessGraceMessageInput,
): AccessGraceMessage | null {
  const paymentForThisTemplate =
    input.payment_pending && !input.presencial_diferido_efetivado;
  if (!paymentForThisTemplate && !input.fnrh_pending) {
    return null;
  }
  if (paymentForThisTemplate && input.fnrh_pending) {
    return { kind: "welcome_payment_and_fnrh", body: MSG_BOTH };
  }
  if (paymentForThisTemplate) {
    return { kind: "welcome_payment_only", body: MSG_PAYMENT_ONLY };
  }
  return { kind: "welcome_fnrh_only", body: MSG_FNRH_ONLY };
}

export function buildAccessRestoredMessage(): AccessGraceMessage {
  return { kind: "access_restored", body: MSG_RESTORED };
}

export function buildAccessSuspendedMessage(): AccessGraceMessage {
  return { kind: "access_suspended", body: MSG_SUSPENDED };
}

export function buildTechnicalFailureMessage(): AccessGraceMessage {
  return { kind: "technical_failure", body: MSG_TECHNICAL };
}

export type BuildInternalFirstAccessMessageInput = {
  apartment_number: string;
  reservation_code: string;
  guest_main_name: string;
  payment_pending: boolean;
  fnrh_pending: boolean;
  grace_started: boolean;
  /** Exceção efetiva: não usa tolerância padrão de 1h. */
  presencial_diferido_efetivado?: boolean;
  /**
   * Label de valor já resolvido (ex.: "R$ 420,00" ou "confirmar no HITS").
   * Nunca inventar na UI — resolver antes com resolvePpdChargeAmount.
   */
  charge_valor_label?: string | null;
};

/**
 * Mensagem interna DigiSac (recepção). Sem senha, IDs técnicos ou documentos.
 */
export function buildInternalFirstAccessMessage(
  input: BuildInternalFirstAccessMessageInput,
): AccessGraceMessage {
  const apt = String(input.apartment_number || "").trim() || "—";
  const res = String(input.reservation_code || "").trim() || "—";
  const guest = String(input.guest_main_name || "").trim() || "hóspede";
  const pendencias: string[] = [];
  if (input.payment_pending) pendencias.push("pagamento");
  if (input.fnrh_pending) pendencias.push("FNRH");

  let body: string;
  if (pendencias.length === 0) {
    body = `Hóspede entrou no apto ${apt}. Reserva ${res}, ${guest}. Sem pendências.`;
  } else if (input.presencial_diferido_efetivado && input.payment_pending) {
    const valor =
      String(input.charge_valor_label || "").trim() || "confirmar no HITS";
    body =
      `Apto ${apt} — ${guest} entrou no apartamento. ` +
      "Pagamento presencial diferido ativo. " +
      "Cobrar até 09h no café da manhã. " +
      `Valor: ${valor}. ` +
      "Após receber, regularizar no HITS.";
    if (input.fnrh_pending) {
      body += " FNRH ainda pendente.";
    }
  } else {
    const list = pendencias.join(" e ");
    body = `Hóspede entrou no apto ${apt}. Reserva ${res}, ${guest}. Pendências: ${list}.`;
    if (input.grace_started) {
      body += " Tolerância de 1 hora iniciada.";
    }
  }

  return { kind: "internal_first_access", body };
}

/** Garante que o texto não vaze jargão técnico. */
export function assertMessageHasNoTechnicalJargon(body: string): void {
  const forbidden = [/ttlock/i, /sciener/i, /keyboardPwd/i, /lockId/i, /gateway/i, /remote_keyboard/i];
  for (const re of forbidden) {
    if (re.test(body)) {
      throw new Error(`Mensagem contém termo técnico proibido: ${re}`);
    }
  }
}
