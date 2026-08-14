import { nightsBetween } from "./dates.ts";
import { isOtaBrandLabel } from "./channel-from-report.ts";
import { normalizeReportText } from "./normalize.ts";

export type ReconciliationStatus = "exact" | "high_confidence" | "unmatched" | "ambiguous";

export type OmniReservation = {
  resNo: string;
  estado: string;
  checkin: string;
  checkout: string;
  guestNorm: string;
  channelRaw: string;
  los: number | null;
};

export type HitsStay = {
  stayKey: string;
  guestNorm: string;
  guestRaw: string;
  checkin: string;
  checkout: string;
};

export type StayMatch = {
  stayKey: string;
  status: ReconciliationStatus;
  omniResNo: string | null;
  channelRaw: string | null;
};

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return [...map.values()].filter((g) => g.length === 1).map((g) => g[0]);
}

export function reconcileHitsStay(stay: HitsStay, omnibees: OmniReservation[]): StayMatch {
  if (isOtaBrandLabel(stay.guestRaw) || stay.guestNorm.length < 6) {
    return { stayKey: stay.stayKey, status: "unmatched", omniResNo: null, channelRaw: null };
  }
  const confirmed = omnibees.filter((o) => o.estado === "Confirmada");
  const exact = confirmed.filter(
    (o) => o.guestNorm === stay.guestNorm && o.checkin === stay.checkin && o.checkout === stay.checkout,
  );
  if (exact.length === 1) {
    return {
      stayKey: stay.stayKey,
      status: "exact",
      omniResNo: exact[0].resNo,
      channelRaw: exact[0].channelRaw,
    };
  }
  if (exact.length > 1) {
    return { stayKey: stay.stayKey, status: "ambiguous", omniResNo: null, channelRaw: null };
  }

  const los = nightsBetween(stay.checkin, stay.checkout);
  const byInLos = confirmed.filter(
    (o) => o.guestNorm === stay.guestNorm && o.checkin === stay.checkin && o.los != null && o.los === los,
  );
  const uniqueInLos = uniqueBy(byInLos, (o) => o.resNo);
  if (uniqueInLos.length === 1) {
    return {
      stayKey: stay.stayKey,
      status: "high_confidence",
      omniResNo: uniqueInLos[0].resNo,
      channelRaw: uniqueInLos[0].channelRaw,
    };
  }
  if (byInLos.length > 1) {
    return { stayKey: stay.stayKey, status: "ambiguous", omniResNo: null, channelRaw: null };
  }

  return { stayKey: stay.stayKey, status: "unmatched", omniResNo: null, channelRaw: null };
}

export { normalizeReportText };
