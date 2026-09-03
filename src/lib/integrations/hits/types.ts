/**
 * Tipos da integração HITS.
 *
 * Distinção obrigatória:
 * - DTO externo HITS: espelha schemas do Swagger (AccessSecret, AccessToken, WebCheckIn*, CheckInDto).
 * - Domínio interno Yes Hotel: InternalReservation / operacional_* (não importar aqui).
 * - Mapper futuro: hits/mapper.ts (já existente) traduz HITS → InternalReservation.
 *
 * Nenhum tipo abaixo deve carregar secret fora do objeto transitório de autenticação.
 */

/** DTO externo — HitsPms.ApiGateway.Security.AccessSecret */
export interface HitsAccessSecret {
  secret: string;
  propertyId: string;
  /** Ex.: WebCheckIn, InternetMgr, ChannelMgr, PtOfSale */
  scopes: string[];
}

/** DTO externo — HitsPms.ApiGateway.Security.AccessToken */
export interface HitsAccessToken {
  token: string;
  party: string;
}

/**
 * Token em memória (nunca persistir / logar / expor em erro).
 * `obtainedAtMs` é consultado na renovação preventiva (janela segura < 4h).
 */
export interface HitsSessionToken {
  token: string;
  party: string;
  obtainedAtMs: number;
}

export interface HitsProperty {
  propertyId?: string;
  propertyCode?: string | number;
  name?: string | null;
  tenantName?: string | null;
  /** Campos adicionais do Swagger ainda não tipados campo a campo. */
  [key: string]: unknown;
}

export interface HitsReservationSearchParams {
  /** 0=CheckIn Date, 1=Inclusion Date, 2=Update Date */
  type?: 0 | 1 | 2;
  /** 1=Confirmed, 2=Canceled, 3=Processed, 4=Blocked */
  status?: 1 | 2 | 3 | 4;
  initialDate?: string;
  finalDate?: string;
  reservationIntegrationId?: string;
  page?: number;
  size?: number;
}

/**
 * DTO externo aproximado de WebCheckInListDto / item de lista.
 * Campos alinhados ao Swagger; extras via index signature.
 */
export interface HitsReservationSummary {
  idReservation?: number | string;
  idEntity?: number | string | null;
  name?: string | null;
  main?: boolean | null;
  mail?: string | null;
  phone?: string | null;
  zipCode?: string | null;
  address?: string | null;
  number?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  country?: string | null;
  stateCode?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  dtBook?: string | null;
  status?: number | string | null;
  reservationIntegrationId?: string | null;
  reservationIntegratorId?: string | null;
  integrator?: string | null;
  reservationChannelId?: number | string | null;
  identity?: string | null;
  workingNationalDocument?: string | null;
  documentType?: string | null;
  [key: string]: unknown;
}

export type HitsReservationListResponse =
  | HitsReservationSummary[]
  | {
      data?: HitsReservationSummary[];
      items?: HitsReservationSummary[];
      results?: HitsReservationSummary[];
      [key: string]: unknown;
    };

export interface HitsReservationRoom {
  idRoom?: number | string;
  code?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  idRoomType?: number | string | null;
  roomTypeName?: string | null;
  amount?: number | null;
  status?: number | string | null;
  pax?: number | null;
  chd1?: number | null;
  chd2?: number | null;
  chd3?: number | null;
  ratePlanId?: number | string | null;
  ratePlanName?: string | null;
  mealPlanDesc?: string | null;
  requirementReservation?: unknown[];
  reservationRoomId?: number | string | null;
  [key: string]: unknown;
}

/** DTO externo — hóspede em ReservationDetailDto.guests[] */
export interface HitsGuest {
  idEntity?: number | string;
  name?: string | null;
  idRoom?: number | string | null;
  contactMail?: string | null;
  contactPhone?: string | null;
  main?: boolean | null;
  federalRegistrationNumber?: string | null;
  documentType?: string | null;
  notes?: unknown[];
  gender?: string | null;
  birthDate?: string | null;
  mainDocType?: string | null;
  docCpfCnpjPassport?: string | null;
  addressZipCode?: string | null;
  addressCountry?: string | null;
  addressStateCode?: string | null;
  addressStateName?: string | null;
  addressCity?: string | null;
  addressNeighborhood?: string | null;
  addressAddress?: string | null;
  addressDetails?: string | null;
  addressNumber?: string | null;
  [key: string]: unknown;
}

/** Parâmetros oficiais de GET /Datashare/RevenueManagement/Guests. */
export interface HitsGuestSearchParams {
  entityId?: string;
  since?: string;
  /** 1=Passaporte, 2=CPF, 3=RG, 7=Certidão de nascimento. */
  docType?: 1 | 2 | 3 | 7;
  doc?: string;
  email?: string;
  page?: number;
  size?: number;
}

export type HitsGuestListResponse =
  | HitsGuest[]
  | {
      data?: HitsGuest[];
      items?: HitsGuest[];
      results?: HitsGuest[];
      [key: string]: unknown;
    };

/** Enums Swagger V1 — escrita WebCheckinOut/Guests. */
export type HitsGuestDocumentType = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type HitsGuestContactType = 1 | 2 | 3 | 4;
export type HitsGuestGender = 0 | 1;
export type HitsGuestTitle = 1 | 2 | 3 | 4;
export type HitsGuestLang = 1 | 2 | 3;
export type HitsGuestPurposeTrip = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type HitsGuestArrivingBy = 0 | 1 | 2 | 3 | 4 | 5 | 7 | 8;
export type HitsGuestAccessibilityType = 1 | 2 | 3 | 4 | 5;

/** Item de POST /Datashare/WebCheckinOut/Guests/{reservationId}. Sem idEntity. */
export interface HitsWebCheckinGuestCreateItem {
  name: string;
  doc?: string;
  docType?: HitsGuestDocumentType;
  contact?: string;
  contactType?: HitsGuestContactType;
}

export interface HitsWebCheckinGuestsPostBody {
  guests: HitsWebCheckinGuestCreateItem[];
}

export interface HitsGuestNote {
  noteTypeId: number;
  note: string | null;
}

export interface HitsGuestAddress {
  address?: string | null;
  zipCode?: string | null;
  details?: string | null;
  neighborhood?: string | null;
  number?: string | null;
  country?: string | null;
  state?: string | null;
  city?: string | null;
}

/** DTO externo — GuestsPutDto (PUT /Datashare/WebCheckinOut/Guests). */
export interface HitsGuestsPutDto {
  idEntity: number;
  idReservation: number;
  name?: string;
  gender?: HitsGuestGender;
  birthdate?: string;
  contactType1?: HitsGuestContactType;
  contact1?: string;
  contactType2?: HitsGuestContactType;
  contact2?: string;
  title?: HitsGuestTitle;
  accessibility?: boolean;
  lang?: HitsGuestLang;
  companyName?: string;
  companyDocType?: HitsGuestDocumentType;
  companyDoc?: string;
  docType?: HitsGuestDocumentType;
  doc?: string;
  docStateRegistration?: string;
  notes?: HitsGuestNote[] | null;
  addresses?: HitsGuestAddress[] | null;
  foreign?: boolean;
  guestForeign?: boolean;
  purposeTrip?: HitsGuestPurposeTrip;
  arrivingBy?: HitsGuestArrivingBy;
  jobTitle?: string;
  accessibilityType?: HitsGuestAccessibilityType;
  nationalityCountryId?: number;
  carLicensePlate?: string;
}

/** Path oficial PUT (sem reservationId). */
export const HITS_WEBCHECKIN_GUESTS_PUT_PATH = "/Datashare/WebCheckinOut/Guests";

/** Path oficial POST; reservationId só no path. */
export function hitsWebCheckinGuestsPostPath(reservationId: string): string {
  return `${HITS_WEBCHECKIN_GUESTS_PUT_PATH}/${encodeURIComponent(reservationId)}`;
}

/** DTO externo — ReservationDetailDto (detalhe). */
export interface HitsReservationDetails {
  idReservation?: number | string;
  idEntityCompany?: number | string | null;
  companyName?: string | null;
  idRequesterCompany?: number | string | null;
  requesterCompanyName?: string | null;
  groupName?: string | null;
  contactName?: string | null;
  contact1?: string | null;
  contact2?: string | null;
  dateAdd?: string | null;
  dateUp?: string | null;
  notes?: unknown[];
  rooms?: HitsReservationRoom[];
  guests?: HitsGuest[];
  commissions?: unknown[];
  revenueManagement?: unknown;
  creditState?: unknown;
  reservationTotalAmount?: number | string | null;
  reservationBalanceDue?: number | string | null;
  chargeTags?: unknown[];
  [key: string]: unknown;
}

/**
 * Payload de request para check-in.
 * Swagger V1 NÃO declara requestBody em POST .../CheckIn (unverified).
 * CheckInDto (folioId, roomCode) é schema de RESPOSTA 200.
 */
export interface HitsCheckInRequest {
  folioId?: number;
  roomCode?: string;
}

/** DTO externo — HitsPms.ApiGateway.V1.Models.Folios.CheckInDto (resposta). */
export interface HitsCheckInResult {
  folioId?: number;
  roomCode?: string | null;
  [key: string]: unknown;
}

export type HitsHttpErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "invalid_json"
  | "empty_response"
  | "network"
  | "integration_disabled"
  | "checkin_disabled"
  | "missing_secret"
  | "missing_property_id"
  | "missing_context_headers"
  | "auth_contract_unverified"
  | "checkin_body_unverified"
  | "missing_reservation_id"
  | "unknown";

export interface HitsApiErrorShape {
  code: HitsHttpErrorCode;
  message: string;
  httpStatus: number | null;
  retryable: boolean;
  /** Nunca incluir secret/token aqui. */
  details?: Record<string, unknown>;
}

export interface HitsIntegrationStatus {
  integration_enabled: boolean;
  checkin_enabled: boolean;
  has_shared_secret: boolean;
  has_property_id: boolean;
  auth_contract: "verified" | "unverified";
  checkin_body_contract: "verified" | "unverified";
  transport_allowed: boolean;
}

export type HitsAccessMethod =
  | "room_passcode"
  | "gate_passcode"
  | "app"
  | "admin"
  | "card"
  | "key"
  | "other";

/* ---------- Aliases legados (mapper / scripts) ---------- */

/** @deprecated Use HitsAccessToken */
export type HitsAuthResponse = HitsAccessToken & {
  accessToken?: string;
  expiresIn?: number;
  [key: string]: unknown;
};

/** @deprecated Use HitsReservationSummary */
export type HitsReservationListItem = HitsReservationSummary;

/** @deprecated Use HitsGuest */
export type HitsReservationGuest = HitsGuest;

/** @deprecated Use HitsReservationDetails */
export type HitsReservationDetail = HitsReservationDetails;

/** @deprecated Use HitsReservationSearchParams */
export type ListReservationsParams = HitsReservationSearchParams;

export interface HitsInternalReservationPreview {
  reservationId: string | null;
  guestMainName: string | null;
  guestMainEmail: string | null;
  guestMainPhone: string | null;
  roomId: string | null;
  roomCode: string | null;
  checkIn: string | null;
  checkOut: string | null;
  updatedAt: string | null;
}

/**
 * Contrato de idempotência (sem migration nesta etapa).
 * Persistência em PR posterior. Nenhum check-in ativado antes disso.
 *
 * idempotency_key: NÃO usar dados pessoais (nome, documento, telefone, e-mail).
 * Preferir: hash(internal_reservation_id + first_room_access_event_id + "hits_checkin").
 * Não pode haver duas operações simultâneas para o mesmo primeiro acesso.
 */
export type HitsCheckInOperationStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "already_checked_in"
  | "manual_review";

export interface HitsCheckInOperation {
  internal_reservation_id: string;
  hits_reservation_id: string;
  first_room_access_event_id: string;
  operation: "hits_checkin";
  idempotency_key: string;
  status: HitsCheckInOperationStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
