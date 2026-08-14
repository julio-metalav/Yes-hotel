/**
 * On-the-books e pickup exigem snapshots no tempo (as-of), não só o estado atual.
 * Pickup(T1→T2, janela de estadia S) = OTB(asOf=T2, S) − OTB(asOf=T1, S).
 */

import type { MoneyCents } from "./canonical.ts";
import type { CalendarDate } from "./temporal.ts";

export type OnTheBooksHorizonDays = 7 | 14 | 30 | 60 | 90;

export interface DailyOnTheBooksSnapshot {
  /** Momento em que a foto foi tirada (YYYY-MM-DD civil). */
  asOfDate: CalendarDate;
  /** Noite de estadia fotografada. */
  stayDate: CalendarDate;
  roomsOnBooks: number;
  lodgingRevenueCents: MoneyCents | null;
  reservationCount: number;
}

export type PickupResult = {
  stayDate: CalendarDate;
  roomsDelta: number;
  revenueDeltaCents: MoneyCents | null;
  reservationsDelta: number;
};

function key(asOf: string, stay: string): string {
  return `${asOf}|${stay}`;
}

export function indexSnapshots(
  rows: DailyOnTheBooksSnapshot[],
): Map<string, DailyOnTheBooksSnapshot> {
  const map = new Map<string, DailyOnTheBooksSnapshot>();
  for (const row of rows) {
    map.set(key(row.asOfDate, row.stayDate), row);
  }
  return map;
}

/**
 * Pickup por noite de estadia entre dois as-of.
 * Receita: se qualquer lado for null, delta de receita é null.
 */
export function computePickup(input: {
  earlierAsOf: CalendarDate;
  laterAsOf: CalendarDate;
  stayDates: CalendarDate[];
  snapshots: DailyOnTheBooksSnapshot[];
}): PickupResult[] {
  if (input.laterAsOf <= input.earlierAsOf) {
    throw new Error("laterAsOf deve ser posterior a earlierAsOf");
  }
  const idx = indexSnapshots(input.snapshots);
  return input.stayDates.map((stayDate) => {
    const earlier = idx.get(key(input.earlierAsOf, stayDate));
    const later = idx.get(key(input.laterAsOf, stayDate));
    const roomsEarlier = earlier?.roomsOnBooks ?? 0;
    const roomsLater = later?.roomsOnBooks ?? 0;
    const resEarlier = earlier?.reservationCount ?? 0;
    const resLater = later?.reservationCount ?? 0;
    const revEarlier = earlier?.lodgingRevenueCents ?? null;
    const revLater = later?.lodgingRevenueCents ?? null;
    return {
      stayDate,
      roomsDelta: roomsLater - roomsEarlier,
      reservationsDelta: resLater - resEarlier,
      revenueDeltaCents:
        revEarlier == null || revLater == null ? null : revLater - revEarlier,
    };
  });
}

export function onTheBooksForHorizon(input: {
  asOfDate: CalendarDate;
  fromStayDate: CalendarDate;
  toStayDate: CalendarDate;
  snapshots: DailyOnTheBooksSnapshot[];
}): {
  roomsOnBooks: number;
  lodgingRevenueCents: MoneyCents | null;
  reservationCount: number;
} {
  const rows = input.snapshots.filter(
    (s) =>
      s.asOfDate === input.asOfDate &&
      s.stayDate >= input.fromStayDate &&
      s.stayDate <= input.toStayDate,
  );
  let rooms = 0;
  let reservations = 0;
  let revenue = 0;
  let revenueKnown = true;
  for (const row of rows) {
    rooms += row.roomsOnBooks;
    reservations += row.reservationCount;
    if (row.lodgingRevenueCents == null) revenueKnown = false;
    else revenue += row.lodgingRevenueCents;
  }
  return {
    roomsOnBooks: rooms,
    reservationCount: reservations,
    lodgingRevenueCents: revenueKnown ? revenue : null,
  };
}
