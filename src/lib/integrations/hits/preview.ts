import type {
  HitsInternalReservationPreview,
  HitsReservationDetail,
  HitsReservationGuest,
  HitsReservationRoom,
} from "./types";

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text ? text : null;
}

function idsMatch(left: unknown, right: unknown): boolean {
  const leftValue = toNullableString(left);
  const rightValue = toNullableString(right);

  return Boolean(leftValue && rightValue && leftValue === rightValue);
}

function getMainGuest(guests: HitsReservationGuest[] = []): HitsReservationGuest | null {
  return guests.find((guest) => guest.main === true) ?? guests[0] ?? null;
}

function getPreferredRoom(
  detail: HitsReservationDetail,
  mainGuest: HitsReservationGuest | null,
): HitsReservationRoom | null {
  const rooms = detail.rooms ?? [];

  if (mainGuest?.idRoom !== undefined) {
    const roomFromGuest = rooms.find((room) => idsMatch(room.idRoom, mainGuest.idRoom));

    if (roomFromGuest) {
      return roomFromGuest;
    }
  }

  return rooms[0] ?? null;
}

export function mapHitsReservationDetailToInternalPreview(
  detail: HitsReservationDetail,
): HitsInternalReservationPreview {
  const mainGuest = getMainGuest(detail.guests);
  const room = getPreferredRoom(detail, mainGuest);

  return {
    reservationId: toNullableString(detail.idReservation),
    guestMainName: toNullableString(mainGuest?.name),
    guestMainEmail: toNullableString(mainGuest?.contactMail),
    guestMainPhone: toNullableString(mainGuest?.contactPhone),
    roomId: toNullableString(room?.idRoom),
    roomCode: toNullableString(room?.code),
    checkIn: toNullableString(room?.checkIn),
    checkOut: toNullableString(room?.checkOut),
    updatedAt: toNullableString(detail.dateUp),
  };
}
