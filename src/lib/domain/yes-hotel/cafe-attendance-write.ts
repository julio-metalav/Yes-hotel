/**
 * Fronteira de escrita do atendimento do café (espelho da RPC
 * `operacional_cafe_set_atendimento`).
 *
 * O cliente NÃO pode fornecer cafe_kind, quantidade_direito nem avulso pago.
 * O direito vem exclusivamente da reserva persistida / sincronizada do HITS.
 */

import {
  type CafeBreakfastEntitlement,
  resolveCafeBreakfastEntitlementFromHits,
} from "./cafe-breakfast-entitlement.ts";
import { canRegisterCafeAttendanceForDate } from "./cafe-operational-date.ts";
import { canRoleWriteCafeAttendance } from "./cafe-attendance-policy.ts";

export type CafeAttendanceWriteAction =
  | "set"
  | "increment"
  | "decrement"
  | "marcar_todos";

/** Campos persistidos em operacional_reservas usados pelo servidor. */
export type PersistedCafeReservationForEntitlement = {
  statusReserva: string;
  totalHospedesHits: number | null;
  mealPlanDesc: string | null;
  /**
   * Quantidade oficial de avulso pago sincronizada do HITS.
   * Até homologação do contrato, permanece 0 / ausente no sync.
   * Nunca aceitar valor vindo do navegador.
   */
  cafeAvulsoPagoQtd: number | null;
};

/**
 * Pedido do cliente — somente identidade da reserva, data e quantidade/ação.
 * Qualquer claim de direito no payload é ignorado de propósito.
 */
export type CafeAttendanceWriteRequest = {
  cafeDateYmd: string;
  operacionalReservaId: string;
  quantidadeAtendida?: number | null;
  acao: CafeAttendanceWriteAction;
  /** Claims adulterados do navegador — devem ser ignorados. */
  forgedCafeKind?: string | null;
  forgedQuantidadeDireito?: number | null;
  forgedAvulsoPago?: number | null;
};

export type CafeAttendanceWriteResult =
  | {
      ok: true;
      previousQty: number;
      nextQty: number;
      entitlement: CafeBreakfastEntitlement;
    }
  | { ok: false; error: string };

/**
 * Resolve o direito oficial a partir dos dados persistidos.
 * Sem mapeamento homologado de meal_plan_desc → sempre nao_mapeado.
 * Não interpreta texto ("Cafe da manha" etc.).
 * Avulso só contaria se houver quantidade oficial sincronizada E classificação
 * homologada; enquanto o contrato HITS não estiver homologado, avulso não libera.
 */
export function resolveCafeEntitlementFromPersistedReservation(
  reservation: PersistedCafeReservationForEntitlement,
): CafeBreakfastEntitlement {
  const guestCount = Math.max(0, Number(reservation.totalHospedesHits) || 0);
  // cafeAvulsoPagoQtd é lido do persistido apenas para auditoria futura;
  // sem mapeamento oficial, não altera a classificação.
  void reservation.cafeAvulsoPagoQtd;

  return resolveCafeBreakfastEntitlementFromHits({
    guestCount,
    mealPlanDesc: reservation.mealPlanDesc,
    // Não passar paidExtraQtyFromHits até o sync oficial estar homologado.
  });
}

/**
 * Simula a autorização + cálculo atômico da RPC (sem I/O).
 * Usado para provar que claims do cliente não alteram o direito.
 */
export function applyCafeAttendanceWrite(input: {
  role: string | null | undefined;
  reservation: PersistedCafeReservationForEntitlement;
  request: CafeAttendanceWriteRequest;
  previousQty?: number;
  now?: Date;
  /**
   * Estado do serviço da data, lido no servidor.
   * Concluído recusa qualquer lançamento — inclusive marcar_todos.
   */
  dayStatus?: "aberto" | "concluido" | null;
  /**
   * Somente testes de regressão da máquina de estados quando o direito
   * já foi resolvido server-side (ex.: após futura homologação).
   * Em produção a RPC resolve sempre via resolveCafeEntitlementFromPersistedReservation.
   */
  serverEntitlementOverride?: CafeBreakfastEntitlement;
}): CafeAttendanceWriteResult {
  // Claims do navegador são deliberadamente descartados.
  void input.request.forgedCafeKind;
  void input.request.forgedQuantidadeDireito;
  void input.request.forgedAvulsoPago;

  if (!canRoleWriteCafeAttendance(input.role)) {
    return { ok: false, error: "cafe_write_forbidden_role" };
  }

  if (!canRegisterCafeAttendanceForDate(input.request.cafeDateYmd, input.now)) {
    return { ok: false, error: "cafe_write_forbidden_future_date" };
  }

  // Serviço encerrado não recebe mais lançamento. Só admin reabre, e a
  // reabertura é uma RPC própria — nunca um efeito colateral de gravar.
  if (input.dayStatus === "concluido") {
    return { ok: false, error: "cafe_write_forbidden_dia_concluido" };
  }

  if (String(input.reservation.statusReserva || "").trim().toLowerCase() === "cancelada") {
    return { ok: false, error: "cafe_reservation_cancelled" };
  }

  const entitlement =
    input.serverEntitlementOverride ??
    resolveCafeEntitlementFromPersistedReservation(input.reservation);

  // O direito é REGISTRO, não teto: enquanto meal_plan_desc não estiver
  // homologado ele vale 0 e o operador ainda precisa contar quem tomou café.
  // Espelha a migration 20260928090000_cafe_controle_operacional.
  const previousQty = Math.max(0, Math.trunc(Number(input.previousQty) || 0));
  const entitled = Math.max(0, entitlement.entitledQty);
  const acao = input.request.acao;

  let nextQty: number;
  if (acao === "increment") {
    nextQty = previousQty + 1;
  } else if (acao === "decrement") {
    nextQty = Math.max(previousQty - 1, 0);
  } else if (acao === "marcar_todos") {
    // Único caso que ainda exige direito real: sem total oficial não há
    // "todos" a marcar, e direito a café não se presume.
    if (
      (entitlement.kind !== "incluido" && entitlement.kind !== "avulso_pago") ||
      entitled <= 0
    ) {
      return { ok: false, error: "cafe_write_forbidden_no_entitlement" };
    }
    nextQty = entitled;
  } else if (acao === "set") {
    const requested = Math.trunc(Number(input.request.quantidadeAtendida) || 0);
    if (requested < 0) {
      return { ok: false, error: "cafe_invalid_quantity" };
    }
    nextQty = requested;
  } else {
    return { ok: false, error: "cafe_invalid_action" };
  }

  return {
    ok: true,
    previousQty,
    nextQty,
    entitlement,
  };
}
