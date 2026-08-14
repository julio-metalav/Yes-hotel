/**
 * Fórmulas gerenciais determinísticas. Sem I/O. Sem inventar comissão.
 */

import type { CanonicalChannelKind, CanonicalReservationInput, MoneyCents } from "./canonical.ts";
import { countsAsCancelledOrNoShow, derivedRoomNights, isEligibleForOccupancy } from "./canonical.ts";
import { channelGroup } from "./channel.ts";
import { availableRoomNights, inventoryRange } from "./inventory.ts";
import type { InventoryDay } from "./inventory.ts";
import { datesInclusive, stayDates } from "./temporal.ts";

export type RatioResult = {
  value: number | null;
  numerator: number;
  denominator: number;
};

function ratio(numerator: number, denominator: number): RatioResult {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return { value: null, numerator, denominator };
  }
  return { value: numerator / denominator, numerator, denominator };
}

export function occupancyRate(input: {
  occupiedRoomNights: number;
  availableRoomNights: number;
}): RatioResult {
  return ratio(input.occupiedRoomNights, input.availableRoomNights);
}

/** ADR = receita de hospedagem / quartos vendidos (noites ocupadas vendidas). */
export function adr(input: {
  lodgingRevenueCents: MoneyCents;
  roomsSold: number;
}): RatioResult {
  return ratio(input.lodgingRevenueCents, input.roomsSold);
}

/** RevPAR = receita de hospedagem / quartos disponíveis. */
export function revpar(input: {
  lodgingRevenueCents: MoneyCents;
  availableRoomNights: number;
}): RatioResult {
  return ratio(input.lodgingRevenueCents, input.availableRoomNights);
}

export function averageLengthOfStay(input: {
  roomNightsSold: number;
  eligibleStayCount: number;
}): RatioResult {
  return ratio(input.roomNightsSold, input.eligibleStayCount);
}

export function ticketAveragePerReservation(input: {
  lodgingRevenueCents: MoneyCents;
  reservationCount: number;
}): RatioResult {
  return ratio(input.lodgingRevenueCents, input.reservationCount);
}

export function ticketAveragePerGuest(input: {
  lodgingRevenueCents: MoneyCents;
  uniqueGuestCount: number;
}): RatioResult {
  return ratio(input.lodgingRevenueCents, input.uniqueGuestCount);
}

export type ChannelShareRow = {
  kind: CanonicalChannelKind;
  group: ReturnType<typeof channelGroup>;
  reservations: number;
  roomNights: number;
  grossRevenueCents: MoneyCents | null;
  shareOfReservations: number | null;
  shareOfRevenue: number | null;
};

export function channelParticipation(
  reservations: CanonicalReservationInput[],
): ChannelShareRow[] {
  const eligible = reservations.filter((r) => !countsAsCancelledOrNoShow(r.status));
  const totalRes = eligible.length;
  const totals = new Map<
    CanonicalChannelKind,
    { reservations: number; roomNights: number; revenue: number; revenueKnown: boolean }
  >();

  for (const r of eligible) {
    const kind = r.channel.kind;
    const cur = totals.get(kind) ?? {
      reservations: 0,
      roomNights: 0,
      revenue: 0,
      revenueKnown: true,
    };
    cur.reservations += 1;
    cur.roomNights += derivedRoomNights(r);
    if (r.lodgingRevenueCents == null) cur.revenueKnown = false;
    else cur.revenue += r.lodgingRevenueCents;
    totals.set(kind, cur);
  }

  const knownRevenueTotal = [...totals.values()].every((t) => t.revenueKnown)
    ? [...totals.values()].reduce((s, t) => s + t.revenue, 0)
    : null;

  const kinds: CanonicalChannelKind[] = [
    "direct",
    "booking_engine",
    "ota",
    "b2b",
    "manual",
    "other",
    "unknown",
  ];

  return kinds
    .filter((kind) => totals.has(kind))
    .map((kind) => {
      const t = totals.get(kind)!;
      const gross = t.revenueKnown ? t.revenue : null;
      return {
        kind,
        group: channelGroup(kind),
        reservations: t.reservations,
        roomNights: t.roomNights,
        grossRevenueCents: gross,
        shareOfReservations: totalRes > 0 ? t.reservations / totalRes : null,
        shareOfRevenue:
          gross != null && knownRevenueTotal != null && knownRevenueTotal > 0
            ? gross / knownRevenueTotal
            : null,
      };
    });
}

export type ChannelNetRow = {
  kind: CanonicalChannelKind;
  grossRevenueCents: MoneyCents | null;
  commissionCents: MoneyCents | null;
  netRevenueCents: MoneyCents | null;
};

/** Receita líquida = bruta − comissão. Comissão ausente → líquida null (não assume 0). */
export function netRevenueByChannel(
  reservations: CanonicalReservationInput[],
): ChannelNetRow[] {
  const byKind = new Map<
    CanonicalChannelKind,
    { gross: number; commission: number; grossKnown: boolean; commissionKnown: boolean }
  >();

  for (const r of reservations) {
    if (countsAsCancelledOrNoShow(r.status)) continue;
    const cur = byKind.get(r.channel.kind) ?? {
      gross: 0,
      commission: 0,
      grossKnown: true,
      commissionKnown: true,
    };
    if (r.lodgingRevenueCents == null) cur.grossKnown = false;
    else cur.gross += r.lodgingRevenueCents;
    if (r.channelCommissionCents == null) cur.commissionKnown = false;
    else cur.commission += r.channelCommissionCents;
    byKind.set(r.channel.kind, cur);
  }

  return [...byKind.entries()].map(([kind, t]) => {
    const gross = t.grossKnown ? t.gross : null;
    const commission = t.commissionKnown ? t.commission : null;
    const net =
      gross != null && commission != null ? gross - commission : null;
    return {
      kind,
      grossRevenueCents: gross,
      commissionCents: commission,
      netRevenueCents: net,
    };
  });
}

export type AgingBucketId = "0_30" | "31_60" | "61_90" | "90_plus";

export type AgingRow = {
  bucket: AgingBucketId;
  count: number;
  openCents: MoneyCents;
};

export function receivableAging(
  items: Array<{ dueDate: string; openCents: number }>,
  asOfDate: string,
): AgingRow[] {
  const buckets: Record<AgingBucketId, AgingRow> = {
    "0_30": { bucket: "0_30", count: 0, openCents: 0 },
    "31_60": { bucket: "31_60", count: 0, openCents: 0 },
    "61_90": { bucket: "61_90", count: 0, openCents: 0 },
    "90_plus": { bucket: "90_plus", count: 0, openCents: 0 },
  };

  for (const item of items) {
    if (!Number.isInteger(item.openCents) || item.openCents <= 0) continue;
    const days = Math.round(
      (Date.parse(`${asOfDate}T00:00:00Z`) - Date.parse(`${item.dueDate}T00:00:00Z`)) /
        86_400_000,
    );
    if (days < 0) continue;
    let bucket: AgingBucketId = "0_30";
    if (days >= 91) bucket = "90_plus";
    else if (days >= 61) bucket = "61_90";
    else if (days >= 31) bucket = "31_60";
    buckets[bucket].count += 1;
    buckets[bucket].openCents += item.openCents;
  }

  return [buckets["0_30"], buckets["31_60"], buckets["61_90"], buckets["90_plus"]];
}

export type OccupancyFromReservationsResult = {
  occupiedRoomNights: number;
  availableRoomNights: number;
  occupancy: RatioResult;
};

export function occupancyFromReservations(input: {
  reservations: CanonicalReservationInput[];
  from: string;
  to: string;
  inventory?: InventoryDay[];
  sellableRooms?: number;
}): OccupancyFromReservationsResult {
  const windowDates = datesInclusive(input.from, input.to);
  const inventory =
    input.inventory ??
    inventoryRange({ stayDates: windowDates, sellableRooms: input.sellableRooms });
  const available = availableRoomNights(inventory);
  const occupiedDates = new Map<string, number>();

  for (const r of input.reservations) {
    if (!isEligibleForOccupancy(r.status)) continue;
    for (const d of stayDates(r.arrivalDate, r.departureDate)) {
      if (d < input.from || d > input.to) continue;
      occupiedDates.set(d, (occupiedDates.get(d) ?? 0) + 1);
    }
  }

  const occupied = [...occupiedDates.values()].reduce((s, n) => s + n, 0);
  return {
    occupiedRoomNights: occupied,
    availableRoomNights: available,
    occupancy: occupancyRate({ occupiedRoomNights: occupied, availableRoomNights: available }),
  };
}

export function lodgingRevenueSum(reservations: CanonicalReservationInput[]): MoneyCents | null {
  let sum = 0;
  for (const r of reservations) {
    if (countsAsCancelledOrNoShow(r.status)) continue;
    if (r.lodgingRevenueCents == null) return null;
    sum += r.lodgingRevenueCents;
  }
  return sum;
}
