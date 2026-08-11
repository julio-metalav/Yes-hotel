/**
 * Repositório em memória para testes locais do cobranca-pagarme-service.
 * Sem rede / sem Supabase.
 */

import type {
  CobrancaPagarmeRepository,
  CobrancaPagarmeRow,
  PagamentoPagarmeRow,
  ReservaCobrancaRow,
} from "../cobranca-pagarme-service.ts";
import type { PagarmePixCustomer } from "../../../integrations/pagarme.ts";
import { isYesHotelCobrancaUuid } from "../../../integrations/pagarme.ts";

export interface MemoryCobrancaState {
  reservas: Map<string, ReservaCobrancaRow>;
  cobrancas: Map<string, CobrancaPagarmeRow>;
  pagamentos: Map<string, PagamentoPagarmeRow>;
  webhooks: Map<
    string,
    {
      id: string;
      pagarme_event_id: string;
      tipo_evento: string;
      payload_sanitizado: Record<string, unknown>;
      cobranca_id: string | null;
      processado_em: string | null;
      erro: string | null;
    }
  >;
  pixCustomers: Map<string, PagarmePixCustomer>;
  pagarmeCalls: number;
}

function emptyCobranca(partial: Partial<CobrancaPagarmeRow> & Pick<
  CobrancaPagarmeRow,
  | "id"
  | "reserva_id"
  | "metodo"
  | "valor_centavos"
  | "idempotency_key"
  | "status"
  | "criado_por_user_id"
>): CobrancaPagarmeRow {
  return {
    external_reservation_id: null,
    moeda: "BRL",
    pagarme_payment_link_id: null,
    pagarme_payment_link_url: null,
    pagarme_order_id: null,
    pagarme_charge_id: null,
    pix_qr_code: null,
    pix_qr_code_url: null,
    expira_em: null,
    pagarme_status_raw: null,
    requer_revisao_operacional: false,
    requer_revisao_motivo: null,
    requer_revisao_detectado_em: null,
    ...partial,
  };
}

export function createMemoryCobrancaRepo(
  seed?: {
    reservas?: ReservaCobrancaRow[];
    pixCustomers?: Array<{ reservaId: string; customer: PagarmePixCustomer }>;
  },
): { repo: CobrancaPagarmeRepository; state: MemoryCobrancaState } {
  const state: MemoryCobrancaState = {
    reservas: new Map(),
    cobrancas: new Map(),
    pagamentos: new Map(),
    webhooks: new Map(),
    pixCustomers: new Map(),
    pagarmeCalls: 0,
  };

  for (const r of seed?.reservas ?? []) state.reservas.set(r.id, { ...r });
  for (const p of seed?.pixCustomers ?? []) state.pixCustomers.set(p.reservaId, p.customer);

  const repo: CobrancaPagarmeRepository = {
    async getReservaById(reservaId) {
      return state.reservas.get(reservaId) ?? null;
    },

    async updateClassificacaoComissionamento(input) {
      const row = state.reservas.get(input.reservaId);
      if (!row) throw new Error("reserva nao encontrada");
      const updated: ReservaCobrancaRow = {
        ...row,
        classificacao_comissionamento: input.classificacao,
      };
      state.reservas.set(input.reservaId, updated);
      return updated;
    },

    async insertCobranca(row) {
      const blocking = [...state.cobrancas.values()].find(
        (c) =>
          c.reserva_id === row.reserva_id &&
          (c.status === "created" ||
            c.status === "pending" ||
            c.status === "processing" ||
            c.status === "paid" ||
            c.status === "refunded" ||
            c.status === "chargeback"),
      );
      if (blocking) return { ok: false, conflict: true, code: "23505" };

      const cobranca = emptyCobranca(row);
      state.cobrancas.set(cobranca.id, cobranca);
      return { ok: true, cobranca: { ...cobranca } };
    },

    async findActiveCobrancaByReserva(reservaId) {
      return (
        [...state.cobrancas.values()].find(
          (c) =>
            c.reserva_id === reservaId &&
            (c.status === "created" || c.status === "pending" || c.status === "processing"),
        ) ?? null
      );
    },

    async findBlockingCobrancaByReserva(reservaId) {
      return (
        [...state.cobrancas.values()].find(
          (c) =>
            c.reserva_id === reservaId &&
            (c.status === "created" ||
              c.status === "pending" ||
              c.status === "processing" ||
              c.status === "paid" ||
              c.status === "refunded" ||
              c.status === "chargeback"),
        ) ?? null
      );
    },

    async getCobrancaById(cobrancaId) {
      if (!isYesHotelCobrancaUuid(cobrancaId)) return null;
      return state.cobrancas.get(cobrancaId) ?? null;
    },

    async findCobrancaByOrderCode(orderCode) {
      if (isYesHotelCobrancaUuid(orderCode)) {
        const byId = state.cobrancas.get(orderCode);
        if (byId) return { ...byId };
      }
      return (
        [...state.cobrancas.values()].find((c) => c.pagarme_order_id === orderCode) ?? null
      );
    },

    async findCobrancaByChargeId(chargeId) {
      return (
        [...state.cobrancas.values()].find((c) => c.pagarme_charge_id === chargeId) ?? null
      );
    },

    async findCobrancaByPaymentLinkId(paymentLinkId) {
      return (
        [...state.cobrancas.values()].find(
          (c) => c.pagarme_payment_link_id === paymentLinkId,
        ) ?? null
      );
    },

    async updateCobranca(cobrancaId, patch) {
      const current = state.cobrancas.get(cobrancaId);
      if (!current) throw new Error("cobranca nao encontrada");
      const updated = { ...current, ...patch, id: current.id };
      state.cobrancas.set(cobrancaId, updated);
      return { ...updated };
    },

    async insertWebhookEvent(input) {
      const existing = state.webhooks.get(input.pagarme_event_id);
      if (existing) return { inserted: false, id: existing.id };
      const id = crypto.randomUUID();
      state.webhooks.set(input.pagarme_event_id, {
        id,
        pagarme_event_id: input.pagarme_event_id,
        tipo_evento: input.tipo_evento,
        payload_sanitizado: input.payload_sanitizado,
        cobranca_id: input.cobranca_id ?? null,
        processado_em: null,
        erro: null,
      });
      return { inserted: true, id };
    },

    async markWebhookProcessed(input) {
      const row = state.webhooks.get(input.pagarme_event_id);
      if (!row) return;
      row.processado_em = new Date().toISOString();
      row.erro = input.erro ?? null;
      if (input.cobranca_id !== undefined) row.cobranca_id = input.cobranca_id;
    },

    async insertPagamento(input) {
      const exists = [...state.pagamentos.values()].find(
        (p) => p.cobranca_id === input.cobranca_id,
      );
      if (exists) return { ok: false, conflict: true };
      const pagamento: PagamentoPagarmeRow = {
        id: crypto.randomUUID(),
        ...input,
      };
      state.pagamentos.set(pagamento.id, pagamento);
      return { ok: true, pagamento };
    },

    async resolvePixCustomer(reservaId) {
      return state.pixCustomers.get(reservaId) ?? null;
    },
  };

  return { repo, state };
}
