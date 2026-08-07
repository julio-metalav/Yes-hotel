/**
 * Persistência do sync de reservas — ports testáveis.
 * Projeção operacional preserva linhas (cancelamento lógico).
 */

import type {
  SyncedPaymentStatus,
  SyncedReservation,
  SyncedReservationStatus,
} from "../../domain/yes-hotel/synced-reservation.ts";
import type {
  ReservationChangeEvent,
  SyncedReservationSnapshot,
} from "../../domain/yes-hotel/reservation-sync-diff.ts";

export type PersistedOperacionalReserva = {
  id: string;
  apartamento: string;
  hospede_principal: string;
  check_in_previsto: string;
  check_out_previsto: string;
  pagamento_status: SyncedPaymentStatus;
  acesso_liberado: boolean;
  entrou_no_apto: boolean;
  origem_externa: string;
  external_reservation_id: string;
  status_reserva: SyncedReservationStatus;
  synced_at: string | null;
  fnrh_status_agregado: string;
};

export type PersistedOperacionalHospede = {
  id: string;
  reserva_id: string;
  nome: string;
  principal: boolean;
  email: string;
  whatsapp: string;
  pms_external_guest_id: string | null;
  removed_from_reservation: boolean;
};

export type PersistedPmsReserva = {
  id: string;
  provider: string;
  external_reservation_id: string;
  unit_code: string;
  check_in: string;
  check_out: string;
  status_raw: string;
  is_cancelled: boolean;
  payment_mapped: SyncedPaymentStatus;
  hospede_principal_nome: string;
  guest_count: number;
  raw_payload: Record<string, unknown>;
  pms_updated_at: string | null;
  synced_at: string;
};

export type PersistedEvento = {
  id: string;
  reserva_id: string;
  tipo: string;
  titulo: string;
  detalhe: string;
  criado_em: string;
};

export type PersistedSyncRun = {
  id: string;
  provider: string;
  status: "running" | "success" | "partial" | "failed";
  started_at: string;
  finished_at: string | null;
  stats: Record<string, unknown>;
  message: string | null;
};

export interface ReservationSyncRepository {
  findPmsSnapshot(
    provider: string,
    externalReservationId: string,
  ): Promise<SyncedReservationSnapshot | null>;
  upsertFromSynced(
    reservation: SyncedReservation,
    events: ReservationChangeEvent[],
    options: { dryRun: boolean; nowIso: string },
  ): Promise<{
    operacionalId: string;
    created: boolean;
    updated: boolean;
    eventsWritten: number;
  }>;
  startSyncRun(input: {
    provider: string;
    nowIso: string;
    dryRun: boolean;
  }): Promise<string>;
  finishSyncRun(
    id: string,
    patch: {
      status: PersistedSyncRun["status"];
      finished_at: string;
      stats: Record<string, unknown>;
      message?: string | null;
    },
  ): Promise<void>;
  recordSyncError(input: {
    sync_run_id: string;
    severity: "warn" | "error" | "fatal";
    step: string;
    message: string;
    context?: Record<string, unknown>;
  }): Promise<void>;
}

export type MemorySyncState = {
  pmsReservas: PersistedPmsReserva[];
  pmsHospedes: Array<{
    id: string;
    provider: string;
    external_guest_id: string;
    nome: string;
    email: string;
    telefone: string;
  }>;
  pmsLinks: Array<{
    pms_reserva_id: string;
    pms_hospede_id: string;
    is_principal: boolean;
  }>;
  operacionalReservas: PersistedOperacionalReserva[];
  operacionalHospedes: PersistedOperacionalHospede[];
  eventos: PersistedEvento[];
  syncRuns: PersistedSyncRun[];
  syncErrors: Array<{
    id: string;
    sync_run_id: string;
    severity: string;
    step: string;
    message: string;
    context: Record<string, unknown>;
  }>;
};

function rid(): string {
  return `id-${Math.random().toString(36).slice(2, 10)}`;
}

export function createEmptyMemorySyncState(): MemorySyncState {
  return {
    pmsReservas: [],
    pmsHospedes: [],
    pmsLinks: [],
    operacionalReservas: [],
    operacionalHospedes: [],
    eventos: [],
    syncRuns: [],
    syncErrors: [],
  };
}

export class InMemoryReservationSyncRepository implements ReservationSyncRepository {
  constructor(readonly state: MemorySyncState = createEmptyMemorySyncState()) {}

  async findPmsSnapshot(
    provider: string,
    externalReservationId: string,
  ): Promise<SyncedReservationSnapshot | null> {
    const pms = this.state.pmsReservas.find(
      (r) =>
        r.provider === provider && r.external_reservation_id === externalReservationId,
    );
    if (!pms) return null;
    const links = this.state.pmsLinks.filter((l) => l.pms_reserva_id === pms.id);
    const guestIds = links
      .map((l) => this.state.pmsHospedes.find((h) => h.id === l.pms_hospede_id)?.external_guest_id)
      .filter((x): x is string => Boolean(x))
      .sort();
    return {
      externalReservationId: pms.external_reservation_id,
      reservationStatus: pms.is_cancelled ? "cancelada" : "ativa",
      checkIn: pms.check_in,
      checkOut: pms.check_out,
      apartmentCode: pms.unit_code,
      mainGuestName: pms.hospede_principal_nome,
      totalGuests: pms.guest_count || guestIds.length || 1,
      paymentStatus: pms.payment_mapped,
      phone:
        this.state.pmsHospedes.find((h) =>
          links.some((l) => l.pms_hospede_id === h.id && l.is_principal),
        )?.telefone || null,
      email:
        this.state.pmsHospedes.find((h) =>
          links.some((l) => l.pms_hospede_id === h.id && l.is_principal),
        )?.email || null,
      guestIds,
    };
  }

  async upsertFromSynced(
    reservation: SyncedReservation,
    events: ReservationChangeEvent[],
    options: { dryRun: boolean; nowIso: string },
  ): Promise<{
    operacionalId: string;
    created: boolean;
    updated: boolean;
    eventsWritten: number;
  }> {
    if (options.dryRun) {
      const existing = this.state.operacionalReservas.find(
        (r) =>
          r.origem_externa === "hits" &&
          r.external_reservation_id === reservation.externalReservationId,
      );
      return {
        operacionalId: existing?.id ?? "dry-run",
        created: !existing,
        updated: Boolean(existing) && events.length > 0,
        eventsWritten: 0,
      };
    }

    let pms = this.state.pmsReservas.find(
      (r) =>
        r.provider === "hits" &&
        r.external_reservation_id === reservation.externalReservationId,
    );
    const created = !pms;
    if (!pms) {
      pms = {
        id: rid(),
        provider: "hits",
        external_reservation_id: reservation.externalReservationId,
        unit_code: reservation.apartmentCode,
        check_in: reservation.checkIn,
        check_out: reservation.checkOut,
        status_raw: reservation.reservationStatus,
        is_cancelled: reservation.reservationStatus === "cancelada",
        payment_mapped: reservation.paymentStatus,
        hospede_principal_nome: reservation.mainGuestName,
        guest_count: reservation.totalGuests,
        raw_payload: reservation.rawSanitized ?? {},
        pms_updated_at: reservation.sourceUpdatedAt,
        synced_at: options.nowIso,
      };
      this.state.pmsReservas.push(pms);
    } else {
      pms.unit_code = reservation.apartmentCode;
      pms.check_in = reservation.checkIn;
      pms.check_out = reservation.checkOut;
      pms.status_raw = reservation.reservationStatus;
      pms.is_cancelled = reservation.reservationStatus === "cancelada";
      pms.payment_mapped = reservation.paymentStatus;
      pms.hospede_principal_nome = reservation.mainGuestName;
      pms.guest_count = reservation.totalGuests;
      pms.raw_payload = reservation.rawSanitized ?? {};
      pms.pms_updated_at = reservation.sourceUpdatedAt;
      pms.synced_at = options.nowIso;
    }

    // Hóspedes espelho
    this.state.pmsLinks = this.state.pmsLinks.filter((l) => l.pms_reserva_id !== pms!.id);
    for (const g of reservation.guests) {
      const gid = g.externalGuestId || `anon:${reservation.externalReservationId}:${g.name}`;
      const phone =
        g.phone ?? (g.isPrincipal ? reservation.phone : null) ?? "";
      const email =
        g.email ?? (g.isPrincipal ? reservation.email : null) ?? "";
      let ph = this.state.pmsHospedes.find(
        (h) => h.provider === "hits" && h.external_guest_id === gid,
      );
      if (!ph) {
        ph = {
          id: rid(),
          provider: "hits",
          external_guest_id: gid,
          nome: g.name,
          email,
          telefone: phone,
        };
        this.state.pmsHospedes.push(ph);
      } else {
        ph.nome = g.name;
        ph.email = email;
        ph.telefone = phone;
      }
      this.state.pmsLinks.push({
        pms_reserva_id: pms.id,
        pms_hospede_id: ph.id,
        is_principal: g.isPrincipal,
      });
    }

    let op = this.state.operacionalReservas.find(
      (r) =>
        r.origem_externa === "hits" &&
        r.external_reservation_id === reservation.externalReservationId,
    );
    if (!op) {
      op = {
        id: rid(),
        apartamento: reservation.apartmentCode,
        hospede_principal: reservation.mainGuestName,
        check_in_previsto: reservation.checkIn,
        check_out_previsto: reservation.checkOut,
        pagamento_status: reservation.paymentStatus,
        acesso_liberado: false,
        entrou_no_apto: false,
        origem_externa: "hits",
        external_reservation_id: reservation.externalReservationId,
        status_reserva: reservation.reservationStatus,
        synced_at: options.nowIso,
        fnrh_status_agregado: "fnrh_pendente",
      };
      this.state.operacionalReservas.push(op);
    } else {
      op.apartamento = reservation.apartmentCode;
      op.hospede_principal = reservation.mainGuestName;
      op.check_in_previsto = reservation.checkIn;
      op.check_out_previsto = reservation.checkOut;
      op.pagamento_status = reservation.paymentStatus;
      op.status_reserva = reservation.reservationStatus;
      op.synced_at = options.nowIso;
    }

    // Sincronizar hóspedes operacionais (não apagar fisicamente — marcar removed)
    const seen = new Set<string>();
    for (const g of reservation.guests) {
      const gid = g.externalGuestId || `anon:${reservation.externalReservationId}:${g.name}`;
      seen.add(gid);
      let oh = this.state.operacionalHospedes.find(
        (h) => h.reserva_id === op!.id && h.pms_external_guest_id === gid,
      );
      if (!oh) {
        oh = {
          id: rid(),
          reserva_id: op.id,
          nome: g.name,
          principal: g.isPrincipal,
          email: g.email ?? "",
          whatsapp: g.phone ?? "",
          pms_external_guest_id: gid,
          removed_from_reservation: false,
        };
        this.state.operacionalHospedes.push(oh);
      } else {
        oh.nome = g.name;
        oh.principal = g.isPrincipal;
        oh.email = g.email ?? "";
        oh.whatsapp = g.phone ?? "";
        oh.removed_from_reservation = false;
      }
    }
    for (const oh of this.state.operacionalHospedes) {
      if (
        oh.reserva_id === op.id &&
        oh.pms_external_guest_id &&
        !seen.has(oh.pms_external_guest_id)
      ) {
        oh.removed_from_reservation = true;
      }
    }

    let eventsWritten = 0;
    for (const ev of events) {
      this.state.eventos.push({
        id: rid(),
        reserva_id: op.id,
        tipo: ev.tipo,
        titulo: ev.titulo,
        detalhe: ev.detalhe,
        criado_em: options.nowIso,
      });
      eventsWritten += 1;
    }

    return {
      operacionalId: op.id,
      created,
      updated: !created && events.length > 0,
      eventsWritten,
    };
  }

  async startSyncRun(input: {
    provider: string;
    nowIso: string;
    dryRun: boolean;
  }): Promise<string> {
    const id = rid();
    this.state.syncRuns.push({
      id,
      provider: input.provider,
      status: "running",
      started_at: input.nowIso,
      finished_at: null,
      stats: { dry_run: input.dryRun },
      message: null,
    });
    return id;
  }

  async finishSyncRun(
    id: string,
    patch: {
      status: PersistedSyncRun["status"];
      finished_at: string;
      stats: Record<string, unknown>;
      message?: string | null;
    },
  ): Promise<void> {
    const run = this.state.syncRuns.find((r) => r.id === id);
    if (!run) return;
    run.status = patch.status;
    run.finished_at = patch.finished_at;
    run.stats = { ...run.stats, ...patch.stats };
    run.message = patch.message ?? null;
  }

  async recordSyncError(input: {
    sync_run_id: string;
    severity: "warn" | "error" | "fatal";
    step: string;
    message: string;
    context?: Record<string, unknown>;
  }): Promise<void> {
    this.state.syncErrors.push({
      id: rid(),
      sync_run_id: input.sync_run_id,
      severity: input.severity,
      step: input.step,
      message: input.message.slice(0, 500),
      context: input.context ?? {},
    });
  }
}
