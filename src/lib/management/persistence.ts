/**
 * Contratos de persistência Gestão/CRM V1 (sem I/O).
 * Alinhado a docs/sql/management_crm_persistence_v1_proposal.sql.
 */

import type { CanonicalStayStatus } from "./canonical.ts";
import type { MoneyCents } from "./canonical.ts";
import { roomNightsBetween } from "./temporal.ts";

export const SNAPSHOT_SLOT_EOD = "eod";

export function reservationIdempotencyKey(
  sourceSystem: string,
  sourceReservationId: string,
): string {
  const sys = String(sourceSystem ?? "").trim();
  const id = String(sourceReservationId ?? "").trim();
  if (!sys || !id) {
    throw new Error("Idempotência de reserva exige source_system e source_reservation_id");
  }
  return `${sys}:${id}`;
}

export function snapshotUniquenessKey(
  asOfDate: string,
  stayDate: string,
  slot: string = SNAPSHOT_SLOT_EOD,
): string {
  const asOf = String(asOfDate ?? "").trim();
  const stay = String(stayDate ?? "").trim();
  const s = String(slot ?? "").trim() || SNAPSHOT_SLOT_EOD;
  if (!asOf || !stay) {
    throw new Error("Chave de snapshot exige as_of_date e stay_date");
  }
  return `${asOf}|${stay}|${s}`;
}

export function stayCountsTowardOccupancy(status: CanonicalStayStatus): boolean {
  return status === "planned" || status === "occupied" || status === "completed";
}

export type ReceivableAgingBucketV1 = "current" | "1_30" | "31_60" | "61_90" | "90_plus";

export type AgingRowV1 = {
  bucket: ReceivableAgingBucketV1;
  count: number;
  openCents: MoneyCents;
};

/** Aging V1: current = ainda não vencido (due >= asOf). Overdue começa em 1 dia. */
export function receivableAgingV1(
  items: Array<{ dueDate: string; openCents: number }>,
  asOfDate: string,
): AgingRowV1[] {
  const buckets: Record<ReceivableAgingBucketV1, AgingRowV1> = {
    current: { bucket: "current", count: 0, openCents: 0 },
    "1_30": { bucket: "1_30", count: 0, openCents: 0 },
    "31_60": { bucket: "31_60", count: 0, openCents: 0 },
    "61_90": { bucket: "61_90", count: 0, openCents: 0 },
    "90_plus": { bucket: "90_plus", count: 0, openCents: 0 },
  };

  for (const item of items) {
    if (!Number.isInteger(item.openCents) || item.openCents <= 0) continue;
    const daysLate = Math.round(
      (Date.parse(`${asOfDate}T00:00:00Z`) - Date.parse(`${item.dueDate}T00:00:00Z`)) /
        86_400_000,
    );
    let bucket: ReceivableAgingBucketV1 = "current";
    if (daysLate >= 91) bucket = "90_plus";
    else if (daysLate >= 61) bucket = "61_90";
    else if (daysLate >= 31) bucket = "31_60";
    else if (daysLate >= 1) bucket = "1_30";
    buckets[bucket].count += 1;
    buckets[bucket].openCents += item.openCents;
  }

  return [buckets.current, buckets["1_30"], buckets["31_60"], buckets["61_90"], buckets["90_plus"]];
}

export function shouldPersistChannelCost(amountCents: number | null | undefined): boolean {
  return amountCents != null && Number.isInteger(amountCents) && amountCents >= 0;
}

/** Espelha management_reservations_hits_source_id_check. Manual pode sem ID. */
export function hitsSourceReservationIdIsValid(
  sourceSystem: string,
  sourceReservationId: string | null | undefined,
): boolean {
  if (sourceSystem !== "hits") return true;
  return sourceReservationId != null && String(sourceReservationId).trim() !== "";
}

/**
 * Espelha checks de canal no SQL.
 * booking_engine ≠ booking OTA. Sem includes("booking").
 */
export function reservationChannelPairIsValid(
  channelKind: string,
  channelCode: string | null | undefined,
): boolean {
  const code = channelCode == null || String(channelCode).trim() === "" ? null : String(channelCode);
  if (code === "booking_engine" && channelKind !== "booking_engine") return false;
  if (code === "booking" && channelKind !== "ota") return false;
  return true;
}

/** Espelha management_stays_nights_match_schedule_check + checkout > checkin. */
export function stayNightsMatchSchedule(input: {
  nights: number;
  scheduledCheckinDate: string;
  scheduledCheckoutDate: string;
}): boolean {
  const expected = roomNightsBetween(input.scheduledCheckinDate, input.scheduledCheckoutDate);
  return expected > 0 && input.nights === expected;
}
