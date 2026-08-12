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
  /** Pagar.me paid → PPD não elegível / sem alerta. */
  pagarmeObrigacaoLiquidada?: boolean;
};

/**
 * Mostrar alerta na lista do café somente se:
 * PPD efetivado + pagamento oficial ≠ pago + reserva ativa + não regularizado/cancelado/pagarme.
 */
export function shouldShowCafePpdAlert(input: CafePpdAlertInput): boolean {
  if (!input.ppdEfetivado) return false;
  if (input.ppdRegularizadoEm) return false;
  if (input.ppdBloqueadoEm) return false;
  if (input.pagarmeObrigacaoLiquidada === true) return false;
  if (isOfficialPaymentPaid(input.pagamentoStatus)) return false;
  const status = String(input.statusReserva || "").trim().toLowerCase();
  if (status === "cancelada" || status === "checkout" || status === "finalizada") {
    return false;
  }
  return true;
}

export type CafePpdAlertView = {
  badgeLabel: string;
  title: string;
  apartmentLine: string;
  chargeLine: string;
  deadlineLine: string;
  hitsHint: string;
};

export function buildCafePpdAlertView(input: {
  apartmentCode: string;
  guestName: string;
  charge: PpdChargeAmountResolution;
}): CafePpdAlertView {
  const apt = String(input.apartmentCode || "").trim() || "—";
  const guest = String(input.guestName || "").trim() || "—";
  const chargeText =
    input.charge.source === "none"
      ? "Cobrar: valor a confirmar"
      : `Cobrar: ${input.charge.displayLabel}`;
  return {
    badgeLabel: "PAGAMENTO PENDENTE",
    title: "⚠️ Pagamento presencial até 09h",
    apartmentLine: `Apto ${apt} — ${guest}`,
    chargeLine: chargeText,
    deadlineLine: "Prazo: 09h",
    hitsHint: "Após receber, regularizar no HITS.",
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
