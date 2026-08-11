/**
 * Policy pura: pendências de pagamento e FNRH obrigatórias da reserva.
 * Sem I/O — facial/placa/contato de menor não geram pendência.
 *
 * Pagamento desconhecido NÃO é pendência confirmada:
 * - payment_pending=false
 * - payment_unknown=true
 * - não inicia tolerância sozinho
 * - não suspende (fail-safe no processador)
 */

export type PaymentStatusPending =
  | "pago"
  | "pendente"
  | "desconhecido"
  | "parcial"
  | "emergencial";

export type FnrhCompletionStatus =
  | "completed"
  | "pending"
  | "review"
  | "not_started"
  | "draft";

export type GuestRoleForFnrh = "principal_adulto" | "acompanhante_adulto" | "menor";

export type ExpectedGuestFnrhInput = {
  id: string;
  role: GuestRoleForFnrh;
  /** Ficha FNRH obrigatória concluída (pelo próprio adulto ou pelo responsável no caso de menor). */
  fnrh_status: FnrhCompletionStatus;
  /** Confirmação individual do hóspede (só relevante para adultos). */
  individual_confirmation?: boolean;
  has_phone?: boolean;
  has_email?: boolean;
  has_facial?: boolean;
  has_placa?: boolean;
  /** Responsável que preencheu a ficha do menor (quando aplicável). */
  completed_by_guardian?: boolean;
};

export type ReservationPendingStateInput = {
  payment_status: PaymentStatusPending;
  /**
   * Acesso emergencial / liberação manual de senha com pendências.
   * Nunca elimina pendência financeira.
   */
  emergency_access?: boolean;
  manual_access_release?: boolean;
  guests: ExpectedGuestFnrhInput[];
  /**
   * Autorização operacional de pagamento presencial diferido (NÃO é pago).
   * Usado só na decisão de prazo de tolerância no 1º acesso.
   */
  pagamento_presencial_diferido_autorizado?: boolean;
  pagamento_presencial_diferido_efetivado?: boolean;
};

export type ReservationPendingStateResult = {
  payment_pending: boolean;
  /** Pagamento não confirmado pela origem — fail-safe; não inicia tolerância sozinho. */
  payment_unknown: boolean;
  fnrh_pending: boolean;
  pending_reasons: string[];
  all_clear: boolean;
  fnrh_summary: {
    required: number;
    completed: number;
    pending: number;
  };
};

function isFnrhCompletedForGuest(guest: ExpectedGuestFnrhInput): boolean {
  if (guest.fnrh_status !== "completed") {
    return false;
  }

  if (guest.role === "menor") {
    return guest.completed_by_guardian === true;
  }

  return true;
}

function mapPaymentFlags(status: PaymentStatusPending): {
  payment_pending: boolean;
  payment_unknown: boolean;
} {
  if (status === "pago") return { payment_pending: false, payment_unknown: false };
  if (status === "pendente" || status === "parcial" || status === "emergencial") {
    return { payment_pending: true, payment_unknown: false };
  }
  // desconhecido (e qualquer valor não confirmado tratado como fail-safe)
  return { payment_pending: false, payment_unknown: true };
}

/**
 * Avalia pendências relevantes para o fluxo de primeiro acesso / tolerância.
 * Não consulta banco — recebe estado já montado.
 *
 * Tolerância inicia com: payment_pending || fnrh_pending
 * (payment_unknown sozinho NÃO inicia).
 */
export function evaluateReservationPendingState(
  input: ReservationPendingStateInput,
): ReservationPendingStateResult {
  const { payment_pending, payment_unknown } = mapPaymentFlags(input.payment_status);
  // emergency_access / manual_access_release não alteram payment_pending.

  const requiredGuests = input.guests;
  let completed = 0;
  let pending = 0;

  for (const guest of requiredGuests) {
    if (isFnrhCompletedForGuest(guest)) {
      completed += 1;
    } else {
      pending += 1;
    }
  }

  const required = requiredGuests.length;
  const fnrh_pending = pending > 0;

  const pending_reasons: string[] = [];
  if (payment_pending) {
    if (input.payment_status === "parcial") pending_reasons.push("pagamento_parcial");
    else if (input.payment_status === "emergencial") pending_reasons.push("pagamento_pendente");
    else pending_reasons.push("pagamento");
  }
  if (payment_unknown) {
    pending_reasons.push("pagamento_desconhecido");
  }
  if (fnrh_pending) {
    pending_reasons.push("fnrh");
  }

  return {
    payment_pending,
    payment_unknown,
    fnrh_pending,
    pending_reasons,
    // all_clear: sem pendência confirmada de pagamento/FNRH (desconhecido não bloqueia).
    all_clear: !payment_pending && !fnrh_pending,
    fnrh_summary: {
      required,
      completed,
      pending,
    },
  };
}
