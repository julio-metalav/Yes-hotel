/**
 * Policy pura: pendências de pagamento e FNRH obrigatórias da reserva.
 * Sem I/O — facial/placa/contato de menor não geram pendência.
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
};

export type ReservationPendingStateResult = {
  payment_pending: boolean;
  fnrh_pending: boolean;
  pending_reasons: string[];
  all_clear: boolean;
  fnrh_summary: {
    required: number;
    completed: number;
    pending: number;
  };
};

function isPaymentConfirmed(status: PaymentStatusPending): boolean {
  return status === "pago";
}

function isFnrhCompletedForGuest(guest: ExpectedGuestFnrhInput): boolean {
  if (guest.fnrh_status !== "completed") {
    return false;
  }

  if (guest.role === "menor") {
    // Menor: ficha obrigatória preenchida e confirmada pelo responsável.
    // Telefone/e-mail/confirmação individual do menor NÃO entram na pendência.
    return guest.completed_by_guardian === true;
  }

  // Adultos: ficha concluída (facial/placa opcionais ignorados).
  return true;
}

/**
 * Avalia pendências relevantes para o fluxo de primeiro acesso / tolerância.
 * Não consulta banco — recebe estado já montado.
 */
export function evaluateReservationPendingState(
  input: ReservationPendingStateInput,
): ReservationPendingStateResult {
  const payment_pending = !isPaymentConfirmed(input.payment_status);
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
    else if (input.payment_status === "desconhecido") pending_reasons.push("pagamento_desconhecido");
    else if (input.payment_status === "emergencial") pending_reasons.push("pagamento_pendente");
    else pending_reasons.push("pagamento");
  }
  if (fnrh_pending) {
    pending_reasons.push("fnrh");
  }

  return {
    payment_pending,
    fnrh_pending,
    pending_reasons,
    all_clear: !payment_pending && !fnrh_pending,
    fnrh_summary: {
      required,
      completed,
      pending,
    },
  };
}
