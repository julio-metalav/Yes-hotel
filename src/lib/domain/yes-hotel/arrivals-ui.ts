/**
 * Policy pura: aba Chegadas + card de hóspedes hospedados.
 * Timezone operacional: America/Campo_Grande.
 * Sem I/O.
 */

export type ArrivalsFilter =
  | "hoje"
  | "amanha"
  | "proximos_7_dias"
  | "todas_futuras"
  | "so_problemas";

export type ArrivalsReservationInput = {
  id: string;
  external_reservation_id: string | null;
  apartamento: string;
  hospede_principal: string;
  check_in_previsto: string;
  check_out_previsto: string;
  status_reserva: "ativa" | "cancelada" | string;
  pagamento_status: string;
  entrou_no_apto: boolean;
  acesso_liberado?: boolean;
  total_hospedes: number;
  fnrh_pendente?: boolean;
  recent_change_labels?: string[];
  /** Cancelamento recente detectado via evento hits_reserva_cancelada (últimas 24h). */
  recent_cancel_event?: boolean;
  tolerancia_ativa?: boolean;
  senha_suspensa?: boolean;
  comunicacao_falha?: boolean;
  credencial_ausente?: boolean;
};

export type ArrivalsAlert = {
  code: string;
  label: string;
};

export type ArrivalsRow = {
  id: string;
  check_in: string;
  external_reservation_id: string;
  apartamento: string;
  hospede_principal: string;
  total_hospedes: number;
  alerts: ArrivalsAlert[];
};

const TZ = "America/Campo_Grande";

/** Data civil YYYY-MM-DD no fuso da recepção. */
export function localDateYmd(now: Date = new Date(), timeZone: string = TZ): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function deriveArrivalsAlerts(r: ArrivalsReservationInput): ArrivalsAlert[] {
  const out: ArrivalsAlert[] = [];
  const pay = String(r.pagamento_status || "").toLowerCase();
  if (pay === "pendente") out.push({ code: "pagamento_pendente", label: "Pagamento pendente" });
  else if (pay === "parcial") out.push({ code: "pagamento_parcial", label: "Pagamento parcial" });
  else if (pay === "desconhecido") {
    out.push({ code: "pagamento_nao_confirmado", label: "Pagamento não confirmado" });
  }
  if (r.fnrh_pendente) out.push({ code: "fnrh_pendente", label: "FNRH pendente" });
  if (r.status_reserva === "cancelada") {
    out.push({ code: "reserva_cancelada", label: "Reserva cancelada" });
  }
  for (const label of r.recent_change_labels ?? []) {
    if (out.length >= 3) break;
    out.push({ code: "alteracao_recente", label });
  }
  if (r.credencial_ausente) out.push({ code: "credencial_ausente", label: "Credencial não criada" });
  if (r.comunicacao_falha) out.push({ code: "comunicacao_falha", label: "Falha de comunicação" });
  if (r.tolerancia_ativa) out.push({ code: "tolerancia", label: "Tolerância" });
  if (r.senha_suspensa) out.push({ code: "senha_suspensa", label: "Senha suspensa" });
  return out.slice(0, 3);
}

function toRow(r: ArrivalsReservationInput): ArrivalsRow {
  const ext = (r.external_reservation_id || "").trim();
  return {
    id: r.id,
    check_in: r.check_in_previsto,
    external_reservation_id: ext || "—",
    apartamento: r.apartamento || "—",
    hospede_principal: r.hospede_principal || "—",
    total_hospedes: Math.max(1, Number(r.total_hospedes) || 1),
    alerts: deriveArrivalsAlerts(r),
  };
}

export function filterArrivals(
  items: ArrivalsReservationInput[],
  filter: ArrivalsFilter,
  now: Date = new Date(),
): ArrivalsRow[] {
  const today = localDateYmd(now);
  const tomorrow = addDaysYmd(today, 1);
  const end7 = addDaysYmd(today, 6);

  return items
    .filter((r) => {
      const cin = String(r.check_in_previsto || "").slice(0, 10);
      if (filter === "so_problemas") {
        if (r.status_reserva === "cancelada") {
          // Somente cancelamento recente (evento hits_reserva_cancelada nas últimas 24h).
          return r.recent_cancel_event === true;
        }
        return deriveArrivalsAlerts(r).length > 0;
      }
      if (r.status_reserva === "cancelada") return false;
      if (filter === "hoje") return cin === today;
      if (filter === "amanha") return cin === tomorrow;
      if (filter === "proximos_7_dias") return cin >= today && cin <= end7;
      if (filter === "todas_futuras") return cin >= today;
      return false;
    })
    .map(toRow)
    .sort((a, b) => {
      if (a.check_in !== b.check_in) return a.check_in.localeCompare(b.check_in);
      if (a.apartamento !== b.apartamento) return a.apartamento.localeCompare(b.apartamento);
      return a.hospede_principal.localeCompare(b.hospede_principal);
    });
}

export type OccupiedStayInput = {
  id: string;
  apartamento: string;
  hospede_principal: string;
  check_in_previsto: string;
  check_out_previsto: string;
  status_reserva: string;
  entrou_no_apto: boolean;
  total_hospedes: number;
  pagamento_status?: string;
  fnrh_pendente?: boolean;
};

export type OccupiedGuestsSummary = {
  total_guests: number;
  occupied_apartments: number;
  stays: Array<{
    id: string;
    apartamento: string;
    hospede_principal: string;
    total_hospedes: number;
    check_out: string;
    alerts: ArrivalsAlert[];
  }>;
};

export function summarizeOccupiedGuests(
  items: OccupiedStayInput[],
  now: Date = new Date(),
): OccupiedGuestsSummary {
  const today = localDateYmd(now);
  const stays = items.filter((r) => {
    if (r.status_reserva !== "ativa") return false;
    if (!r.entrou_no_apto) return false;
    const cin = String(r.check_in_previsto || "").slice(0, 10);
    const cout = String(r.check_out_previsto || "").slice(0, 10);
    return cin <= today && cout > today;
  });

  const apartments = new Set(
    stays.map((s) => (s.apartamento || "").trim()).filter(Boolean),
  );
  const total_guests = stays.reduce(
    (acc, s) => acc + Math.max(1, Number(s.total_hospedes) || 1),
    0,
  );

  return {
    total_guests,
    occupied_apartments: apartments.size,
    stays: stays.map((s) => ({
      id: s.id,
      apartamento: s.apartamento || "—",
      hospede_principal: s.hospede_principal || "—",
      total_hospedes: Math.max(1, Number(s.total_hospedes) || 1),
      check_out: s.check_out_previsto,
      alerts: deriveArrivalsAlerts({
        id: s.id,
        external_reservation_id: null,
        apartamento: s.apartamento,
        hospede_principal: s.hospede_principal,
        check_in_previsto: s.check_in_previsto,
        check_out_previsto: s.check_out_previsto,
        status_reserva: s.status_reserva,
        pagamento_status: s.pagamento_status || "pago",
        entrou_no_apto: true,
        total_hospedes: s.total_hospedes,
        fnrh_pendente: s.fnrh_pendente,
      }),
    })),
  };
}

export function paginateRows<T>(rows: T[], page: number, pageSize: number): {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
} {
  const p = Math.max(0, page);
  const size = Math.max(1, pageSize);
  const start = p * size;
  const items = rows.slice(start, start + size);
  return {
    items,
    page: p,
    pageSize: size,
    total: rows.length,
    hasMore: start + size < rows.length,
  };
}
