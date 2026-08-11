/**
 * Mappers Pagar.me ↔ Yes Hotel.
 * Inclui política de parcelamento sem juros (máx. 3x, parcela mínima R$ 600).
 */

import { PagarmeError } from "./errors.ts";
import type {
  CobrancaStatusNormalizado,
  CreatePaymentLinkInput,
  CreatePixOrderInput,
  PagarmeChargeSnapshot,
  PagarmeInstallmentOption,
  PagarmePaymentLinkExtract,
  PagarmePixExtract,
  RevisaoMotivo,
} from "./types.ts";

/** Limiares em centavos: 1x / até 2x / até 3x (parcela mínima R$ 600). */
export const PAGARME_INSTALLMENT_2X_MIN_CENTAVOS = 120_000;
export const PAGARME_INSTALLMENT_3X_MIN_CENTAVOS = 180_000;
export const PAGARME_MAX_INSTALLMENTS = 3;

export function maxInstallmentsForAmount(valorCentavos: number): 1 | 2 | 3 {
  if (!Number.isInteger(valorCentavos) || valorCentavos <= 0) {
    throw new Error("valor_centavos invalido para parcelamento.");
  }
  if (valorCentavos >= PAGARME_INSTALLMENT_3X_MIN_CENTAVOS) return 3;
  if (valorCentavos >= PAGARME_INSTALLMENT_2X_MIN_CENTAVOS) return 2;
  return 1;
}

/**
 * Gera installments sem juros: cada opção usa total = valor TOTAL da cobrança.
 */
export function buildCreditCardInstallments(
  valorCentavos: number,
): PagarmeInstallmentOption[] {
  const max = maxInstallmentsForAmount(valorCentavos);
  const out: PagarmeInstallmentOption[] = [];
  for (let n = 1; n <= max; n += 1) {
    out.push({ number: n, total: valorCentavos });
  }
  return out;
}

export function buildPaymentLinkRequestBody(input: CreatePaymentLinkInput): Record<string, unknown> {
  const installments = buildCreditCardInstallments(input.valorCentavos);
  const itemName = (input.itemName ?? "Hospedagem Yes Hotel").slice(0, 64);
  const itemDescription = (input.itemDescription ?? "Cobranca de hospedagem").slice(0, 256);

  return {
    type: "order",
    name: (input.name ?? `YH-${input.cobrancaId.slice(0, 8)}`).slice(0, 64),
    order_code: input.cobrancaId,
    max_paid_sessions: 1,
    payment_settings: {
      accepted_payment_methods: ["credit_card"],
      credit_card_settings: {
        operation_type: "auth_and_capture",
        installments,
      },
    },
    cart_settings: {
      items: [
        {
          name: itemName,
          description: itemDescription,
          amount: input.valorCentavos,
          default_quantity: 1,
        },
      ],
    },
  };
}

export function buildPixOrderRequestBody(
  input: CreatePixOrderInput,
  pixExpiresInSeconds: number,
): Record<string, unknown> {
  const phone = buildCustomerPhones(input.customer);
  if (!phone) {
    throw new PagarmeError({
      code: "bad_request",
      message:
        "Pix exige customer.phones (telefone do pagador). Informe telefone/WhatsApp do hospede.",
      httpStatus: null,
      ambiguous: false,
      retryable: false,
    });
  }
  return {
    code: input.cobrancaId,
    closed: true,
    customer: {
      name: input.customer.name,
      email: input.customer.email,
      type: "individual",
      document: input.customer.document.replace(/\D/g, ""),
      document_type: input.customer.document_type ?? "CPF",
      phones: phone,
    },
    items: [
      {
        amount: input.valorCentavos,
        description: (input.description ?? "Hospedagem Yes Hotel").slice(0, 256),
        quantity: 1,
        code: input.cobrancaId.slice(0, 52),
      },
    ],
    payments: [
      {
        payment_method: "pix",
        pix: {
          expires_in: pixExpiresInSeconds,
        },
      },
    ],
    metadata: {
      yes_hotel_cobranca_id: input.cobrancaId,
      origem: "yes_hotel_pagarme",
    },
  };
}

function buildCustomerPhones(
  customer: CreatePixOrderInput["customer"],
): Record<string, unknown> | null {
  const digits = String(customer.phone_number ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const country = customer.phone_country_code ?? "55";
  let area = customer.phone_area_code ?? "";
  let number = digits;
  if (!area && digits.length >= 10) {
    area = digits.slice(0, 2);
    number = digits.slice(2);
  }
  if (!area || !number) return null;
  return {
    mobile_phone: {
      country_code: country,
      area_code: area,
      number,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t || null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function normalizePagarmeStatus(raw: string | null | undefined): CobrancaStatusNormalizado {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return "processing";
  if (s === "paid" || s === "captured") return "paid";
  if (s === "pending" || s === "waiting_payment" || s === "active") return "pending";
  if (s === "processing" || s === "analyzing" || s === "pending_refund") return "processing";
  if (s === "failed" || s === "payment_failed" || s === "with_error") return "failed";
  if (s === "canceled" || s === "cancelled" || s === "voided") return "canceled";
  if (s === "expired") return "expired";
  if (s === "refunded" || s === "chargedback" || s === "chargeback") {
    return s === "refunded" ? "refunded" : "chargeback";
  }
  if (s === "overpaid" || s === "underpaid" || s === "partial_canceled") return "processing";
  return "processing";
}

/**
 * Status local após criação remota bem-sucedida (Pix order / Payment Link).
 * Nunca registra pagamento aqui — mesmo se o remoto disser "paid".
 */
export function mapStatusAfterRemoteCreate(
  remoteNormalized: CobrancaStatusNormalizado,
): {
  localStatus: CobrancaStatusNormalizado;
  registersPayment: false;
} {
  switch (remoteNormalized) {
    case "failed":
      return { localStatus: "failed", registersPayment: false };
    case "processing":
      return { localStatus: "processing", registersPayment: false };
    case "paid":
      // Cobrança remota pode já estar paga, mas o fato financeiro local
      // só nasce no fluxo webhook + GET S2S + insertPagamento.
      return { localStatus: "pending", registersPayment: false };
    case "pending":
    case "created":
      return { localStatus: "pending", registersPayment: false };
    case "expired":
      return { localStatus: "expired", registersPayment: false };
    case "canceled":
      return { localStatus: "canceled", registersPayment: false };
    default:
      return { localStatus: "pending", registersPayment: false };
  }
}

/** Status que bloqueiam nova cobrança da mesma obrigação (espelha índice parcial). */
export const COBRANCA_STATUS_BLOQUEANTES = [
  "created",
  "pending",
  "processing",
  "paid",
  "refunded",
  "chargeback",
] as const;

export const COBRANCA_STATUS_OBRIGACAO_LIQUIDADA_OU_CONTENCIOSA = [
  "paid",
  "refunded",
  "chargeback",
] as const;

export function isCobrancaStatusBloqueante(
  status: CobrancaStatusNormalizado,
): boolean {
  return (COBRANCA_STATUS_BLOQUEANTES as readonly string[]).includes(status);
}

export function isObrigacaoLiquidadaOuContenciosa(
  status: CobrancaStatusNormalizado,
): boolean {
  return (COBRANCA_STATUS_OBRIGACAO_LIQUIDADA_OU_CONTENCIOSA as readonly string[]).includes(
    status,
  );
}

/**
 * UUID local de cobrança Yes Hotel (coluna id UUID).
 * IDs remotos Pagar.me (or_/ch_/pl_) e codes externos NÃO passam.
 */
const YES_HOTEL_COBRANCA_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isYesHotelCobrancaUuid(value: string | null | undefined): boolean {
  if (value == null) return false;
  const v = String(value).trim();
  if (!v) return false;
  return YES_HOTEL_COBRANCA_UUID_RE.test(v);
}

/**
 * Correlação fail-closed: order_code/code da resposta S2S DEVE ser o UUID
 * da cobrança local. Ausente ou divergente → rejeita mudança financeira.
 */
export function assertSnapshotBelongsToCobranca(input: {
  orderCode: string | null | undefined;
  cobrancaId: string;
}): { ok: true } | { ok: false; reason: "order_code_ausente" | "order_code_divergente" } {
  const code = String(input.orderCode ?? "").trim();
  if (!code) return { ok: false, reason: "order_code_ausente" };
  if (code !== input.cobrancaId) return { ok: false, reason: "order_code_divergente" };
  return { ok: true };
}

/**
 * Extrai QR Code / URL / expires_at de charge.last_transaction (nunca assume topo).
 */
export function extractPixFromOrder(orderBody: unknown): PagarmePixExtract {
  const order = asRecord(orderBody) ?? {};
  const charges = Array.isArray(order.charges) ? order.charges : [];
  const charge = asRecord(charges[0]) ?? {};
  const lastTx = asRecord(charge.last_transaction) ?? {};

  const qrCode = asString(lastTx.qr_code);
  const qrCodeUrl = asString(lastTx.qr_code_url);
  const expiresAt = asString(lastTx.expires_at) ?? asString(charge.expires_at);
  const statusRaw =
    asString(charge.status) ?? asString(lastTx.status) ?? asString(order.status);
  const transactionId =
    asString(lastTx.id) ?? asString(lastTx.transaction_id) ?? asString(charge.transaction_id);

  return {
    orderId: asString(order.id),
    chargeId: asString(charge.id),
    transactionId,
    qrCode,
    qrCodeUrl,
    expiresAt,
    statusRaw,
    statusNormalized: normalizePagarmeStatus(statusRaw),
    amountCentavos: asNumber(charge.amount) ?? asNumber(order.amount),
    currency: asString(charge.currency) ?? asString(order.currency) ?? "BRL",
  };
}

export function extractPaymentLink(body: unknown): PagarmePaymentLinkExtract {
  const row = asRecord(body) ?? {};
  const statusRaw = asString(row.status);
  return {
    paymentLinkId: asString(row.id),
    paymentLinkUrl: asString(row.url),
    orderCode: asString(row.order_code),
    statusRaw,
    statusNormalized: normalizePagarmeStatus(statusRaw),
    expiresAt: asString(row.expires_at),
  };
}

export function extractChargeSnapshot(body: unknown): PagarmeChargeSnapshot {
  const charge = asRecord(body) ?? {};
  const lastTx = asRecord(charge.last_transaction) ?? {};
  const order = asRecord(charge.order) ?? {};
  const metadata = asRecord(charge.metadata) ?? asRecord(order.metadata) ?? {};

  const statusRaw = asString(charge.status) ?? "unknown";
  const paidAt =
    asString(charge.paid_at) ??
    asString(lastTx.paid_at) ??
    asString(lastTx.updated_at) ??
    null;

  return {
    chargeId: asString(charge.id) ?? "",
    orderId: asString(charge.order_id) ?? asString(order.id),
    statusRaw,
    statusNormalized: normalizePagarmeStatus(statusRaw),
    amountCentavos: asNumber(charge.amount),
    paidAmountCentavos: asNumber(charge.paid_amount) ?? asNumber(charge.amount),
    currency: asString(charge.currency) ?? "BRL",
    paidAt,
    transactionId: asString(lastTx.id) ?? asString(charge.transaction_id),
    orderCode:
      asString(order.code) ??
      asString(charge.code) ??
      asString(metadata.yes_hotel_cobranca_id) ??
      asString(metadata.order_code),
    paymentMethod: asString(charge.payment_method),
    paymentLinkId: asString(charge.payment_link_id) ?? asString(metadata.payment_link_id),
  };
}

export function mapWebhookEventToRevisaoMotivo(tipoEvento: string): RevisaoMotivo | null {
  const t = tipoEvento.trim().toLowerCase();
  if (t === "charge.underpaid") return "charge_underpaid";
  if (t === "charge.overpaid") return "charge_overpaid";
  if (t === "charge.partial_canceled") return "charge_partial_canceled";
  return null;
}

export function isChargebackEvent(tipoEvento: string): boolean {
  const t = tipoEvento.trim().toLowerCase();
  return t === "charge.chargedback" || t === "chargeback.received";
}

/**
 * Sanitiza payload de webhook antes de persistir.
 * Remove QR, links completos e qualquer campo de cartão.
 */
export function sanitizeWebhookPayload(payload: unknown): Record<string, unknown> {
  const sanitized = sanitizeWebhookNode(payload, 0);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}

function sanitizeWebhookNode(value: unknown, depth: number): unknown {
  if (depth > 10) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (/^000201/.test(value) || value.length > 120) return "[REDACTED]";
    if (/payment-link\.pagar\.me/i.test(value)) return "[REDACTED_PAYMENT_LINK]";
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeWebhookNode(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        /qr_code|qrcode|card|cvv|number|expir|payment_link_url|copia|senha|secret/i.test(k)
      ) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitizeWebhookNode(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/** Extrai event id / tipo / ids úteis do payload (só correlação; nunca prova). */
export function extractWebhookHints(payload: unknown): {
  eventId: string | null;
  tipoEvento: string | null;
  chargeId: string | null;
  orderId: string | null;
  paymentLinkId: string | null;
  orderCode: string | null;
} {
  const root = asRecord(payload) ?? {};
  const data = asRecord(root.data) ?? root;
  const eventId =
    asString(root.id) ??
    asString(root.event_id) ??
    asString(root.webhook_id);
  const tipoEvento =
    asString(root.type) ??
    asString(root.event) ??
    asString(root.tipo);

  const charge = asRecord(data.charge) ?? (asString(data.id)?.startsWith("ch_") ? data : null);
  const order = asRecord(data.order) ?? (asString(data.id)?.startsWith("or_") ? data : null);
  const link =
    asRecord(data.payment_link) ??
    (asString(data.id)?.startsWith("pl_") ? data : null);

  return {
    eventId,
    tipoEvento,
    chargeId: asString(data.charge_id) ?? asString(charge?.id) ?? (asString(data.id)?.startsWith("ch_") ? asString(data.id) : null),
    orderId: asString(data.order_id) ?? asString(order?.id) ?? (asString(data.id)?.startsWith("or_") ? asString(data.id) : null),
    paymentLinkId:
      asString(data.payment_link_id) ??
      asString(link?.id) ??
      (asString(data.id)?.startsWith("pl_") ? asString(data.id) : null),
    orderCode:
      asString(data.order_code) ??
      asString(order?.code) ??
      asString(data.code) ??
      asString(charge?.code) ??
      asString(asRecord(data.metadata)?.yes_hotel_cobranca_id) ??
      asString(asRecord(charge?.metadata)?.yes_hotel_cobranca_id),
  };
}
