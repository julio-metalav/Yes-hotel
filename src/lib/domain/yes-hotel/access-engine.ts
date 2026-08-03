import {
  getAccessTargetsForApartment,
  normalizeApartmentCode,
  resolveBlockLayoutByApartment,
} from "./hotel-layout";
import {
  DEFAULT_CHECK_IN_HOUR,
  DEFAULT_CHECK_OUT_HOUR,
  extractYmd,
  hotelLocalToUtcMs,
} from "./hotel-timezone";
import type {
  AccessPlan,
  CredentialWindow,
  InternalReservation,
  ReservationAdjustment,
  RoomChangePlan,
} from "./types";

function parseInputDate(value: string | Date): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Data invalida informada: ${String(value)}`);
  }

  return date;
}

/** Horário civil do hotel (America/Campo_Grande), nunca setHours do runtime. */
function hotelCivilAt(dateInput: string | Date, hours: number, minutes = 0): Date {
  return new Date(hotelLocalToUtcMs(extractYmd(dateInput), hours, minutes));
}

export function resolveBlockCode(apartmentCode: string): string {
  return resolveBlockLayoutByApartment(apartmentCode).blockCode;
}

export function calculateCredentialWindow(
  reservation: InternalReservation,
  adjustment?: ReservationAdjustment,
): CredentialWindow {
  const validFrom = adjustment?.earlyCheckInAt
    ? parseInputDate(adjustment.earlyCheckInAt)
    : hotelCivilAt(reservation.checkIn, DEFAULT_CHECK_IN_HOUR);
  const validTo = adjustment?.lateCheckOutAt
    ? parseInputDate(adjustment.lateCheckOutAt)
    : hotelCivilAt(reservation.checkOut, DEFAULT_CHECK_OUT_HOUR);

  if (validFrom > validTo) {
    throw new Error(
      `Janela de credencial invalida para a reserva ${reservation.reservationId}.`,
    );
  }

  let source: CredentialWindow["source"] = "default";

  if (adjustment?.earlyCheckInAt && adjustment?.lateCheckOutAt) {
    source = "manual_combined";
  } else if (adjustment?.earlyCheckInAt) {
    source = "early_checkin";
  } else if (adjustment?.lateCheckOutAt) {
    source = "late_checkout";
  }

  return {
    validFrom,
    validTo,
    source,
  };
}

export function resolveAccessTargets(reservation: InternalReservation) {
  return getAccessTargetsForApartment(reservation.apartmentCode);
}

export function buildProvisionPlan(
  reservation: InternalReservation,
  adjustment?: ReservationAdjustment,
): AccessPlan {
  const apartmentCode = normalizeApartmentCode(reservation.apartmentCode);
  const blockCode = resolveBlockCode(apartmentCode);
  const window = calculateCredentialWindow(
    {
      ...reservation,
      apartmentCode,
    },
    adjustment,
  );
  const targets = getAccessTargetsForApartment(apartmentCode);

  return {
    reservationId: reservation.reservationId,
    apartmentCode,
    blockCode,
    window,
    targets,
    actions: targets.map((target) => ({
      action: "provision" as const,
      target,
      reason: "Reserva apta para provisionamento operacional.",
    })),
  };
}

export function buildCancellationPlan(
  reservation: InternalReservation,
  adjustment?: ReservationAdjustment,
): AccessPlan {
  const apartmentCode = normalizeApartmentCode(reservation.apartmentCode);
  const blockCode = resolveBlockCode(apartmentCode);
  const window = calculateCredentialWindow(
    {
      ...reservation,
      apartmentCode,
    },
    adjustment,
  );
  const targets = getAccessTargetsForApartment(apartmentCode);

  return {
    reservationId: reservation.reservationId,
    apartmentCode,
    blockCode,
    window,
    targets,
    actions: targets.map((target) => ({
      action: "revoke" as const,
      target,
      reason: "Reserva cancelada; credencial operacional deve ser revogada.",
    })),
  };
}

export function buildRoomChangePlan(
  previousReservation: InternalReservation,
  nextReservation: InternalReservation,
  adjustment?: ReservationAdjustment,
): RoomChangePlan {
  const previousApartmentCode = normalizeApartmentCode(
    previousReservation.apartmentCode,
  );
  const nextApartmentCode = normalizeApartmentCode(nextReservation.apartmentCode);
  const previousBlockCode = resolveBlockCode(previousApartmentCode);
  const nextBlockCode = resolveBlockCode(nextApartmentCode);
  const previousTargets = getAccessTargetsForApartment(previousApartmentCode);
  const nextTargets = getAccessTargetsForApartment(nextApartmentCode);
  const window = calculateCredentialWindow(
    {
      ...nextReservation,
      apartmentCode: nextApartmentCode,
    },
    adjustment,
  );

  return {
    reservationId: nextReservation.reservationId,
    previousApartmentCode,
    nextApartmentCode,
    previousBlockCode,
    nextBlockCode,
    blockChanged: previousBlockCode !== nextBlockCode,
    window,
    previousTargets,
    nextTargets,
    actions: [
      ...previousTargets.map((target) => ({
        action: "revoke" as const,
        target,
        reason: "Troca de apartamento; remover acessos do quarto anterior.",
      })),
      ...nextTargets.map((target) => ({
        action: "provision" as const,
        target,
        reason: "Troca de apartamento; provisionar acessos do novo quarto.",
      })),
    ],
  };
}
