/**
 * Modelo canônico Yes Hotel (Gestão/CRM).
 * Independente de nomes de campo HITS. Mapper futuro: payload → estes tipos.
 * Valores monetários em centavos. `null` = desconhecido (não fabricar).
 */

import type { CalendarDate } from "./temporal.ts";
import { roomNightsBetween } from "./temporal.ts";

export type MoneyCents = number;

export type CanonicalSourceSystem = "hits" | "manual" | "unknown";

export type CanonicalReservationStatus =
  | "booked"
  | "cancelled"
  | "no_show"
  | "in_house"
  | "checked_out"
  | "unknown";

export type CanonicalStayStatus = "planned" | "occupied" | "completed" | "cancelled" | "no_show";

export type CanonicalChannelKind =
  | "direct"
  | "booking_engine"
  | "ota"
  | "b2b"
  | "manual"
  | "other"
  | "unknown";

export type CanonicalGuestRole = "principal" | "accompanying";

export type CanonicalIdentityKind = "cpf" | "passport";

export type CanonicalIdentityConfidence = "confirmed" | "suggested" | "missing";

export type CanonicalPaymentKind =
  | "hits_settled"
  | "pagarme"
  | "pix"
  | "card"
  | "manual"
  | "commissioned"
  | "partial"
  | "refund"
  | "adjustment"
  | "unknown";

export interface CanonicalChannelRef {
  kind: CanonicalChannelKind;
  /** Código estável Yes (ex.: booking, expedia). Não é ID HITS. */
  code: string | null;
  /** Rótulo de exibição já normalizado no Yes; não copiar JSON cru. */
  label: string | null;
}

export interface CanonicalGuestIdentity {
  kind: CanonicalIdentityKind;
  valueNormalized: string;
  confidence: Exclude<CanonicalIdentityConfidence, "missing">;
}

export interface CanonicalReservationGuestInput {
  role: CanonicalGuestRole;
  displayName: string;
  identity: CanonicalGuestIdentity | null;
  nationality: string | null;
  email: string | null;
  phone: string | null;
  externalGuestId: string | null;
}

/**
 * Contrato de entrada gerencial. Não contém campos HITS.
 * `bookedAt` / comissão / competência podem ser null até o PMS fornecer.
 */
export interface CanonicalReservationInput {
  sourceSystem: CanonicalSourceSystem;
  externalReservationId: string | null;
  status: CanonicalReservationStatus;
  /** ISO-8601 instante de criação/venda. Gap até HITS confirmar. */
  bookedAt: string | null;
  arrivalDate: CalendarDate;
  departureDate: CalendarDate;
  apartmentCode: string | null;
  channel: CanonicalChannelRef;
  companyExternalId: string | null;
  companyName: string | null;
  lodgingRevenueCents: MoneyCents | null;
  /** Comissão/custo de canal. Sem dado → null (receita líquida também null). */
  channelCommissionCents: MoneyCents | null;
  balanceDueCents: MoneyCents | null;
  guests: CanonicalReservationGuestInput[];
}

export interface CanonicalStayInput {
  reservationExternalId: string | null;
  apartmentCode: string | null;
  status: CanonicalStayStatus;
  arrivalDate: CalendarDate;
  departureDate: CalendarDate;
  lodgingRevenueCents: MoneyCents | null;
}

export interface CanonicalReceivable {
  id: string;
  reservationExternalId: string | null;
  dueDate: CalendarDate;
  amountCents: MoneyCents;
  openCents: MoneyCents;
}

export interface CanonicalFinancialEvent {
  kind: CanonicalPaymentKind;
  occurredAt: string | null;
  competenceDate: CalendarDate | null;
  amountCents: MoneyCents;
  reservationExternalId: string | null;
}

export interface CanonicalCompanyRef {
  externalId: string | null;
  name: string;
}

export function derivedRoomNights(input: {
  arrivalDate: CalendarDate;
  departureDate: CalendarDate;
}): number {
  return roomNightsBetween(input.arrivalDate, input.departureDate);
}

export function isEligibleForOccupancy(status: CanonicalReservationStatus | CanonicalStayStatus): boolean {
  return status === "booked" || status === "in_house" || status === "checked_out" || status === "occupied" || status === "completed" || status === "planned";
}

export function countsAsCancelledOrNoShow(status: CanonicalReservationStatus): boolean {
  return status === "cancelled" || status === "no_show";
}
