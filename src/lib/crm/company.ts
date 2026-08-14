/**
 * CRM B2B / empresa. Campanhas ficam fora desta fase.
 */

export type CompanyStayFact = {
  companyKey: string;
  reservationId: string;
  departureDate: string;
  lodgingRevenueCents: number;
  roomNights: number;
  guestMatchKeys: string[];
};

export type CompanyCrmSummary = {
  companyKey: string;
  name: string;
  reservationCount: number;
  roomNights: number;
  historicalRevenueCents: number;
  adrAverageCents: number | null;
  linkedGuestCount: number;
  lastStayDate: string | null;
  trend: "up" | "flat" | "down" | "unknown";
};

export function summarizeCompany(input: {
  companyKey: string;
  name: string;
  stays: CompanyStayFact[];
  previousPeriodRevenueCents?: number | null;
}): CompanyCrmSummary {
  const stays = input.stays.filter((s) => s.companyKey === input.companyKey);
  const reservationCount = stays.length;
  const roomNights = stays.reduce((s, x) => s + x.roomNights, 0);
  const revenue = stays.reduce((s, x) => s + x.lodgingRevenueCents, 0);
  const guests = new Set(stays.flatMap((s) => s.guestMatchKeys));
  const lastStayDate =
    stays.length === 0
      ? null
      : stays.map((s) => s.departureDate).sort()[stays.length - 1];

  let trend: CompanyCrmSummary["trend"] = "unknown";
  if (input.previousPeriodRevenueCents != null && input.previousPeriodRevenueCents >= 0) {
    if (revenue > input.previousPeriodRevenueCents) trend = "up";
    else if (revenue < input.previousPeriodRevenueCents) trend = "down";
    else trend = "flat";
  }

  return {
    companyKey: input.companyKey,
    name: input.name,
    reservationCount,
    roomNights,
    historicalRevenueCents: revenue,
    adrAverageCents: roomNights > 0 ? revenue / roomNights : null,
    linkedGuestCount: guests.size,
    lastStayDate,
    trend,
  };
}
