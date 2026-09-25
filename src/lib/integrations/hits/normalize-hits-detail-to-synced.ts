/**
 * Normaliza detalhe HITS (real ou mock) → SyncedReservation.
 * Não inventa campos; ausências → null.
 * Classificação financeira via reservation-financial-classification (única fonte).
 */

import type {
  SyncedGuest,
  SyncedPaymentStatus,
  SyncedReservation,
  SyncedReservationStatus,
} from "../../domain/yes-hotel/synced-reservation.ts";
import {
  classifyCommissionFromHits,
  extractHitsCommercialFields,
  mapPaymentStatusFromBalanceDue,
} from "../../domain/yes-hotel/reservation-financial-classification.ts";

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

function mapPayment(detail: Record<string, unknown>): SyncedPaymentStatus {
  const sim = detail.__paymentSim;
  if (sim === "pago" || sim === "pendente" || sim === "parcial" || sim === "desconhecido") {
    return sim;
  }
  return mapPaymentStatusFromBalanceDue(detail.reservationBalanceDue, "desconhecido");
}

function sanitizeRaw(detail: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...detail };
  delete rest.__paymentSim;
  for (const k of Object.keys(rest)) {
    if (/token|secret|password|senha|authorization/i.test(k)) {
      delete rest[k];
    }
  }
  return rest;
}

/**
 * Merge opcional de campos da lista (ex.: integrator) quando o detalhe não traz.
 */
export function mergeHitsListFieldsIntoDetail(
  detail: Record<string, unknown>,
  listItem?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!listItem) return detail;
  const out = { ...detail };
  const prefer = (key: string) => {
    if (out[key] == null || String(out[key]).trim() === "") {
      if (listItem[key] != null && String(listItem[key]).trim() !== "") {
        out[key] = listItem[key];
      }
    }
  };
  prefer("integrator");
  prefer("reservationChannelId");
  prefer("reservationIntegrationId");
  prefer("reservationIntegratorId");
  prefer("companyName");
  prefer("status");
  return out;
}

export function normalizeHitsDetailToSynced(
  detailInput: Record<string, unknown>,
  syncedAt: string | null = null,
  listItem?: Record<string, unknown> | null,
): SyncedReservation {
  const detail = mergeHitsListFieldsIntoDetail(detailInput, listItem);
  const externalReservationId = trimOrNull(detail.idReservation);
  if (!externalReservationId) {
    throw new Error("hits_missing_external_reservation_id");
  }

  const rooms = Array.isArray(detail.rooms) ? detail.rooms : [];
  const room = (rooms[0] ?? {}) as Record<string, unknown>;
  const checkIn = trimOrNull(room.checkIn) ?? "";
  const checkOut = trimOrNull(room.checkOut) ?? "";
  const apartmentCode = normalizeApartment(trimOrNull(room.code));

  const guestsRaw = Array.isArray(detail.guests) ? detail.guests : [];
  const guests: SyncedGuest[] = guestsRaw.map((gRaw, idx) => {
    const g = (gRaw ?? {}) as Record<string, unknown>;
    return {
      externalGuestId: trimOrNull(g.idEntity),
      name: trimOrNull(g.name) ?? "",
      isPrincipal:
        g.main === true ||
        (idx === 0 && !guestsRaw.some((x) => (x as Record<string, unknown>)?.main === true)),
      isMinor: null,
      phone: trimOrNull(g.contactPhone),
      email: trimOrNull(g.contactMail),
      birthDate: trimOrNull(g.birthDate),
      gender: trimOrNull(g.gender),
      nationality: trimOrNull(g.addressCountry),
      documentType: trimOrNull(g.documentType ?? g.mainDocType),
      documentNumber: trimOrNull(g.docCpfCnpjPassport ?? g.federalRegistrationNumber),
    };
  });

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

  const totalFromPax =
    room.pax != null && Number.isFinite(Number(room.pax)) ? Number(room.pax) : null;
  const totalGuests = totalFromPax ?? Math.max(guests.length, 1);
  const mealPlanDesc = trimOrNull(room.mealPlanDesc);

  const commercial = extractHitsCommercialFields(detail);
  const classified = classifyCommissionFromHits({
    channelManager: commercial.channelManager,
    salesChannel: commercial.salesChannel,
    companyName: commercial.companyName,
    billingEntity: commercial.billingEntity,
    groupName: commercial.groupName,
    reservationChannelId: commercial.reservationChannelId,
    integrator: commercial.integrator,
  });

  return {
    provider: "hits",
    externalReservationId,
    sourceUpdatedAt: trimOrNull(detail.dateUp),
    syncedAt,
    reservationStatus: mapStatus(detail.status ?? room.status),
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
    channelManager: commercial.channelManager,
    salesChannel: commercial.salesChannel,
    billingEntity: commercial.billingEntity,
    reservationChannelId: commercial.reservationChannelId,
    reservationBalanceDue: commercial.reservationBalanceDue,
    reservationTotalAmount: commercial.reservationTotalAmount,
    classificacaoComissionamento: classified.classificacao,
    rawSanitized: sanitizeRaw(detail),
  };
}
