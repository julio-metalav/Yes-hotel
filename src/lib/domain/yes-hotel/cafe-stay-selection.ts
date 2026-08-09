/**
 * Seleção de reservas elegíveis para o café na manhã D.
 *
 * Semântica alinhada ao modelo operacional atual (Chegadas / hospedados):
 * - status_reserva = 'ativa' (canceladas excluídas; no-show não existe no sync HITS atual);
 * - check_in_previsto < D  (passou a noite anterior a D);
 * - check_out_previsto >= D (ainda hospedado na manhã D, inclusive dia do checkout).
 *
 * Observação: a policy de "hóspedes hospedados" das Chegadas usa
 * `check_in <= D < check_out` + `entrou_no_apto`. Para o café da manhã D,
 * a regra de negócio pedida é noite anterior + checkout >= D; não exige
 * `entrou_no_apto` (hóspede pode ter direito ao café mesmo sem flag de entrada).
 */

export type CafeStayReservationInput = {
  id: string;
  externalReservationId: string | null;
  apartmentCode: string;
  mainGuestName: string;
  checkInYmd: string;
  checkOutYmd: string;
  statusReserva: string;
  /** Quantidade oficial sincronizada do HITS (`rooms[].pax` → totalGuests). */
  totalGuests: number;
  /** Texto bruto HITS `rooms[].mealPlanDesc` — sem interpretação de negócio. */
  mealPlanDesc: string | null;
};

export function isValidCafeStayStatus(status: string): boolean {
  const s = String(status || "").trim().toLowerCase();
  if (!s) return false;
  if (s === "cancelada" || s === "canceled" || s === "cancelled" || s === "2") {
    return false;
  }
  // Sync atual só persiste ativa|cancelada. Qualquer outro valor conhecido de
  // cancelamento/no-show futuro deve ser excluído quando aparecer.
  if (s === "no-show" || s === "noshow" || s === "no_show") return false;
  // Status 4 / Blocked: significado no HITS ainda não confirmado — fora da seleção.
  if (s === "4" || s === "blocked" || s === "bloqueado" || s === "bloqueada") {
    return false;
  }
  return s === "ativa" || s === "1" || s === "confirmed" || s === "3" || s === "processed";
}

/**
 * Reserva elegível para café na manhã D:
 * check-in anterior a D e check-out igual ou posterior a D.
 */
export function isCafeStayOnDate(
  reservation: Pick<
    CafeStayReservationInput,
    "checkInYmd" | "checkOutYmd" | "statusReserva"
  >,
  cafeDateYmd: string,
): boolean {
  if (!isValidCafeStayStatus(reservation.statusReserva)) return false;
  const cin = String(reservation.checkInYmd || "").slice(0, 10);
  const cout = String(reservation.checkOutYmd || "").slice(0, 10);
  const d = String(cafeDateYmd || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cin) || !/^\d{4}-\d{2}-\d{2}$/.test(cout)) {
    return false;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return cin < d && cout >= d;
}

export function apartmentNumberValue(code: string | null | undefined): number {
  const match = String(code ?? "").trim().match(/(\d+)/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

export function compareCafeApartmentCodes(a: string, b: string): number {
  const na = apartmentNumberValue(a);
  const nb = apartmentNumberValue(b);
  if (na !== nb) return na - nb;
  return String(a ?? "")
    .trim()
    .localeCompare(String(b ?? "").trim(), "pt-BR", {
      numeric: true,
      sensitivity: "base",
    });
}

export function selectCafeStaysForDate(
  reservations: CafeStayReservationInput[],
  cafeDateYmd: string,
): CafeStayReservationInput[] {
  return reservations
    .filter((r) => isCafeStayOnDate(r, cafeDateYmd))
    .slice()
    .sort((left, right) => {
      const apt = compareCafeApartmentCodes(left.apartmentCode, right.apartmentCode);
      if (apt !== 0) return apt;
      return String(left.id).localeCompare(String(right.id), "pt-BR");
    });
}
