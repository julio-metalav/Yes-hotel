export interface HitsAuthResponse {
  accessToken?: string;
  token?: string;
  expiresIn?: number;
  [key: string]: unknown;
}

export interface HitsReservationListItem {
  idReservation?: number | string;
  identity?: string | null;
  name?: string | null;
  mail?: string | null;
  phone?: string | null;
  zipCode?: string | null;
  address?: string | null;
  number?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  country?: string | null;
  stateCode?: string | null;
  workingNationalDocument?: string | null;
  documentType?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  dtBook?: string | null;
  status?: number | string | null;
  reservationIntegrationId?: string | null;
  reservationIntegratorId?: string | null;
  integrator?: string | null;
  reservationChannelId?: number | string | null;
  [key: string]: unknown;
}

export type HitsReservationListResponse =
  | HitsReservationListItem[]
  | {
      data?: HitsReservationListItem[];
      items?: HitsReservationListItem[];
      results?: HitsReservationListItem[];
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

export interface HitsReservationGuest {
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

export interface HitsReservationDetail {
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
  guests?: HitsReservationGuest[];
  commissions?: unknown[];
  revenueManagement?: unknown;
  creditState?: unknown;
  reservationTotalAmount?: number | string | null;
  reservationBalanceDue?: number | string | null;
  chargeTags?: unknown[];
  [key: string]: unknown;
}

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

export interface ListReservationsParams {
  type?: 0 | 1 | 2;
  status?: 1 | 2 | 3 | 4;
  initialDate?: string;
  finalDate?: string;
  reservationIntegrationId?: string;
  page?: number;
  size?: number;
}
