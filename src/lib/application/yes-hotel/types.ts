import type {
  AccessAction,
  AccessTarget,
  CredentialWindow,
  InternalReservation,
  OperationalCredentialPreview,
  ReservationAdjustment,
} from "../../domain/yes-hotel";

/** Motivo de origem da credencial (espelho do enum no banco). */
export type OperacionalMotivoOrigem =
  | "checkin_normal"
  | "early_checkin"
  | "late_checkout"
  | "room_change"
  | "manual_adjustment"
  | "cancelamento";

/** Status da credencial operacional. */
export type OperacionalCredencialStatus =
  | "pendente"
  | "pronta"
  | "provisionando"
  | "provisionada"
  | "parcial"
  | "falhou"
  | "revogada";

/** Status do item de provisionamento. */
export type OperacionalItemProvisionamentoStatus =
  | "pendente"
  | "provisionando"
  | "provisionado"
  | "falhou"
  | "revogado";

/** Fila de fechadura vinda do banco (para resolução de destinos). */
export interface FechaduraRow {
  id: string;
  identificador_externo_ttlock: string;
  tipo_fechadura: "apartamento" | "portao_externo" | "portao_interno";
  apartamento_numero?: string | null;
  portao_identificador?: string | null;
}

/** Destino de provisionamento com lock_id real (para persistência). */
export interface ProvisioningDestination {
  fechaduraId: string;
  lockIdTtlock: string;
  tipoDestino: "apartamento" | "portao_externo" | "portao_interno";
  codigoLogicoDestino: string;
}

/** Plano de provisionamento pronto para persistir (credencial + itens). */
export interface ProvisioningPlanToPersist {
  validoDe: Date;
  validoAte: Date;
  motivoOrigem: OperacionalMotivoOrigem;
  destinations: ProvisioningDestination[];
}

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
