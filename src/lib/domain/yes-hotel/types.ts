export type InternalReservationStatus =
  | "confirmed"
  | "canceled"
  | "in_house"
  | "checked_out"
  | "unknown";

export interface InternalReservation {
  reservationId: string;
  guestMainName: string;
  guestMainEmail?: string;
  guestMainPhone?: string;
  apartmentCode: string;
  checkIn: string | Date;
  checkOut: string | Date;
  status: InternalReservationStatus;
  updatedAt?: string | Date;
}

export interface ReservationAdjustment {
  earlyCheckInAt?: string | Date;
  lateCheckOutAt?: string | Date;
}

export interface CredentialWindow {
  validFrom: Date;
  validTo: Date;
  source: "default" | "early_checkin" | "late_checkout" | "manual_combined";
}

export interface AccessTarget {
  type: "apartment_lock" | "block_gate_external" | "block_gate_internal";
  blockCode: string;
  apartmentCode?: string;
  targetCode: string;
}

export interface ProvisionAction {
  action: "provision";
  target: AccessTarget;
  reason: string;
}

export interface RevocationAction {
  action: "revoke";
  target: AccessTarget;
  reason: string;
}

export type AccessAction = ProvisionAction | RevocationAction;

export interface AccessPlan {
  reservationId: string;
  apartmentCode: string;
  blockCode: string;
  window: CredentialWindow;
  targets: AccessTarget[];
  actions: AccessAction[];
}

export interface RoomChangePlan {
  reservationId: string;
  previousApartmentCode: string;
  nextApartmentCode: string;
  previousBlockCode: string;
  nextBlockCode: string;
  blockChanged: boolean;
  window: CredentialWindow;
  previousTargets: AccessTarget[];
  nextTargets: AccessTarget[];
  actions: AccessAction[];
}

export interface OperationalCredentialPreview {
  credentialId: string;
  pinPreview: string;
  notes: string;
}
