/**
 * Classificação de canal a partir de rótulos de relatório.
 * Booking Engine ≠ Booking.com. Nunca usar includes("booking").
 */
import type { CanonicalChannelKind } from "../canonical.ts";
import { channelGroup } from "../channel.ts";
import { normalizeReportText } from "./normalize.ts";

export type ReportChannel = {
  kind: CanonicalChannelKind;
  code: string;
  label: string;
  group: ReturnType<typeof channelGroup>;
};

const OTA_EXACT: Record<string, { code: string; label: string }> = {
  BOOKING: { code: "booking", label: "Booking.com" },
  "BOOKING COM": { code: "booking", label: "Booking.com" },
  EXPEDIA: { code: "expedia", label: "Expedia" },
  "EXPEDIA COM": { code: "expedia", label: "Expedia" },
  AIRBNB: { code: "airbnb", label: "Airbnb" },
  DESPEGAR: { code: "despegar", label: "Despegar" },
  "DESPEGAR DYNAMICS": { code: "despegar", label: "Despegar" },
};

function isBookingEngine(norm: string): boolean {
  return norm === "BOOKING ENGINE" || norm.startsWith("BOOKING ENGINE ");
}

function isBeMobile(norm: string): boolean {
  return norm === "BE MOBILE" || norm.startsWith("BE MOBILE ");
}

function looksB2b(norm: string): boolean {
  if (!norm) return false;
  if (
    /\b(LTDA|S A|SA|TMC|ONFLY|PAYTRACK|COPASTUR|CONCUR|VIAGENS|TURISMO|AGENCI|TRAVEL|BANCO|FEDERAL|SANTANDER|CAIXA|BIOLAB|NCR|AZUL LINHAS|VOTORANTIM|ESSILOR|SONOVA|BUREAU VERITAS|FLYTOUR|KONTIK|FRANSTUR|TOUR HOUSE|QUICKLY|PUNTO|MARINGA|CAPUA|SOLUCOES EM VIAGENS)\b/.test(
      norm,
    )
  ) {
    return true;
  }
  return false;
}

export function classifyReportChannel(raw: string): ReportChannel {
  const norm = normalizeReportText(raw);
  if (!norm) {
    return { kind: "unknown", code: "unknown", label: "Não identificado", group: "other" };
  }
  if (isBookingEngine(norm)) {
    return { kind: "booking_engine", code: "booking_engine", label: "Booking Engine", group: "direct" };
  }
  if (isBeMobile(norm)) {
    return { kind: "direct", code: "be_mobile", label: "BE Mobile", group: "direct" };
  }
  const ota = OTA_EXACT[norm];
  if (ota) {
    return { kind: "ota", code: ota.code, label: ota.label, group: "ota" };
  }
  if (norm === "SOLD") {
    return { kind: "direct", code: "sold", label: "Direto (SOLD)", group: "direct" };
  }
  if (looksB2b(norm)) {
    return { kind: "b2b", code: "b2b", label: "B2B", group: "b2b" };
  }
  return { kind: "unknown", code: "unknown", label: "Não identificado", group: "other" };
}

export function isOtaBrandLabel(raw: string): boolean {
  const ch = classifyReportChannel(raw);
  return ch.kind === "ota";
}
