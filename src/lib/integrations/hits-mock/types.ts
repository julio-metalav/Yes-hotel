export interface HitsMockReservationListItem {
  idReservation?: number | string;
  identity?: string | null;
  name?: string | null;
  mail?: string | null;
  phone?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  status?: number | string | null;
  reservationIntegrationId?: string | null;
  reservationChannelId?: number | string | null;
}

export interface HitsMockReservationRoom {
  idRoom?: number | string;
  code?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
  idRoomType?: number | string | null;
  roomTypeName?: string | null;
  amount?: number | null;
  status?: number | string | null;
  pax?: number | null;
  reservationRoomId?: number | string | null;
}

export interface HitsMockReservationGuest {
  idEntity?: number | string;
  name?: string | null;
  idRoom?: number | string | null;
  contactMail?: string | null;
  contactPhone?: string | null;
  main?: boolean | null;
  federalRegistrationNumber?: string | null;
  documentType?: string | null;
}

export interface HitsMockReservationDetail {
  idReservation?: number | string;
  dateAdd?: string | null;
  dateUp?: string | null;
  contactName?: string | null;
  contact1?: string | null;
  contact2?: string | null;
  rooms?: HitsMockReservationRoom[];
  guests?: HitsMockReservationGuest[];
  status?: number | string | null;
  notes?: unknown[];
}
