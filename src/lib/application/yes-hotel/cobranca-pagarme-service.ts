/**
 * Regras de negócio — cobrança Pagar.me (Checkpoint 2).
 *
 * Sequência obrigatória em criar:
 * 1) validar reserva/classificação
 * 2) INSERT local
 * 3) só então chamar Pagar.me
 *
 * Erro ambíguo (timeout/429/5xx/rede) NÃO marca failed e NÃO libera nova cobrança.
 */

import {
  PagarmeClient,
  PagarmeError,
  assertSnapshotBelongsToCobranca,
  createPagarmeClient,
  extractWebhookHints,
  isChargebackEvent,
  isCobrancaStatusBloqueante,
  isObrigacaoLiquidadaOuContenciosa,
  mapStatusAfterRemoteCreate,
  mapWebhookEventToRevisaoMotivo,
  sanitizeWebhookPayload,
  type ClassificacaoComissionamento,
  type CobrancaStatusNormalizado,
  type PagarmeMetodo,
  type PagarmePixCustomer,
  type RevisaoMotivo,
} from "../../integrations/pagarme/index.ts";

export type CobrancaAdminAction = "classificar_comissionamento" | "criar" | "cancelar";

export interface ReservaCobrancaRow {
  id: string;
  external_reservation_id: string | null;
  classificacao_comissionamento: ClassificacaoComissionamento;
  pagamento_status: string;
  hospede_principal?: string | null;
}

export interface CobrancaPagarmeRow {
  id: string;
  reserva_id: string;
  external_reservation_id: string | null;
  metodo: PagarmeMetodo;
  valor_centavos: number;
  moeda: string;
  idempotency_key: string;
  status: CobrancaStatusNormalizado;
  pagarme_payment_link_id: string | null;
  pagarme_payment_link_url: string | null;
  pagarme_order_id: string | null;
  pagarme_charge_id: string | null;
  pix_qr_code: string | null;
  pix_qr_code_url: string | null;
  expira_em: string | null;
  pagarme_status_raw: string | null;
  requer_revisao_operacional: boolean;
  requer_revisao_motivo: RevisaoMotivo | null;
  requer_revisao_detectado_em: string | null;
  criado_por_user_id: string;
}

export interface PagamentoPagarmeRow {
  id: string;
  cobranca_id: string;
  valor_centavos_recebido: number;
  moeda: string;
  pago_em: string;
  pagarme_charge_id: string | null;
  pagarme_transaction_id: string | null;
  pagarme_status_raw: string | null;
  sincronizacao_hits_status: string;
}

export interface CobrancaPagarmeRepository {
  getReservaById(reservaId: string): Promise<ReservaCobrancaRow | null>;
  updateClassificacaoComissionamento(input: {
    reservaId: string;
    classificacao: "nao_comissionada" | "comissionada";
    origem: "manual_operador";
    atualizadoEm: string;
  }): Promise<ReservaCobrancaRow>;
  insertCobranca(row: {
    id: string;
    reserva_id: string;
    external_reservation_id: string | null;
    metodo: PagarmeMetodo;
    valor_centavos: number;
    moeda: string;
    idempotency_key: string;
    status: CobrancaStatusNormalizado;
    criado_por_user_id: string;
  }): Promise<
    | { ok: true; cobranca: CobrancaPagarmeRow }
    | { ok: false; conflict: true; code: "23505" }
  >;
  findActiveCobrancaByReserva(reservaId: string): Promise<CobrancaPagarmeRow | null>;
  /** Qualquer cobrança com status bloqueante (ativa OU liquidada/contenciosa). */
  findBlockingCobrancaByReserva(reservaId: string): Promise<CobrancaPagarmeRow | null>;
  getCobrancaById(cobrancaId: string): Promise<CobrancaPagarmeRow | null>;
  findCobrancaByOrderCode(orderCode: string): Promise<CobrancaPagarmeRow | null>;
  findCobrancaByChargeId(chargeId: string): Promise<CobrancaPagarmeRow | null>;
  findCobrancaByPaymentLinkId(paymentLinkId: string): Promise<CobrancaPagarmeRow | null>;
  updateCobranca(
    cobrancaId: string,
    patch: Partial<CobrancaPagarmeRow>,
  ): Promise<CobrancaPagarmeRow>;
  insertWebhookEvent(input: {
    pagarme_event_id: string;
    tipo_evento: string;
    payload_sanitizado: Record<string, unknown>;
    cobranca_id?: string | null;
  }): Promise<{ inserted: boolean; id: string }>;
  markWebhookProcessed(input: {
    pagarme_event_id: string;
    cobranca_id?: string | null;
    erro?: string | null;
  }): Promise<void>;
  insertPagamento(input: {
    cobranca_id: string;
    valor_centavos_recebido: number;
    moeda: string;
    pago_em: string;
    pagarme_charge_id: string | null;
    pagarme_transaction_id: string | null;
    pagarme_status_raw: string | null;
    sincronizacao_hits_status: "aguardando_registro_hits";
  }): Promise<
    | { ok: true; pagamento: PagamentoPagarmeRow }
    | { ok: false; conflict: true }
  >;
  resolvePixCustomer?(reservaId: string): Promise<PagarmePixCustomer | null>;
}

export interface CobrancaPagarmeServiceOptions {
  repo: CobrancaPagarmeRepository;
  client?: PagarmeClient;
  now?: () => Date;
  newId?: () => string;
}

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; httpStatus: number; details?: unknown } };

function err(
  code: string,
  message: string,
  httpStatus: number,
  details?: unknown,
): ServiceResult<never> {
  return { ok: false, error: { code, message, httpStatus, details } };
}

function publicCobrancaView(row: CobrancaPagarmeRow): Record<string, unknown> {
  return {
    id: row.id,
    reserva_id: row.reserva_id,
    metodo: row.metodo,
    valor_centavos: row.valor_centavos,
    moeda: row.moeda,
    status: row.status,
    pagarme_payment_link_id: row.pagarme_payment_link_id,
    // URL completa só para operador autenticado; testes verificam presença sem logar.
    has_payment_link: Boolean(row.pagarme_payment_link_url),
    payment_link_url: row.pagarme_payment_link_url,
    pagarme_order_id: row.pagarme_order_id,
    pagarme_charge_id: row.pagarme_charge_id,
    has_pix_qr_code: Boolean(row.pix_qr_code),
    pix_qr_code: row.pix_qr_code,
    pix_qr_code_url: row.pix_qr_code_url,
    expira_em: row.expira_em,
    pagarme_status_raw: row.pagarme_status_raw,
    requer_revisao_operacional: row.requer_revisao_operacional,
    requer_revisao_motivo: row.requer_revisao_motivo,
    requer_revisao_detectado_em: row.requer_revisao_detectado_em,
  };
}

export class CobrancaPagarmeService {
  private readonly repo: CobrancaPagarmeRepository;
  private readonly client: PagarmeClient;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: CobrancaPagarmeServiceOptions) {
    this.repo = options.repo;
    this.client = options.client ?? createPagarmeClient();
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async classificarComissionamento(input: {
    reservaId: string;
    classificacao: string;
  }): Promise<ServiceResult<{ reserva: ReservaCobrancaRow }>> {
    const classificacao = String(input.classificacao ?? "").trim();
    if (classificacao !== "nao_comissionada" && classificacao !== "comissionada") {
      return err(
        "classificacao_invalida",
        'classificacao deve ser "nao_comissionada" ou "comissionada" (desconhecida nao e destino).',
        400,
      );
    }
    const reserva = await this.repo.getReservaById(input.reservaId);
    if (!reserva) return err("reserva_nao_encontrada", "Reserva nao encontrada.", 404);

    const updated = await this.repo.updateClassificacaoComissionamento({
      reservaId: input.reservaId,
      classificacao,
      origem: "manual_operador",
      atualizadoEm: this.now().toISOString(),
    });
    return { ok: true, data: { reserva: updated } };
  }

  async criar(input: {
    reservaId: string;
    metodo: string;
    valorCentavos: number;
    operadorUserId: string;
  }): Promise<ServiceResult<{ cobranca: Record<string, unknown>; reused_existing: boolean }>> {
    const metodo = String(input.metodo ?? "").trim() as PagarmeMetodo;
    if (metodo !== "pix" && metodo !== "cartao") {
      return err("metodo_invalido", 'metodo deve ser "pix" ou "cartao".', 400);
    }
    const valor = Number(input.valorCentavos);
    if (!Number.isInteger(valor) || valor <= 0) {
      return err("valor_invalido", "valor_centavos deve ser inteiro > 0.", 400);
    }

    const reserva = await this.repo.getReservaById(input.reservaId);
    if (!reserva) return err("reserva_nao_encontrada", "Reserva nao encontrada.", 404);

    // SEMPRE reler classificação do banco (já veio do repo).
    if (reserva.classificacao_comissionamento === "comissionada") {
      return err(
        "comissionada_bloqueada",
        "Reserva comissionada: nunca cobrar o hospede.",
        409,
      );
    }
    if (reserva.classificacao_comissionamento === "desconhecida") {
      return err(
        "classificacao_desconhecida",
        "Cobrança bloqueada até classificação explícita (nao_comissionada).",
        409,
      );
    }
    if (reserva.classificacao_comissionamento !== "nao_comissionada") {
      return err("classificacao_invalida", "Classificação de comissionamento inválida.", 409);
    }

    if (String(reserva.pagamento_status).toLowerCase() === "pago") {
      return err("reserva_ja_paga", "Reserva ja marcada como paga no HITS/painel.", 409);
    }

    // Gate de obrigação corrente (além do índice parcial no banco).
    const blocking = await this.repo.findBlockingCobrancaByReserva(reserva.id);
    if (blocking && isObrigacaoLiquidadaOuContenciosa(blocking.status)) {
      return err(
        "obrigacao_ja_paga",
        `Ja existe cobranca Pagar.me em status ${blocking.status} para esta reserva. Nova cobranca bloqueada neste checkpoint.`,
        409,
        { cobranca_id: blocking.id, status: blocking.status },
      );
    }
    if (blocking && isCobrancaStatusBloqueante(blocking.status)) {
      // created/pending/processing — devolver a existente sem chamar Pagar.me.
      return {
        ok: true,
        data: { cobranca: publicCobrancaView(blocking), reused_existing: true },
      };
    }

    let pixCustomer: PagarmePixCustomer | null = null;
    if (metodo === "pix") {
      pixCustomer = this.repo.resolvePixCustomer
        ? await this.repo.resolvePixCustomer(reserva.id)
        : null;
      if (!pixCustomer?.name || !pixCustomer.email || !pixCustomer.document) {
        return err(
          "pix_customer_incompleto",
          "Dados do pagador insuficientes para Pix (nome/email/documento). Complete FNRH do hospede principal.",
          422,
        );
      }
    }

    const cobrancaId = this.newId();
    const idempotencyKey = `yh-cobranca-${cobrancaId}`;

    const insertResult = await this.repo.insertCobranca({
      id: cobrancaId,
      reserva_id: reserva.id,
      external_reservation_id: reserva.external_reservation_id,
      metodo,
      valor_centavos: valor,
      moeda: "BRL",
      idempotency_key: idempotencyKey,
      status: "created",
      criado_por_user_id: input.operadorUserId,
    });

    if (!insertResult.ok && insertResult.conflict) {
      const existing = await this.repo.findBlockingCobrancaByReserva(reserva.id);
      if (!existing) {
        return err(
          "conflito_cobranca_ativa",
          "Ja existe cobranca bloqueante, mas nao foi possivel localiza-la.",
          409,
        );
      }
      if (isObrigacaoLiquidadaOuContenciosa(existing.status)) {
        return err(
          "obrigacao_ja_paga",
          `Ja existe cobranca Pagar.me em status ${existing.status} para esta reserva. Nova cobranca bloqueada neste checkpoint.`,
          409,
          { cobranca_id: existing.id, status: existing.status },
        );
      }
      // NÃO chamar Pagar.me na segunda tentativa.
      return {
        ok: true,
        data: { cobranca: publicCobrancaView(existing), reused_existing: true },
      };
    }

    if (!insertResult.ok) {
      return err("insert_falhou", "Falha ao inserir cobranca local.", 500);
    }

    const local = insertResult.cobranca;

    try {
      if (metodo === "pix") {
        const { extract } = await this.client.createPixOrder({
          cobrancaId: local.id,
          valorCentavos: valor,
          customer: pixCustomer!,
          idempotencyKey,
        });
        const mapped = mapStatusAfterRemoteCreate(extract.statusNormalized);
        const updated = await this.repo.updateCobranca(local.id, {
          status: mapped.localStatus,
          pagarme_order_id: extract.orderId,
          pagarme_charge_id: extract.chargeId,
          pix_qr_code: extract.qrCode,
          pix_qr_code_url: extract.qrCodeUrl,
          expira_em: extract.expiresAt,
          pagarme_status_raw: extract.statusRaw,
        });
        return { ok: true, data: { cobranca: publicCobrancaView(updated), reused_existing: false } };
      }

      const { extract } = await this.client.createPaymentLink({
        cobrancaId: local.id,
        valorCentavos: valor,
        idempotencyKey,
      });
      const mapped = mapStatusAfterRemoteCreate(extract.statusNormalized);
      const updated = await this.repo.updateCobranca(local.id, {
        status: mapped.localStatus,
        pagarme_payment_link_id: extract.paymentLinkId,
        pagarme_payment_link_url: extract.paymentLinkUrl,
        expira_em: extract.expiresAt,
        pagarme_status_raw: extract.statusRaw,
      });
      return { ok: true, data: { cobranca: publicCobrancaView(updated), reused_existing: false } };
    } catch (e) {
      return this.handleRemoteCreateFailure(local.id, e);
    }
  }

  private async handleRemoteCreateFailure(
    cobrancaId: string,
    e: unknown,
  ): Promise<ServiceResult<{ cobranca: Record<string, unknown>; reused_existing: boolean }>> {
    const ambiguous =
      e instanceof PagarmeError
        ? e.ambiguous
        : true; // desconhecido após envio potencial → tratar como ambíguo

    if (ambiguous) {
      const updated = await this.repo.updateCobranca(cobrancaId, {
        status: "processing",
        pagarme_status_raw: "ambiguous_remote_result",
      });
      return err(
        "resultado_ambiguo",
        "Resultado remoto ambiguo (timeout/408/409/429/5xx/rede). Cobranca mantida em processing; NAO criar nova cobranca.",
        502,
        {
          cobranca: publicCobrancaView(updated),
          pagarme_error:
            e instanceof PagarmeError
              ? { code: e.code, ambiguous: e.ambiguous, httpStatus: e.httpStatus }
              : { code: "unknown", ambiguous: true },
        },
      );
    }

    // Erro definitivo comprovado (4xx sem ambiguidade) → failed.
    const updated = await this.repo.updateCobranca(cobrancaId, {
      status: "failed",
      pagarme_status_raw:
        e instanceof PagarmeError ? String(e.httpStatus ?? e.code) : "definitive_error",
    });
    return err(
      "criacao_remota_falhou",
      "Falha definitiva ao criar cobranca na Pagar.me.",
      e instanceof PagarmeError && e.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500
        ? e.httpStatus
        : 502,
      {
        cobranca: publicCobrancaView(updated),
        pagarme_error:
          e instanceof PagarmeError
            ? {
                code: e.code,
                ambiguous: e.ambiguous,
                httpStatus: e.httpStatus,
                ...(e.details ? { details: e.details } : {}),
              }
            : { code: "unknown" },
      },
    );
  }

  async cancelar(input: {
    cobrancaId: string;
  }): Promise<ServiceResult<{ cobranca: Record<string, unknown> }>> {
    const cobranca = await this.repo.getCobrancaById(input.cobrancaId);
    if (!cobranca) return err("cobranca_nao_encontrada", "Cobranca nao encontrada.", 404);

    if (cobranca.status === "paid") {
      return err(
        "pago_nao_cancelavel",
        "Cobranca paga nao pode ser cancelada como pendente; estorno fora deste checkpoint.",
        409,
      );
    }
    if (cobranca.status === "canceled" || cobranca.status === "refunded") {
      return { ok: true, data: { cobranca: publicCobrancaView(cobranca) } };
    }

    try {
      if (cobranca.metodo === "cartao") {
        if (cobranca.pagarme_charge_id) {
          return err(
            "cartao_com_charge",
            "Cartao com charge_id: cancelamento/estorno de charge paga/iniciada fora do escopo simples deste checkpoint.",
            409,
          );
        }
        if (!cobranca.pagarme_payment_link_id) {
          return err("payment_link_ausente", "Payment Link ausente para cancelar.", 409);
        }
        await this.client.cancelPaymentLink(cobranca.pagarme_payment_link_id);
      } else {
        if (!cobranca.pagarme_charge_id) {
          return err("charge_ausente", "Charge Pix ausente para cancelar.", 409);
        }
        await this.client.cancelCharge(cobranca.pagarme_charge_id);
      }

      const updated = await this.repo.updateCobranca(cobranca.id, {
        status: "canceled",
        pagarme_status_raw: "canceled",
      });
      return { ok: true, data: { cobranca: publicCobrancaView(updated) } };
    } catch (e) {
      if (e instanceof PagarmeError && e.ambiguous) {
        const updated = await this.repo.updateCobranca(cobranca.id, {
          status: "processing",
          pagarme_status_raw: "ambiguous_cancel_result",
        });
        return err(
          "cancelamento_ambiguo",
          "Resultado de cancelamento ambiguo; cobranca permanece bloqueante (processing).",
          502,
          { cobranca: publicCobrancaView(updated) },
        );
      }
      return err(
        "cancelamento_falhou",
        e instanceof Error ? e.message : "Falha ao cancelar na Pagar.me.",
        502,
      );
    }
  }

  /**
   * Webhook = notificação. Confirmação financeira só após GET server-to-server.
   */
  async processWebhook(payload: unknown): Promise<
    ServiceResult<{
      duplicate_event: boolean;
      payment_registered: boolean;
      cobranca_id: string | null;
    }>
  > {
    const hints = extractWebhookHints(payload);
    if (!hints.eventId || !hints.tipoEvento) {
      return err("webhook_invalido", "Webhook sem event id/tipo.", 400);
    }

    const sanitized = sanitizeWebhookPayload(payload);
    const insert = await this.repo.insertWebhookEvent({
      pagarme_event_id: hints.eventId,
      tipo_evento: hints.tipoEvento,
      payload_sanitizado: sanitized,
      cobranca_id: null,
    });

    if (!insert.inserted) {
      return {
        ok: true,
        data: { duplicate_event: true, payment_registered: false, cobranca_id: null },
      };
    }

    try {
      let cobranca: CobrancaPagarmeRow | null = null;
      if (hints.orderCode) {
        cobranca = await this.repo.findCobrancaByOrderCode(hints.orderCode);
      }
      if (!cobranca && hints.chargeId) {
        cobranca = await this.repo.findCobrancaByChargeId(hints.chargeId);
      }
      if (!cobranca && hints.paymentLinkId) {
        cobranca = await this.repo.findCobrancaByPaymentLinkId(hints.paymentLinkId);
      }
      // order_code = UUID da cobrança
      if (!cobranca && hints.orderCode) {
        cobranca = await this.repo.getCobrancaById(hints.orderCode);
      }

      const revisaoMotivo = mapWebhookEventToRevisaoMotivo(hints.tipoEvento);
      if (revisaoMotivo) {
        const chargeIdForRevisao = hints.chargeId ?? cobranca?.pagarme_charge_id ?? null;
        if (!chargeIdForRevisao || !cobranca) {
          await this.repo.markWebhookProcessed({
            pagarme_event_id: hints.eventId,
            cobranca_id: cobranca?.id ?? null,
            erro: "revisao_sem_charge_id_s2s",
          });
          return {
            ok: true,
            data: {
              duplicate_event: false,
              payment_registered: false,
              cobranca_id: cobranca?.id ?? null,
            },
          };
        }
        const { snapshot } = await this.client.getCharge(chargeIdForRevisao);
        const corr = assertSnapshotBelongsToCobranca({
          orderCode: snapshot.orderCode,
          cobrancaId: cobranca.id,
        });
        if (!corr.ok) {
          await this.repo.markWebhookProcessed({
            pagarme_event_id: hints.eventId,
            cobranca_id: cobranca.id,
            erro: `revisao_correlacao_${corr.reason}`,
          });
          return {
            ok: true,
            data: {
              duplicate_event: false,
              payment_registered: false,
              cobranca_id: cobranca.id,
            },
          };
        }
        await this.repo.updateCobranca(cobranca.id, {
          requer_revisao_operacional: true,
          requer_revisao_motivo: revisaoMotivo,
          requer_revisao_detectado_em: this.now().toISOString(),
          pagarme_status_raw: snapshot.statusRaw,
        });
        await this.repo.markWebhookProcessed({
          pagarme_event_id: hints.eventId,
          cobranca_id: cobranca.id,
        });
        return {
          ok: true,
          data: {
            duplicate_event: false,
            payment_registered: false,
            cobranca_id: cobranca.id,
          },
        };
      }

      if (isChargebackEvent(hints.tipoEvento)) {
        const chargeId =
          hints.chargeId ?? cobranca?.pagarme_charge_id ?? null;
        if (!chargeId) {
          await this.repo.markWebhookProcessed({
            pagarme_event_id: hints.eventId,
            cobranca_id: cobranca?.id ?? null,
            erro: "chargeback_sem_charge_id_confiavel",
          });
          return {
            ok: true,
            data: {
              duplicate_event: false,
              payment_registered: false,
              cobranca_id: cobranca?.id ?? null,
            },
          };
        }

        const { snapshot } = await this.client.getCharge(chargeId);
        if (!cobranca && snapshot.orderCode) {
          cobranca =
            (await this.repo.findCobrancaByOrderCode(snapshot.orderCode)) ??
            (await this.repo.getCobrancaById(snapshot.orderCode));
        }
        if (!cobranca) {
          await this.repo.markWebhookProcessed({
            pagarme_event_id: hints.eventId,
            erro: "chargeback_cobranca_nao_localizada",
          });
          return {
            ok: true,
            data: {
              duplicate_event: false,
              payment_registered: false,
              cobranca_id: null,
            },
          };
        }

        const corr = assertSnapshotBelongsToCobranca({
          orderCode: snapshot.orderCode,
          cobrancaId: cobranca.id,
        });
        if (!corr.ok) {
          await this.repo.markWebhookProcessed({
            pagarme_event_id: hints.eventId,
            cobranca_id: cobranca.id,
            erro: `chargeback_correlacao_${corr.reason}`,
          });
          return {
            ok: true,
            data: {
              duplicate_event: false,
              payment_registered: false,
              cobranca_id: cobranca.id,
            },
          };
        }

        if (snapshot.statusNormalized === "chargeback") {
          await this.repo.updateCobranca(cobranca.id, {
            status: "chargeback",
            pagarme_status_raw: snapshot.statusRaw,
            pagarme_charge_id: snapshot.chargeId || cobranca.pagarme_charge_id,
            pagarme_order_id: snapshot.orderId || cobranca.pagarme_order_id,
          });
        } else {
          await this.repo.markWebhookProcessed({
            pagarme_event_id: hints.eventId,
            cobranca_id: cobranca.id,
            erro: `chargeback_s2s_status_nao_confirmado:${snapshot.statusRaw}`,
          });
          return {
            ok: true,
            data: {
              duplicate_event: false,
              payment_registered: false,
              cobranca_id: cobranca.id,
            },
          };
        }

        await this.repo.markWebhookProcessed({
          pagarme_event_id: hints.eventId,
          cobranca_id: cobranca.id,
        });
        return {
          ok: true,
          data: {
            duplicate_event: false,
            payment_registered: false,
            cobranca_id: cobranca.id,
          },
        };
      }

      // Pagamento: NÃO confiar no status do payload — GET server-to-server.
      let paymentRegistered = false;
      if (hints.chargeId) {
        const { snapshot } = await this.client.getCharge(hints.chargeId);

        if (!cobranca && snapshot.orderCode) {
          cobranca =
            (await this.repo.findCobrancaByOrderCode(snapshot.orderCode)) ??
            (await this.repo.getCobrancaById(snapshot.orderCode));
        }

        if (cobranca) {
          // Persistir IDs descobertos via Payment Link (primeiro webhook).
          const idPatch: Partial<CobrancaPagarmeRow> = {};
          if (snapshot.chargeId && !cobranca.pagarme_charge_id) {
            idPatch.pagarme_charge_id = snapshot.chargeId;
          }
          if (snapshot.orderId && !cobranca.pagarme_order_id) {
            idPatch.pagarme_order_id = snapshot.orderId;
          }
          if (Object.keys(idPatch).length) {
            cobranca = await this.repo.updateCobranca(cobranca.id, idPatch);
          }

          if (snapshot.statusNormalized === "paid") {
            const corr = assertSnapshotBelongsToCobranca({
              orderCode: snapshot.orderCode,
              cobrancaId: cobranca.id,
            });
            const valorOk =
              snapshot.paidAmountCentavos != null &&
              snapshot.paidAmountCentavos === cobranca.valor_centavos;
            const moedaOk = (snapshot.currency ?? "BRL").toUpperCase() === "BRL";

            if (!corr.ok || !valorOk || !moedaOk) {
              const reasons: string[] = [];
              if (!corr.ok) reasons.push(corr.reason);
              if (!valorOk) reasons.push("valor_divergente");
              if (!moedaOk) reasons.push("moeda_divergente");
              await this.repo.updateCobranca(cobranca.id, {
                pagarme_status_raw: snapshot.statusRaw,
              });
              await this.repo.markWebhookProcessed({
                pagarme_event_id: hints.eventId,
                cobranca_id: cobranca.id,
                erro: `paid_rejeitado_fail_closed:${reasons.join(",")}`,
              });
              return {
                ok: true,
                data: {
                  duplicate_event: false,
                  payment_registered: false,
                  cobranca_id: cobranca.id,
                },
              };
            }

            const pagoEm = snapshot.paidAt ?? this.now().toISOString();
            cobranca = await this.repo.updateCobranca(cobranca.id, {
              status: "paid",
              pagarme_status_raw: snapshot.statusRaw,
              pagarme_charge_id: snapshot.chargeId,
              pagarme_order_id: snapshot.orderId ?? cobranca.pagarme_order_id,
            });
            const pay = await this.repo.insertPagamento({
              cobranca_id: cobranca.id,
              valor_centavos_recebido: snapshot.paidAmountCentavos!,
              moeda: "BRL",
              pago_em: pagoEm,
              pagarme_charge_id: snapshot.chargeId,
              pagarme_transaction_id: snapshot.transactionId,
              pagarme_status_raw: snapshot.statusRaw,
              sincronizacao_hits_status: "aguardando_registro_hits",
            });
            paymentRegistered = pay.ok === true || pay.conflict === true;
          } else if (
            snapshot.statusNormalized === "failed" ||
            snapshot.statusNormalized === "canceled" ||
            snapshot.statusNormalized === "expired" ||
            snapshot.statusNormalized === "pending" ||
            snapshot.statusNormalized === "processing"
          ) {
            // Atualiza espelho sem promover a paid.
            if (cobranca.status !== "paid") {
              await this.repo.updateCobranca(cobranca.id, {
                status:
                  cobranca.status === "processing" || cobranca.status === "created"
                    ? snapshot.statusNormalized === "pending"
                      ? "pending"
                      : snapshot.statusNormalized
                    : cobranca.status,
                pagarme_status_raw: snapshot.statusRaw,
              });
            }
          }
        }
      }

      await this.repo.markWebhookProcessed({
        pagarme_event_id: hints.eventId,
        cobranca_id: cobranca?.id ?? null,
      });

      return {
        ok: true,
        data: {
          duplicate_event: false,
          payment_registered: paymentRegistered,
          cobranca_id: cobranca?.id ?? null,
        },
      };
    } catch (e) {
      await this.repo.markWebhookProcessed({
        pagarme_event_id: hints.eventId,
        erro: e instanceof Error ? e.message.slice(0, 500) : "webhook_processing_error",
      });
      if (e instanceof PagarmeError && e.ambiguous) {
        return err(
          "webhook_confirmacao_ambigua",
          "Falha ambigua ao confirmar estado na Pagar.me; evento registrado sem alterar pagamento.",
          502,
        );
      }
      return err(
        "webhook_processamento_falhou",
        e instanceof Error ? e.message : "Falha ao processar webhook.",
        500,
      );
    }
  }
}

export function createCobrancaPagarmeService(
  options: CobrancaPagarmeServiceOptions,
): CobrancaPagarmeService {
  return new CobrancaPagarmeService(options);
}

/** Helper puro: gate de classificação (testável sem DB). */
export function assertClassificacaoPermiteCobranca(
  classificacao: ClassificacaoComissionamento,
): { ok: true } | { ok: false; code: string; message: string } {
  if (classificacao === "nao_comissionada") return { ok: true };
  if (classificacao === "comissionada") {
    return {
      ok: false,
      code: "comissionada_bloqueada",
      message: "Reserva comissionada: nunca cobrar o hospede.",
    };
  }
  return {
    ok: false,
    code: "classificacao_desconhecida",
    message: "Cobrança bloqueada até classificação explícita.",
  };
}
