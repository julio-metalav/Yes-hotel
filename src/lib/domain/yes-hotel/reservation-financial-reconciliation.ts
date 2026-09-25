/**
 * Reconciliação financeira contínua HITS → Yes.
 *
 * O problema que isto resolve: a materialização aplica o financeiro do HITS uma
 * única vez, guardada por `reservation_balance_due IS NULL`. Reserva
 * materializada enquanto pendente e quitada depois no HITS ficava para sempre
 * com o estado antigo — foi o caso da reserva 3281, com crédito total no HITS e
 * "não pago" no Yes.
 *
 * A direção é deliberadamente de mão única. O HITS pode PROMOVER para pago;
 * nunca pode rebaixar, e nunca pode aumentar um saldo que o Pagar.me já
 * reduziu. Entre perder uma promoção e desfazer um pagamento local, perder a
 * promoção é o erro barato: ela volta no ciclo seguinte.
 *
 * Sem I/O.
 */

import {
  mapPaymentStatusFromBalanceDue,
  parseHitsMoney,
} from "./reservation-financial-classification.ts";

/** Estado financeiro persistido hoje em operacional_reservas. */
export type FinanceiroLocal = {
  pagamentoStatus: string | null;
  reservationBalanceDue: number | null;
  reservationTotalAmount: number | null;
  classificacaoComissionamento: string | null;
  /** `hits_campo` | `manual_operador` | `indefinido`. */
  classificacaoComissionamentoOrigem: string | null;
};

/** Recorte financeiro do detalhe HITS já lido no ciclo. */
export type FinanceiroHits = {
  reservationBalanceDue: number | null;
  reservationTotalAmount: number | null;
  classificacaoComissionamento: "nao_comissionada" | "comissionada" | null;
};

/** Só colunas financeiras. Nada fora desta lista pode ser escrito. */
export type PatchFinanceiro = {
  pagamento_status?: string;
  reservation_balance_due?: number;
  reservation_total_amount?: number;
  classificacao_comissionamento?: string;
  classificacao_comissionamento_origem?: string;
};

export const COLUNAS_FINANCEIRAS_RECONCILIAVEIS = [
  "pagamento_status",
  "reservation_balance_due",
  "reservation_total_amount",
  "classificacao_comissionamento",
  "classificacao_comissionamento_origem",
] as const;

export type DecisaoFinanceira = {
  /** Vazio = nada a fazer. */
  patch: PatchFinanceiro;
  atualiza: boolean;
  /** Por que agiu ou por que se absteve. Entra no log, sem PII. */
  motivo:
    | "hits_quitou_promove_pago"
    | "hits_sem_saldo_informado"
    | "hits_com_saldo_positivo_nao_sobrescreve"
    | "local_ja_coerente";
};

const NADA_A_FAZER = (motivo: DecisaoFinanceira["motivo"]): DecisaoFinanceira => ({
  patch: {},
  atualiza: false,
  motivo,
});

function localJaPago(local: FinanceiroLocal): boolean {
  if (String(local.pagamentoStatus ?? "").trim().toLowerCase() === "pago") return true;
  const saldo = parseHitsMoney(local.reservationBalanceDue);
  return saldo != null && saldo <= 0;
}

/**
 * Decide o que a reconciliação escreve. Regra conservadora, nesta ordem:
 *
 * 1. Sem saldo informado pelo HITS não há fato novo: não faz nada. Ausência de
 *    dado nunca vira "pendente" — `mapPaymentStatusFromBalanceDue` já trata
 *    saldo ausente como desconhecido, e desconhecido não rebaixa ninguém.
 * 2. Saldo HITS positivo: nesta fase não sobrescreve nada. O HITS pode estar
 *    apenas atrasado em relação a um pagamento local, e um saldo maior escrito
 *    por cima apagaria a quitação do Pagar.me.
 * 3. Saldo HITS menor ou igual a zero: promove para pago.
 *    - `reservation_balance_due` só é gravado quando DESCE. Local em −50 com
 *      HITS em 0 não sobe para 0.
 *    - `reservation_total_amount` acompanha o oficial do HITS, porque total não
 *      é saldo: atualizá-lo não desfaz pagamento nenhum.
 *    - comissionamento só quando a origem local não é `manual_operador`. Uma
 *      classificação feita por pessoa vence o campo derivado.
 * 4. Se tudo isso já estiver coerente, o patch sai vazio — idempotência.
 */
export function decidirReconciliacaoFinanceiraHits(input: {
  local: FinanceiroLocal;
  hits: FinanceiroHits;
}): DecisaoFinanceira {
  const { local, hits } = input;

  const saldoHits = parseHitsMoney(hits.reservationBalanceDue);
  if (saldoHits == null) return NADA_A_FAZER("hits_sem_saldo_informado");
  if (saldoHits > 0) return NADA_A_FAZER("hits_com_saldo_positivo_nao_sobrescreve");

  // Daqui para baixo: o HITS afirma que não há saldo devedor.
  const patch: PatchFinanceiro = {};

  // Status: promove, nunca rebaixa. `mapPaymentStatusFromBalanceDue` é a regra
  // oficial e, com saldo <= 0, devolve sempre "pago".
  const statusHits = mapPaymentStatusFromBalanceDue(saldoHits, "desconhecido");
  if (statusHits === "pago" && String(local.pagamentoStatus ?? "").trim().toLowerCase() !== "pago") {
    patch.pagamento_status = "pago";
  }

  // Saldo: só desce. Local desconhecido também aceita o valor do HITS.
  const saldoLocal = parseHitsMoney(local.reservationBalanceDue);
  if (saldoLocal == null || saldoHits < saldoLocal) {
    patch.reservation_balance_due = saldoHits;
  }

  // Total oficial: informativo, acompanha o HITS quando difere.
  const totalHits = parseHitsMoney(hits.reservationTotalAmount);
  const totalLocal = parseHitsMoney(local.reservationTotalAmount);
  if (totalHits != null && totalHits !== totalLocal) {
    patch.reservation_total_amount = totalHits;
  }

  // Comissionamento: campo derivado do HITS, mas classificação humana manda.
  const origemLocal = String(local.classificacaoComissionamentoOrigem ?? "").trim().toLowerCase();
  const classifLocal = String(local.classificacaoComissionamento ?? "").trim().toLowerCase();
  if (
    hits.classificacaoComissionamento &&
    origemLocal !== "manual_operador" &&
    hits.classificacaoComissionamento !== classifLocal
  ) {
    patch.classificacao_comissionamento = hits.classificacaoComissionamento;
    patch.classificacao_comissionamento_origem = "hits_campo";
  }

  if (Object.keys(patch).length === 0) return NADA_A_FAZER("local_ja_coerente");
  return { patch, atualiza: true, motivo: "hits_quitou_promove_pago" };
}

/**
 * Prova de que o patch não escapou do financeiro. Usada nos testes e barata o
 * bastante para rodar antes de cada escrita.
 */
export function patchSomenteFinanceiro(patch: Record<string, unknown>): boolean {
  const permitidas = new Set<string>(COLUNAS_FINANCEIRAS_RECONCILIAVEIS);
  return Object.keys(patch).every((k) => permitidas.has(k));
}

/** Verdadeiro quando o estado local já reflete quitação. Só para diagnóstico. */
export function financeiroLocalQuitado(local: FinanceiroLocal): boolean {
  return localJaPago(local);
}
