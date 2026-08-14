/**
 * Projeção temporária: modelo interno de sync Yes → canônico gerencial.
 * Não é mapper de JSON HITS. bookedAt e comissão permanecem null (gaps).
 */

import { classifyCommissionFromHits } from "../domain/yes-hotel/reservation-financial-classification.ts";
import type { SyncedReservation } from "../domain/yes-hotel/synced-reservation.ts";
import type { CanonicalReservationInput, CanonicalReservationStatus } from "./canonical.ts";
import { canonicalChannelFromOperational } from "./channel.ts";
import { extractYmdSafe } from "./from-synced-helpers.ts";
import { resolveGuestIdentity } from "../crm/identity.ts";

function brlToCents(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function mapStatus(status: SyncedReservation["reservationStatus"]): CanonicalReservationStatus {
  if (status === "cancelada") return "cancelled";
  if (status === "ativa") return "booked";
  return "unknown";
}

export function canonicalReservationFromSynced(
  row: SyncedReservation,
): CanonicalReservationInput {
  const classified = classifyCommissionFromHits({
    channelManager: row.channelManager,
    salesChannel: row.salesChannel,
    billingEntity: row.billingEntity,
    reservationChannelId: row.reservationChannelId,
  });

  const guests = row.guests.map((g) => {
    const identity = resolveGuestIdentity({
      documentType: g.documentType,
      documentNumber: g.documentNumber,
      nationality: g.nationality ?? null,
    });
    return {
      role: g.isPrincipal ? ("principal" as const) : ("accompanying" as const),
      displayName: g.name,
      identity: identity.confidence === "missing" ? null : identity.identity,
      nationality: g.nationality ?? null,
      email: g.email,
      phone: g.phone,
      externalGuestId: g.externalGuestId,
    };
  });

  return {
    sourceSystem: "hits",
    externalReservationId: row.externalReservationId,
    status: mapStatus(row.reservationStatus),
    bookedAt: null,
    arrivalDate: extractYmdSafe(row.checkIn),
    departureDate: extractYmdSafe(row.checkOut),
    apartmentCode: row.apartmentCode || null,
    channel: canonicalChannelFromOperational({
      originKind: classified.originKind,
      matchedOtaId: classified.matchedOtaId,
      label: row.salesChannel,
    }),
    companyExternalId: null,
    companyName: row.billingEntity,
    lodgingRevenueCents: brlToCents(row.reservationTotalAmount),
    channelCommissionCents: null,
    balanceDueCents: brlToCents(row.reservationBalanceDue),
    guests,
  };
}
