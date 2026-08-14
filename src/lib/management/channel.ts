/**
 * Taxonomia comercial canônica.
 * Booking Engine ≠ Booking OTA. Nunca usar includes("booking").
 * originKind operacional (classificador existente) pode ser projetado aqui
 * sem ler JSON HITS.
 */

import type { CanonicalChannelKind, CanonicalChannelRef } from "./canonical.ts";

export type OperationalOriginKind =
  | "b2b"
  | "ota"
  | "booking_engine"
  | "motor_particular"
  | "manual_hits"
  | "unknown";

const OTA_CODES = new Set(["booking", "expedia", "hotels_com", "airbnb"]);

export function channelKindFromOperationalOrigin(
  originKind: OperationalOriginKind,
): CanonicalChannelKind {
  if (originKind === "b2b") return "b2b";
  if (originKind === "ota") return "ota";
  if (originKind === "booking_engine") return "booking_engine";
  if (originKind === "motor_particular") return "direct";
  if (originKind === "manual_hits") return "manual";
  return "unknown";
}

export function canonicalChannelFromOperational(input: {
  originKind: OperationalOriginKind;
  matchedOtaId?: string | null;
  label?: string | null;
}): CanonicalChannelRef {
  const kind = channelKindFromOperationalOrigin(input.originKind);
  let code: string | null = null;
  if (kind === "ota") {
    const id = String(input.matchedOtaId ?? "").trim();
    code = id && OTA_CODES.has(id) ? id : id || "ota";
  } else if (kind === "booking_engine") {
    code = "booking_engine";
  } else if (kind === "b2b") {
    code = "b2b";
  } else if (kind === "direct") {
    code = "direct";
  } else if (kind === "manual") {
    code = "manual";
  }
  const label = String(input.label ?? "").trim() || null;
  return { kind, code, label };
}

export function channelGroup(kind: CanonicalChannelKind): "direct" | "ota" | "b2b" | "other" {
  if (kind === "direct" || kind === "booking_engine" || kind === "manual") return "direct";
  if (kind === "ota") return "ota";
  if (kind === "b2b") return "b2b";
  return "other";
}
