/**
 * Recorrência, RF simples e segmentos — parametrizáveis, sem modelo preditivo.
 */

export type RecurrencePolicy = {
  minCompletedStays: number;
};

export const DEFAULT_RECURRENCE_POLICY: RecurrencePolicy = {
  minCompletedStays: 2,
};

export type GuestStayFact = {
  matchKey: string;
  stayId: string;
  departureDate: string;
  lodgingRevenueCents: number;
  roomNights: number;
  channelKind: string;
};

export type GuestCrmSummary = {
  matchKey: string;
  stayCount: number;
  roomNights: number;
  historicalRevenueCents: number;
  ticketAverageCents: number | null;
  adrAverageCents: number | null;
  firstStayDate: string | null;
  lastStayDate: string | null;
  firstChannelKind: string | null;
  laterChannelKinds: string[];
  /** Primeira estadia OTA e depois direto / Booking Engine. B2B não entra aqui. */
  otaToDirectReturn: boolean;
  /** Primeira estadia B2B e depois direto / Booking Engine. Distinto de OTA→direto. */
  b2bToDirectReturn: boolean;
  recencyDays: number | null;
  isRecurrent: boolean;
  segment: "high_value" | "frequent" | "inactive" | "corporate_linked" | "standard";
};

export function isRecurrentGuest(
  stayCount: number,
  policy: RecurrencePolicy = DEFAULT_RECURRENCE_POLICY,
): boolean {
  return stayCount >= policy.minCompletedStays;
}

export function historicalLtvCents(stays: Array<{ lodgingRevenueCents: number }>): number {
  return stays.reduce((sum, s) => sum + (Number.isInteger(s.lodgingRevenueCents) ? s.lodgingRevenueCents : 0), 0);
}

export function summarizeGuest(input: {
  matchKey: string;
  stays: GuestStayFact[];
  asOfDate: string;
  policy?: RecurrencePolicy;
  highValueMinCents?: number;
  inactiveAfterDays?: number;
  corporate?: boolean;
}): GuestCrmSummary {
  const policy = input.policy ?? DEFAULT_RECURRENCE_POLICY;
  const ordered = [...input.stays].sort((a, b) => a.departureDate.localeCompare(b.departureDate));
  const stayCount = ordered.length;
  const roomNights = ordered.reduce((s, x) => s + x.roomNights, 0);
  const revenue = historicalLtvCents(ordered);
  const first = ordered[0] ?? null;
  const last = ordered[stayCount - 1] ?? null;
  const laterChannelKinds = [...new Set(ordered.slice(1).map((s) => s.channelKind))];
  const laterIsDirectOwned = laterChannelKinds.some(
    (k) => k === "direct" || k === "booking_engine",
  );
  const otaToDirectReturn = Boolean(first && first.channelKind === "ota" && laterIsDirectOwned);
  const b2bToDirectReturn = Boolean(first && first.channelKind === "b2b" && laterIsDirectOwned);

  const recencyDays =
    last == null
      ? null
      : Math.round(
          (Date.parse(`${input.asOfDate}T00:00:00Z`) - Date.parse(`${last.departureDate}T00:00:00Z`)) /
            86_400_000,
        );

  const recurrent = isRecurrentGuest(stayCount, policy);
  const highValueMin = input.highValueMinCents ?? 500_000;
  const inactiveAfter = input.inactiveAfterDays ?? 365;

  let segment: GuestCrmSummary["segment"] = "standard";
  if (input.corporate) segment = "corporate_linked";
  else if (recencyDays != null && recencyDays >= inactiveAfter && stayCount > 0) segment = "inactive";
  else if (revenue >= highValueMin) segment = "high_value";
  else if (recurrent) segment = "frequent";

  return {
    matchKey: input.matchKey,
    stayCount,
    roomNights,
    historicalRevenueCents: revenue,
    ticketAverageCents: stayCount > 0 ? revenue / stayCount : null,
    adrAverageCents: roomNights > 0 ? revenue / roomNights : null,
    firstStayDate: first?.departureDate ?? null,
    lastStayDate: last?.departureDate ?? null,
    firstChannelKind: first?.channelKind ?? null,
    laterChannelKinds,
    otaToDirectReturn,
    b2bToDirectReturn,
    recencyDays,
    isRecurrent: recurrent,
    segment,
  };
}
