/**
 * Alerta operacional PPD na lista do café da manhã.
 * Sem I/O. NÃO altera pagamento_status. NÃO é caixa/financeiro.
 *
 * Fonte oficial de pagamento: operacional_reservas.pagamento_status (HITS).
 * Valor: só exibe número se houver fonte canônica confiável; senão "valor a confirmar".
 */

export type PpdChargeAmountSource =
  | "none"
  | "hits_reservation_total"
  | "operacional_explicit";

export type PpdChargeAmountResolution = {
  source: PpdChargeAmountSource;
  /** Valor em reais (unidade principal), se confiável. */
  amount: number | null;
  /** Texto para UI/mensagens. */
  displayLabel: string;
};

function parsePositiveMoney(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function formatBrl(amount: number): string {
  return amount.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/**
 * Resolve valor a cobrar para alerta PPD.
 * Preferência: campo operacional explícito → total HITS projetado.
 * NÃO usa Payment Link / cobrança Pagar.me como fonte oficial da reserva.
 */
export function resolvePpdChargeAmount(input: {
  operacionalValorTotal?: unknown;
  hitsReservationTotalAmount?: unknown;
}): PpdChargeAmountResolution {
  const operacional = parsePositiveMoney(input.operacionalValorTotal);
  if (operacional != null) {
    return {
      source: "operacional_explicit",
      amount: operacional,
      displayLabel: formatBrl(operacional),
    };
  }
  const hits = parsePositiveMoney(input.hitsReservationTotalAmount);
  if (hits != null) {
    return {
      source: "hits_reservation_total",
      amount: hits,
      displayLabel: formatBrl(hits),
    };
  }
  return {
    source: "none",
    amount: null,
    displayLabel: "valor a confirmar",
  };
}

export function isOfficialPaymentPaid(pagamentoStatus: string | null | undefined): boolean {
  return String(pagamentoStatus || "").trim().toLowerCase() === "pago";
}

export type CafePpdAlertInput = {
  ppdEfetivado: boolean;
  /** Pré-autorizado sem efetivar NÃO mostra alerta. */
  ppdAutorizado?: boolean;
  pagamentoStatus: string | null | undefined;
  statusReserva: string | null | undefined;
  /** Regularização HITS/operacional do PPD. */
  ppdRegularizadoEm?: string | null;
  /** Cancelamento/bloqueio operacional do PPD. */
  ppdBloqueadoEm?: string | null;
  /** Deadline operacional persistido (09:00 America/Campo_Grande). */
  ppdDeadlineEm?: string | null;
  /** Relógio da apresentação/teste. Default: agora. */
  nowIso?: string | null;
  /** Pagar.me paid → PPD não elegível / sem alerta. */
  pagarmeObrigacaoLiquidada?: boolean;
};

export type CafePpdOperationalState =
  | "none"
  | "pending"
  | "overdue"
  | "suspended"
  | "regularized";

/**
 * Estado adicional à classificação de café. Nunca muda o entitlement.
 * Deadline vencido é elegível imediatamente; não existe tolerância extra de 1h.
 */
export function resolveCafePpdOperationalState(
  input: CafePpdAlertInput,
): CafePpdOperationalState {
  if (!input.ppdEfetivado) return "none";
  if (input.ppdRegularizadoEm || isOfficialPaymentPaid(input.pagamentoStatus)) {
    return "regularized";
  }
  if (input.pagarmeObrigacaoLiquidada === true) return "none";
  const status = String(input.statusReserva || "").trim().toLowerCase();
  if (status === "cancelada" || status === "checkout" || status === "finalizada") {
    return "none";
  }
  if (input.ppdBloqueadoEm) return "suspended";

  const deadlineMs = input.ppdDeadlineEm ? Date.parse(input.ppdDeadlineEm) : NaN;
  const nowMs = input.nowIso ? Date.parse(input.nowIso) : Date.now();
  if (Number.isFinite(deadlineMs) && Number.isFinite(nowMs) && nowMs >= deadlineMs) {
    return "overdue";
  }
  return "pending";
}

/** Alertas fortes: pendente, vencido ou acesso suspenso. */
export function shouldShowCafePpdAlert(input: CafePpdAlertInput): boolean {
  const state = resolveCafePpdOperationalState(input);
  return state === "pending" || state === "overdue" || state === "suspended";
}

export type CafePpdAlertView = {
  state: "pending" | "overdue" | "suspended";
  tone: "danger";
  badgeLabel: string;
};

export function buildCafePpdAlertView(input: {
  charge: PpdChargeAmountResolution;
  state?: "pending" | "overdue" | "suspended";
}): CafePpdAlertView {
  const state = input.state ?? "pending";
  const badgeLabel =
    input.charge.source === "none"
      ? "DIÁRIA PENDENTE"
      : `DIÁRIA PENDENTE: ${input.charge.displayLabel}`;

  return {
    state,
    tone: "danger",
    badgeLabel,
  };
}

/** Texto interno DigiSac (recepção) — nunca enviado ao hóspede. */
export function buildInternalPpdCafeChargeLines(input: {
  apartmentCode: string;
  guestName: string;
  charge: PpdChargeAmountResolution;
}): string {
  const apt = String(input.apartmentCode || "").trim() || "—";
  const guest = String(input.guestName || "").trim() || "hóspede";
  const valor =
    input.charge.source === "none"
      ? "confirmar no HITS"
      : input.charge.displayLabel;
  return [
    `Apto ${apt} — ${guest} entrou no apartamento.`,
    "Pagamento presencial diferido ativo.",
    "Cobrar até 09h no café da manhã.",
    `Valor: ${valor}.`,
    "Após receber, regularizar no HITS.",
  ].join(" ");
}
