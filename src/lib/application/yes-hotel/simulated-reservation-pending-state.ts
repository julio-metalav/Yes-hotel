/**
 * Adapter simulado de pendências — SOMENTE testes / composição explícita de homologação.
 * NÃO selecionar automaticamente em produção.
 * Substituição futura: HITS ReservationPendingStatePort — mesma interface.
 */

import type { ReservationPendingStatePort } from "../../application/yes-hotel/first-room-access-ports";
import type {
  PaymentStatusPending,
  ReservationPendingStateInput,
} from "../../domain/yes-hotel/reservation-pending-state";

export type SimulatedPendingScenario =
  | "pago"
  | "pendente"
  | "parcial"
  | "desconhecido"
  | "fnrh_pendente"
  | "ambos"
  | "clear";

const SCENARIO_MAP: Record<SimulatedPendingScenario, ReservationPendingStateInput> = {
  pago: {
    payment_status: "pago",
    guests: [{ id: "g1", role: "principal_adulto", fnrh_status: "completed" }],
  },
  clear: {
    payment_status: "pago",
    guests: [{ id: "g1", role: "principal_adulto", fnrh_status: "completed" }],
  },
  pendente: {
    payment_status: "pendente",
    guests: [{ id: "g1", role: "principal_adulto", fnrh_status: "completed" }],
  },
  parcial: {
    payment_status: "parcial",
    guests: [{ id: "g1", role: "principal_adulto", fnrh_status: "completed" }],
  },
  desconhecido: {
    payment_status: "desconhecido",
    guests: [{ id: "g1", role: "principal_adulto", fnrh_status: "completed" }],
  },
  fnrh_pendente: {
    payment_status: "pago",
    guests: [{ id: "g1", role: "principal_adulto", fnrh_status: "pending" }],
  },
  ambos: {
    payment_status: "pendente",
    guests: [{ id: "g1", role: "principal_adulto", fnrh_status: "pending" }],
  },
};

/**
 * Port simulado: estado por reserva ou cenário global.
 * Sem rede. Para testes e homologação com flags desligadas.
 */
export class SimulatedReservationPendingStatePort implements ReservationPendingStatePort {
  private byReservation = new Map<string, ReservationPendingStateInput>();
  private fallback: ReservationPendingStateInput;

  constructor(scenario: SimulatedPendingScenario | ReservationPendingStateInput = "pendente") {
    this.fallback =
      typeof scenario === "string" ? structuredClone(SCENARIO_MAP[scenario]) : structuredClone(scenario);
  }

  setScenario(scenario: SimulatedPendingScenario): void {
    this.fallback = structuredClone(SCENARIO_MAP[scenario]);
  }

  setPaymentStatus(status: PaymentStatusPending): void {
    this.fallback = { ...this.fallback, payment_status: status };
  }

  setForReservation(reservationId: string, input: ReservationPendingStateInput): void {
    this.byReservation.set(reservationId, structuredClone(input));
  }

  async getReservationPendingInput(reservationId: string): Promise<ReservationPendingStateInput> {
    const specific = this.byReservation.get(reservationId);
    return structuredClone(specific ?? this.fallback);
  }
}
