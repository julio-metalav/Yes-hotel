/**
 * Modelo interno de sincronização de reservas (independente de InternalReservation).
 * Não inventa contrato oficial HITS — campos ausentes = null.
 */

export type SyncedPaymentStatus = "pago" | "pendente" | "parcial" | "desconhecido";

export type SyncedReservationStatus = "ativa" | "cancelada";

export type SyncedGuest = {
  externalGuestId: string | null;
  name: string;
  isPrincipal: boolean;
  isMinor: boolean | null;
  phone: string | null;
  email: string | null;
  birthDate?: string | null;
  gender?: string | null;
  nationality?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
};

export type SyncedReservation = {
  provider: "hits";
  externalReservationId: string;
  sourceUpdatedAt: string | null;
  syncedAt: string | null;
  reservationStatus: SyncedReservationStatus;
  checkIn: string;
  checkOut: string;
  apartmentCode: string;
  mainGuestName: string;
  guests: SyncedGuest[];
  adults: number | null;
  minors: number | null;
  totalGuests: number;
  /**
   * Texto bruto HITS `rooms[].mealPlanDesc`.
   * Não interpretar como incluído/avulso sem homologação explícita.
   */
  mealPlanDesc: string | null;
  paymentStatus: SyncedPaymentStatus;
  phone: string | null;
  email: string | null;
  /** Gestor de canal HITS (`integrator`). */
  channelManager: string | null;
  /** Canal de vendas/origem (companyName / sales channel). */
  salesChannel: string | null;
  /** Empresa/solicitante de faturamento. */
  billingEntity: string | null;
  reservationChannelId: string | null;
  reservationBalanceDue: number | null;
  reservationTotalAmount: number | null;
  /** Classificação derivada no sync (hits_campo). */
  classificacaoComissionamento: "nao_comissionada" | "comissionada" | null;
  /** Snapshot sanitizado (sem tokens/senhas). */
  rawSanitized: Record<string, unknown> | null;
};

export type ReservationSourcePage = {
  items: SyncedReservation[];
  nextCursor: string | null;
  page: number;
  hasMore: boolean;
};

export type ReservationSourceListParams = {
  cursor?: string | null;
  pageSize?: number;
  /** ISO date YYYY-MM-DD — janela opcional. */
  dateFrom?: string | null;
  dateTo?: string | null;
};

/**
 * Port desacoplado: mock HITS agora; adapter real futuro sem reescrever sync.
 */
export interface ReservationSourcePort {
  listReservations(params?: ReservationSourceListParams): Promise<ReservationSourcePage>;
  getReservation(externalReservationId: string): Promise<SyncedReservation | null>;
}
