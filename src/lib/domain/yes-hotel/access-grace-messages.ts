/**
 * Templates de mensagem do fluxo de tolerância pós-primeiro-acesso.
 * Sem I/O e sem termos técnicos (TTLock, etc.).
 */

export type AccessGraceMessageKind =
  | "welcome_payment_only"
  | "welcome_fnrh_only"
  | "welcome_payment_and_fnrh"
  | "access_restored";

export type BuildAccessGraceMessageInput = {
  payment_pending: boolean;
  fnrh_pending: boolean;
};

const MSG_PAYMENT_ONLY =
  "Bem-vindo ao Yes Hotel. O pagamento da sua reserva ainda está pendente. Regularize em até 1 hora para evitar a suspensão temporária das senhas de acesso ao quarto e aos portões.";

const MSG_FNRH_ONLY =
  "Bem-vindo ao Yes Hotel. Ainda existem fichas de hóspedes pendentes nesta reserva. Regularize em até 1 hora para evitar a suspensão temporária das senhas de acesso ao quarto e aos portões.";

const MSG_BOTH =
  "Bem-vindo ao Yes Hotel. O pagamento e o preenchimento das fichas de hóspedes ainda estão pendentes. Regularize em até 1 hora para evitar a suspensão temporária das senhas de acesso ao quarto e aos portões.";

const MSG_RESTORED =
  "As pendências da sua reserva foram regularizadas e seus acessos foram restabelecidos.";

export type AccessGraceMessage = {
  kind: AccessGraceMessageKind;
  body: string;
};

/**
 * Gera texto de boas-vindas com pendências. Retorna null se não houver pendência.
 */
export function buildWelcomePendingMessage(
  input: BuildAccessGraceMessageInput,
): AccessGraceMessage | null {
  if (!input.payment_pending && !input.fnrh_pending) {
    return null;
  }
  if (input.payment_pending && input.fnrh_pending) {
    return { kind: "welcome_payment_and_fnrh", body: MSG_BOTH };
  }
  if (input.payment_pending) {
    return { kind: "welcome_payment_only", body: MSG_PAYMENT_ONLY };
  }
  return { kind: "welcome_fnrh_only", body: MSG_FNRH_ONLY };
}

export function buildAccessRestoredMessage(): AccessGraceMessage {
  return { kind: "access_restored", body: MSG_RESTORED };
}

/** Garante que o texto não vaze jargão técnico. */
export function assertMessageHasNoTechnicalJargon(body: string): void {
  const forbidden = [/ttlock/i, /sciener/i, /keyboardPwd/i, /lockId/i, /gateway/i];
  for (const re of forbidden) {
    if (re.test(body)) {
      throw new Error(`Mensagem contém termo técnico proibido: ${re}`);
    }
  }
}
