import type { InternalReservation, InternalReservationStatus } from "../../domain/yes-hotel";
import type {
  HitsMockReservationDetail,
  HitsMockReservationGuest,
  HitsMockReservationRoom,
} from "./types";

function toNullableString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const text = String(value).trim();
  return text || undefined;
}

function idsMatch(left: unknown, right: unknown): boolean {
  const leftText = toNullableString(left);
  const rightText = toNullableString(right);

  return Boolean(leftText && rightText && leftText === rightText);
}

function normalizeApartmentCode(roomCode: string | undefined): string {
  if (!roomCode) {
    throw new Error("Payload HITS mock sem rooms[].code utilizavel.");
  }

  const digits = roomCode.match(/\d+/g)?.join("") ?? "";
  const numeric = Number(digits);

  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 40) {
    throw new Error(`Nao foi possivel extrair apartmentCode valido de rooms[].code: ${roomCode}`);
  }

  return String(numeric).padStart(2, "0");
}

function mapExternalStatusToInternalStatus(
  status: number | string | null | undefined,
): InternalReservationStatus {
  const normalizedStatus = toNullableString(status)?.toLowerCase();

  if (normalizedStatus === "1" || normalizedStatus === "confirmed") {
    return "confirmed";
  }

  if (normalizedStatus === "2" || normalizedStatus === "canceled" || normalizedStatus === "cancelled") {
    return "canceled";
  }

  if (normalizedStatus === "in_house" || normalizedStatus === "inhouse") {
    return "in_house";
  }

  if (normalizedStatus === "checked_out" || normalizedStatus === "checkout") {
    return "checked_out";
  }

  return "unknown";
}

function resolvePrimaryRoom(
  detail: HitsMockReservationDetail,
): HitsMockReservationRoom {
  const rooms = detail.rooms ?? [];

  if (rooms.length === 0) {
    throw new Error("Payload HITS mock sem rooms[] para mapear a reserva interna.");
  }

  // Fallback conservador enquanto nao ha sinalizacao mais forte do quarto principal.
  return rooms[0];
}

function resolvePrimaryGuest(
  detail: HitsMockReservationDetail,
  primaryRoom: HitsMockReservationRoom,
): HitsMockReservationGuest | undefined {
  const guests = detail.guests ?? [];

  if (guests.length === 0) {
    return undefined;
  }

  // Prioriza o hospede explicitamente marcado como principal.
  const explicitMainGuest = guests.find((guest) => guest.main === true);

  if (explicitMainGuest) {
    return explicitMainGuest;
  }

  // Na ausencia de main=true, tenta manter coerencia com o quarto principal escolhido.
  const roomCompatibleGuest = guests.find((guest) =>
    idsMatch(guest.idRoom, primaryRoom.idRoom),
  );

  if (roomCompatibleGuest) {
    return roomCompatibleGuest;
  }

  // Ultimo fallback conservador: primeiro hospede disponivel.
  return guests[0];
}

function resolveGuestMainName(
  detail: HitsMockReservationDetail,
  guest: HitsMockReservationGuest | undefined,
): string {
  const guestName = toNullableString(guest?.name);
  const contactName = toNullableString(detail.contactName);

  return guestName ?? contactName ?? "Hospede sem identificacao";
}

export function mapHitsDetailToInternalReservation(
  detail: HitsMockReservationDetail,
): InternalReservation {
  const primaryRoom = resolvePrimaryRoom(detail);
  const primaryGuest = resolvePrimaryGuest(detail, primaryRoom);
  const apartmentCode = normalizeApartmentCode(toNullableString(primaryRoom.code));
  const reservationId = toNullableString(detail.idReservation);
  const checkIn = toNullableString(primaryRoom.checkIn);
  const checkOut = toNullableString(primaryRoom.checkOut);
  const updatedAt = toNullableString(detail.dateUp) ?? toNullableString(detail.dateAdd);

  if (!reservationId) {
    throw new Error("Payload HITS mock sem idReservation utilizavel.");
  }

  if (!checkIn || !checkOut) {
    throw new Error(
      `Payload HITS mock sem checkIn/checkOut utilizavel para a reserva ${reservationId}.`,
    );
  }

  return {
    reservationId,
    guestMainName: resolveGuestMainName(detail, primaryGuest),
    guestMainEmail: toNullableString(primaryGuest?.contactMail),
    guestMainPhone: toNullableString(primaryGuest?.contactPhone),
    apartmentCode,
    checkIn,
    checkOut,
    status: mapExternalStatusToInternalStatus(detail.status ?? primaryRoom.status),
    updatedAt,
  };
}
