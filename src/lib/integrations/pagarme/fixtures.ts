/**
 * Fixtures sintéticas Pagar.me — sem dados reais / sem secret real.
 */

export const PAGARME_FIXTURE_SECRET = "sk_test_synthetic_not_real_000";
export const PAGARME_FIXTURE_COBRANCA_ID = "11111111-1111-4111-8111-111111111111";
export const PAGARME_FIXTURE_ORDER_ID = "or_synthetic_order_001";
export const PAGARME_FIXTURE_CHARGE_ID = "ch_synthetic_charge_001";
export const PAGARME_FIXTURE_TX_ID = "tran_synthetic_001";
export const PAGARME_FIXTURE_PAYMENT_LINK_ID = "pl_synthetic_link_001";
export const PAGARME_FIXTURE_QR =
  "00020126580014br.gov.bcb.pix0136synthetic-qr-code-not-real-52040000530398654041.005802BR5913Yes Hotel6009Sao Paulo62070503***6304ABCD";
export const PAGARME_FIXTURE_QR_URL = "https://api.pagar.me/qrcode/synthetic.png";
export const PAGARME_FIXTURE_LINK_URL =
  "https://payment-link.pagar.me/pl_synthetic_link_001";

export const fixturePixOrderResponse = {
  id: PAGARME_FIXTURE_ORDER_ID,
  code: PAGARME_FIXTURE_COBRANCA_ID,
  amount: 170000,
  currency: "BRL",
  status: "pending",
  charges: [
    {
      id: PAGARME_FIXTURE_CHARGE_ID,
      amount: 170000,
      currency: "BRL",
      status: "pending",
      payment_method: "pix",
      last_transaction: {
        id: PAGARME_FIXTURE_TX_ID,
        status: "waiting_payment",
        qr_code: PAGARME_FIXTURE_QR,
        qr_code_url: PAGARME_FIXTURE_QR_URL,
        expires_at: "2026-08-10T23:59:59Z",
      },
    },
  ],
};

export const fixturePaymentLinkResponse = {
  id: PAGARME_FIXTURE_PAYMENT_LINK_ID,
  url: PAGARME_FIXTURE_LINK_URL,
  order_code: PAGARME_FIXTURE_COBRANCA_ID,
  status: "active",
  type: "order",
  max_paid_sessions: 1,
  expires_at: "2026-08-16T00:00:00Z",
};

export const fixturePaidChargeResponse = {
  id: PAGARME_FIXTURE_CHARGE_ID,
  order_id: PAGARME_FIXTURE_ORDER_ID,
  amount: 170000,
  paid_amount: 170000,
  currency: "BRL",
  status: "paid",
  paid_at: "2026-08-09T20:15:00Z",
  payment_method: "pix",
  code: PAGARME_FIXTURE_COBRANCA_ID,
  last_transaction: {
    id: PAGARME_FIXTURE_TX_ID,
    status: "paid",
    paid_at: "2026-08-09T20:15:00Z",
  },
  order: {
    id: PAGARME_FIXTURE_ORDER_ID,
    code: PAGARME_FIXTURE_COBRANCA_ID,
  },
  metadata: {
    yes_hotel_cobranca_id: PAGARME_FIXTURE_COBRANCA_ID,
  },
};

export const fixtureWebhookChargePaid = {
  id: "evt_synthetic_paid_001",
  type: "charge.paid",
  data: {
    id: PAGARME_FIXTURE_CHARGE_ID,
    status: "paid",
    amount: 170000,
    order_id: PAGARME_FIXTURE_ORDER_ID,
    code: PAGARME_FIXTURE_COBRANCA_ID,
  },
};

export const fixtureWebhookUnderpaid = {
  id: "evt_synthetic_underpaid_001",
  type: "charge.underpaid",
  data: {
    id: PAGARME_FIXTURE_CHARGE_ID,
    status: "underpaid",
    amount: 170000,
    order_id: PAGARME_FIXTURE_ORDER_ID,
    code: PAGARME_FIXTURE_COBRANCA_ID,
  },
};

export function createMockPagarmeFetch(handlers: {
  match: (url: string, method: string) => boolean;
  status?: number;
  body?: unknown;
  throwError?: Error;
}[]): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    const url = String(input);
    for (const h of handlers) {
      if (!h.match(url, method)) continue;
      if (h.throwError) throw h.throwError;
      const status = h.status ?? 200;
      // 204/205 não podem carregar body no Fetch/undici.
      const noBody = status === 204 || status === 205;
      const raw =
        noBody || h.body === undefined
          ? null
          : JSON.stringify(h.body);
      return new Response(raw, {
        status,
        headers: noBody ? undefined : { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "mock not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}
