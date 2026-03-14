import type {
  AccessAction,
  AccessTarget,
  CredentialWindow,
  InternalReservation,
  OperationalCredentialPreview,
  ReservationAdjustment,
} from "../../domain/yes-hotel";

export type ReservationOperationalEventType =
  | "reservation_created"
  | "reservation_updated"
  | "reservation_canceled"
  | "room_changed"
  | "manual_adjustment";

export interface ReservationOperationalContext {
  eventType: ReservationOperationalEventType;
  currentReservation: InternalReservation;
  previousReservation?: InternalReservation;
  adjustment?: ReservationAdjustment;
}

export interface ReservationOperationalSummary {
  reservationId: string;
  guestMainName: string;
  apartmentCode: string;
  blockCode: string;
  status: InternalReservation["status"];
  eventType: ReservationOperationalEventType;
}

export interface ReservationOperationalPlan {
  eventType: ReservationOperationalEventType;
  reservationId: string;
  summary: ReservationOperationalSummary;
  window?: CredentialWindow;
  credentialPreview?: OperationalCredentialPreview;
  targets: AccessTarget[];
  actions: AccessAction[];
  notes: string[];
}
