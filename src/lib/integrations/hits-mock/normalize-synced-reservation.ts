/**
 * Normaliza detail HITS mock → SyncedReservation.
 * Não inventa campos oficiais; ausências → null.
 */

import type {
  SyncedGuest,
  SyncedPaymentStatus,
  SyncedReservation,
  SyncedReservationStatus,
} from "../../domain/yes-hotel/synced-reservation.ts";
import type { HitsMockReservationDetail } from "./types.ts";

function trimOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function normalizeApartment(code: string | null | undefined): string {
  if (!code) return "";
  const digits = String(code).match(/\d+/g)?.join("") ?? "";
  const n = Number(digits);
  if (!Number.isInteger(n) || n < 1) return String(code).trim();
  return String(n).padStart(2, "0");
}

function mapStatus(status: unknown): SyncedReservationStatus {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "2" || s === "canceled" || s === "cancelled") return "cancelada";
  return "ativa";
}

function mapPayment(detail: HitsMockReservationDetail): SyncedPaymentStatus {
  const sim = (detail as HitsMockReservationDetail & { __paymentSim?: string }).__paymentSim;
  if (sim === "pago" || sim === "pendente" || sim === "parcial" || sim === "desconhecido") {
    return sim;
  }
  // Sem sinal de pagamento no mock → desconhecido (nunca inventar "pendente").
  return "desconhecido";
}

function sanitizeRaw(detail: HitsMockReservationDetail): Record<string, unknown> {
  const { ...rest } = detail as Record<string, unknown>;
  delete rest.__paymentSim;
  // Remover chaves sensíveis se existirem.
  for (const k of Object.keys(rest)) {
    if (/token|secret|password|senha|authorization/i.test(k)) {
      delete rest[k];
    }
  }
  return rest;
}

export function normalizeHitsMockDetailToSynced(
  detail: HitsMockReservationDetail,
  syncedAt: string | null = null,
): SyncedReservation {
  const externalReservationId = trimOrNull(detail.idReservation);
  if (!externalReservationId) {
    throw new Error("hits_mock_missing_external_reservation_id");
  }

  const room = detail.rooms?.[0];
  const checkIn = trimOrNull(room?.checkIn) ?? "";
  const checkOut = trimOrNull(room?.checkOut) ?? "";
  const apartmentCode = normalizeApartment(room?.code ?? null);

  const guestsRaw = detail.guests ?? [];
  const guests: SyncedGuest[] = guestsRaw.map((g, idx) => ({
    externalGuestId: trimOrNull(g.idEntity),
    name: trimOrNull(g.name) ?? "",
    isPrincipal: g.main === true || (idx === 0 && !guestsRaw.some((x) => x.main === true)),
    isMinor: null,
    phone: trimOrNull(g.contactPhone),
    email: trimOrNull(g.contactMail),
  }));

  const principal =
    guests.find((g) => g.isPrincipal) ??
    guests[0] ??
    ({
      externalGuestId: null,
      name: trimOrNull(detail.contactName) ?? "",
      isPrincipal: true,
      isMinor: null,
      phone: trimOrNull(detail.contact2),
      email: trimOrNull(detail.contact1),
    } satisfies SyncedGuest);

  const totalFromPax = room?.pax != null && Number.isFinite(Number(room.pax))
    ? Number(room.pax)
    : null;
  const totalGuests = totalFromPax ?? Math.max(guests.length, 1);
  const mealPlanDesc = trimOrNull(
    (room as { mealPlanDesc?: string | null } | undefined)?.mealPlanDesc,
  );

  return {
    provider: "hits",
    externalReservationId,
    sourceUpdatedAt: trimOrNull(detail.dateUp),
    syncedAt,
    reservationStatus: mapStatus(detail.status),
    checkIn,
    checkOut,
    apartmentCode,
    mainGuestName: principal.name || trimOrNull(detail.contactName) || "",
    guests: guests.length > 0 ? guests : [principal],
    adults: null,
    minors: null,
    totalGuests,
    mealPlanDesc,
    paymentStatus: mapPayment(detail),
    phone: principal.phone ?? trimOrNull(detail.contact2),
    email: principal.email ?? trimOrNull(detail.contact1),
    rawSanitized: sanitizeRaw(detail),
  };
}
