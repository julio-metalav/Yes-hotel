import type {
  InternalReservation,
  ReservationAdjustment,
} from "../src/lib/domain/yes-hotel";

export function createMockReservation(
  overrides: Partial<InternalReservation> = {},
): InternalReservation {
  return {
    reservationId: "RES-1001",
    guestMainName: "Hospede Teste",
    guestMainEmail: "hospede.teste@example.com",
    guestMainPhone: "+55 11 99999-0000",
    apartmentCode: "05",
    checkIn: "2026-03-20",
    checkOut: "2026-03-23",
    status: "confirmed",
    updatedAt: "2026-03-18T10:00:00-03:00",
    ...overrides,
  };
}

export function createMockAdjustment(
  overrides: Partial<ReservationAdjustment> = {},
): ReservationAdjustment {
  return {
    ...overrides,
  };
}
