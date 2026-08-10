/**
 * Adaptador Supabase (service_role) para cobrança Pagar.me.
 * Usado pelas Edge Functions — escrita privilegiada.
 *
 * Imports com extensão .ts explícita (exigência do bundler Deno/--use-api).
 * Sem import de barrel/diretório nem de @supabase/supabase-js (node_modules = DIR → EISDIR).
 */

import type {
  CobrancaPagarmeRepository,
  CobrancaPagarmeRow,
  PagamentoPagarmeRow,
  ReservaCobrancaRow,
} from "../../../application/yes-hotel/cobranca-pagarme-service.ts";
import type { PagarmePixCustomer } from "../../../integrations/pagarme/types.ts";

/** Subset do client usado pelo repository (Edge jsr ou testes). */
export type CobrancaPagarmeSupabaseClient = {
  from: (table: string) => any;
};

function mapCobranca(row: Record<string, unknown>): CobrancaPagarmeRow {
  return {
    id: String(row.id),
    reserva_id: String(row.reserva_id),
    external_reservation_id:
      row.external_reservation_id == null ? null : String(row.external_reservation_id),
    metodo: row.metodo as CobrancaPagarmeRow["metodo"],
    valor_centavos: Number(row.valor_centavos),
    moeda: String(row.moeda ?? "BRL"),
    idempotency_key: String(row.idempotency_key),
    status: row.status as CobrancaPagarmeRow["status"],
    pagarme_payment_link_id:
      row.pagarme_payment_link_id == null ? null : String(row.pagarme_payment_link_id),
    pagarme_payment_link_url:
      row.pagarme_payment_link_url == null ? null : String(row.pagarme_payment_link_url),
    pagarme_order_id: row.pagarme_order_id == null ? null : String(row.pagarme_order_id),
    pagarme_charge_id: row.pagarme_charge_id == null ? null : String(row.pagarme_charge_id),
    pix_qr_code: row.pix_qr_code == null ? null : String(row.pix_qr_code),
    pix_qr_code_url: row.pix_qr_code_url == null ? null : String(row.pix_qr_code_url),
    expira_em: row.expira_em == null ? null : String(row.expira_em),
    pagarme_status_raw:
      row.pagarme_status_raw == null ? null : String(row.pagarme_status_raw),
    requer_revisao_operacional: Boolean(row.requer_revisao_operacional),
    requer_revisao_motivo:
      (row.requer_revisao_motivo as CobrancaPagarmeRow["requer_revisao_motivo"]) ?? null,
    requer_revisao_detectado_em:
      row.requer_revisao_detectado_em == null
        ? null
        : String(row.requer_revisao_detectado_em),
    criado_por_user_id: String(row.criado_por_user_id),
  };
}

export function createSupabaseCobrancaPagarmeRepository(
  admin: CobrancaPagarmeSupabaseClient,
): CobrancaPagarmeRepository {
  return {
    async getReservaById(reservaId) {
      const { data, error } = await admin
        .from("operacional_reservas")
        .select(
          "id, external_reservation_id, classificacao_comissionamento, pagamento_status, hospede_principal",
        )
        .eq("id", reservaId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return data as ReservaCobrancaRow;
    },

    async updateClassificacaoComissionamento(input) {
      const { data, error } = await admin
        .from("operacional_reservas")
        .update({
          classificacao_comissionamento: input.classificacao,
          classificacao_comissionamento_origem: input.origem,
          classificacao_comissionamento_atualizado_em: input.atualizadoEm,
        })
        .eq("id", input.reservaId)
        .select(
          "id, external_reservation_id, classificacao_comissionamento, pagamento_status, hospede_principal",
        )
        .single();
      if (error) throw error;
      return data as ReservaCobrancaRow;
    },

    async insertCobranca(row) {
      const { data, error } = await admin
        .from("operacional_cobrancas_pagarme")
        .insert({
          id: row.id,
          reserva_id: row.reserva_id,
          external_reservation_id: row.external_reservation_id,
          metodo: row.metodo,
          valor_centavos: row.valor_centavos,
          moeda: row.moeda,
          idempotency_key: row.idempotency_key,
          status: row.status,
          criado_por_user_id: row.criado_por_user_id,
        })
        .select("*")
        .single();

      if (error) {
        if (String(error.code) === "23505") {
          return { ok: false, conflict: true, code: "23505" };
        }
        throw error;
      }
      return { ok: true, cobranca: mapCobranca(data as Record<string, unknown>) };
    },

    async findActiveCobrancaByReserva(reservaId) {
      const { data, error } = await admin
        .from("operacional_cobrancas_pagarme")
        .select("*")
        .eq("reserva_id", reservaId)
        .in("status", ["created", "pending", "processing"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? mapCobranca(data as Record<string, unknown>) : null;
    },

    async findBlockingCobrancaByReserva(reservaId) {
      const { data, error } = await admin
        .from("operacional_cobrancas_pagarme")
        .select("*")
        .eq("reserva_id", reservaId)
        .in("status", [
          "created",
          "pending",
          "processing",
          "paid",
          "refunded",
          "chargeback",
        ])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? mapCobranca(data as Record<string, unknown>) : null;
    },

    async getCobrancaById(cobrancaId) {
      const { data, error } = await admin
        .from("operacional_cobrancas_pagarme")
        .select("*")
        .eq("id", cobrancaId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapCobranca(data as Record<string, unknown>) : null;
    },

    async findCobrancaByOrderCode(orderCode) {
      const byId = await this.getCobrancaById(orderCode);
      if (byId) return byId;
      const { data, error } = await admin
        .from("operacional_cobrancas_pagarme")
        .select("*")
        .eq("pagarme_order_id", orderCode)
        .maybeSingle();
      if (error) throw error;
      return data ? mapCobranca(data as Record<string, unknown>) : null;
    },

    async findCobrancaByChargeId(chargeId) {
      const { data, error } = await admin
        .from("operacional_cobrancas_pagarme")
        .select("*")
        .eq("pagarme_charge_id", chargeId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapCobranca(data as Record<string, unknown>) : null;
    },

    async findCobrancaByPaymentLinkId(paymentLinkId) {
      const { data, error } = await admin
        .from("operacional_cobrancas_pagarme")
        .select("*")
        .eq("pagarme_payment_link_id", paymentLinkId)
        .maybeSingle();
      if (error) throw error;
      return data ? mapCobranca(data as Record<string, unknown>) : null;
    },

    async updateCobranca(cobrancaId, patch) {
      const { data, error } = await admin
        .from("operacional_cobrancas_pagarme")
        .update(patch)
        .eq("id", cobrancaId)
        .select("*")
        .single();
      if (error) throw error;
      return mapCobranca(data as Record<string, unknown>);
    },

    async insertWebhookEvent(input) {
      const { data, error } = await admin
        .from("operacional_cobranca_webhooks")
        .insert({
          pagarme_event_id: input.pagarme_event_id,
          tipo_evento: input.tipo_evento,
          payload_sanitizado: input.payload_sanitizado,
          cobranca_id: input.cobranca_id ?? null,
        })
        .select("id")
        .single();

      if (error) {
        if (String(error.code) === "23505") {
          const { data: existing } = await admin
            .from("operacional_cobranca_webhooks")
            .select("id")
            .eq("pagarme_event_id", input.pagarme_event_id)
            .maybeSingle();
          return { inserted: false, id: String(existing?.id ?? "") };
        }
        throw error;
      }
      return { inserted: true, id: String(data.id) };
    },

    async markWebhookProcessed(input) {
      const { error } = await admin
        .from("operacional_cobranca_webhooks")
        .update({
          processado_em: new Date().toISOString(),
          cobranca_id: input.cobranca_id ?? undefined,
          erro: input.erro ?? null,
        })
        .eq("pagarme_event_id", input.pagarme_event_id);
      if (error) throw error;
    },

    async insertPagamento(input) {
      const { data, error } = await admin
        .from("operacional_pagamentos_pagarme")
        .insert({
          cobranca_id: input.cobranca_id,
          valor_centavos_recebido: input.valor_centavos_recebido,
          moeda: input.moeda,
          pago_em: input.pago_em,
          pagarme_charge_id: input.pagarme_charge_id,
          pagarme_transaction_id: input.pagarme_transaction_id,
          pagarme_status_raw: input.pagarme_status_raw,
          sincronizacao_hits_status: input.sincronizacao_hits_status,
        })
        .select("*")
        .single();

      if (error) {
        if (String(error.code) === "23505") return { ok: false, conflict: true };
        throw error;
      }
      return { ok: true, pagamento: data as PagamentoPagarmeRow };
    },

    async resolvePixCustomer(reservaId): Promise<PagarmePixCustomer | null> {
      const { data: hospede, error: hErr } = await admin
        .from("operacional_hospedes")
        .select("id, nome, email, whatsapp, principal")
        .eq("reserva_id", reservaId)
        .eq("principal", true)
        .maybeSingle();
      if (hErr) throw hErr;

      let hospedeId = hospede?.id as string | undefined;
      let nome = String(hospede?.nome ?? "").trim();
      let email = String(hospede?.email ?? "").trim();
      let phone = String(hospede?.whatsapp ?? "").trim();

      if (!hospedeId) {
        const { data: anyGuest } = await admin
          .from("operacional_hospedes")
          .select("id, nome, email, whatsapp")
          .eq("reserva_id", reservaId)
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        hospedeId = anyGuest?.id;
        nome = String(anyGuest?.nome ?? nome).trim();
        email = String(anyGuest?.email ?? email).trim();
        phone = String(anyGuest?.whatsapp ?? phone).trim();
      }

      let documento = "";
      if (hospedeId) {
        const { data: fnrh } = await admin
          .from("fnrh_hospedes")
          .select("documento, email, telefone, hospede_nome")
          .eq("reserva_id", reservaId)
          .eq("hospede_id", hospedeId)
          .maybeSingle();
        documento = String(fnrh?.documento ?? "").replace(/\D/g, "");
        if (!email) email = String(fnrh?.email ?? "").trim();
        if (!phone) phone = String(fnrh?.telefone ?? "").trim();
        if (!nome) nome = String(fnrh?.hospede_nome ?? "").trim();
      }

      if (!nome || !email || !documento) return null;
      return {
        name: nome,
        email,
        document: documento,
        document_type: documento.length > 11 ? "CNPJ" : "CPF",
        phone_number: phone.replace(/\D/g, "") || undefined,
      };
    },
  };
}
