/**
 * Testes locais — cobranca-pagarme-service (regras, anti-dup, ambiguo, webhook).
 * Sem rede real / sem Supabase remoto.
 */
import assert from "node:assert/strict";
import {
  CobrancaPagarmeService,
  assertClassificacaoPermiteCobranca,
} from "../src/lib/application/yes-hotel/cobranca-pagarme-service";
import { createMemoryCobrancaRepo } from "../src/lib/application/yes-hotel/testing/cobranca-pagarme-memory";
import {
  PAGARME_FIXTURE_CHARGE_ID,
  PAGARME_FIXTURE_COBRANCA_ID,
  PAGARME_FIXTURE_LINK_URL,
  PAGARME_FIXTURE_ORDER_ID,
  PAGARME_FIXTURE_PAYMENT_LINK_ID,
  PAGARME_CHECKOUT_TEST_API_BASE_URL,
  PAGARME_CORE_API_BASE_URL,
  PAGARME_FIXTURE_SECRET,
  PagarmeClient,
  createMockPagarmeFetch,
  fixturePaidChargeResponse,
  fixturePaymentLinkResponse,
  fixturePixOrderResponse,
  fixtureWebhookChargePaid,
  fixtureWebhookUnderpaid,
  getPagarmeConfig,
  isYesHotelCobrancaUuid,
  mapStatusAfterRemoteCreate,
} from "../src/lib/integrations/pagarme";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const RESERVA_OK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESERVA_COM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESERVA_DESC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OPERATOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const pixCustomer = {
  name: "Hospede Sintetico",
  email: "sintetico@example.invalid",
  document: "52998224725",
  phone_number: "11999990000",
};

function seedRepo() {
  return createMemoryCobrancaRepo({
    reservas: [
      {
        id: RESERVA_OK,
        external_reservation_id: "HITS-1",
        classificacao_comissionamento: "nao_comissionada",
        pagamento_status: "pendente",
      },
      {
        id: RESERVA_COM,
        external_reservation_id: "HITS-2",
        classificacao_comissionamento: "comissionada",
        pagamento_status: "pendente",
      },
      {
        id: RESERVA_DESC,
        external_reservation_id: "HITS-3",
        classificacao_comissionamento: "desconhecida",
        pagamento_status: "pendente",
      },
    ],
    pixCustomers: [{ reservaId: RESERVA_OK, customer: pixCustomer }],
  });
}

function homologClient(fetchImpl: typeof fetch) {
  return new PagarmeClient({
    config: getPagarmeConfig({
      PAGARME_ENV: "test",
      PAGARME_INTEGRATION_ENABLED: "true",
      PAGARME_SECRET_KEY: PAGARME_FIXTURE_SECRET,
      PAGARME_CORE_API_BASE_URL: PAGARME_CORE_API_BASE_URL,
      PAGARME_CHECKOUT_API_BASE_URL: PAGARME_CHECKOUT_TEST_API_BASE_URL,
    }),
    fetchImpl: fetchImpl as never,
  });
}

async function main() {
  console.log("\n[test-cobranca-pagarme-service]");

  // Gate classificação
  assert.equal(assertClassificacaoPermiteCobranca("nao_comissionada").ok, true);
  assert.equal(assertClassificacaoPermiteCobranca("comissionada").ok, false);
  assert.equal(assertClassificacaoPermiteCobranca("desconhecida").ok, false);
  ok("gate classificacao: permite / comissionada / desconhecida");

  // Comissionada bloqueia
  {
    const { repo } = seedRepo();
    let pagarmeCalls = 0;
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: () => {
            pagarmeCalls += 1;
            return true;
          },
          body: fixturePixOrderResponse,
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({ repo, client });
    const r = await svc.criar({
      reservaId: RESERVA_COM,
      metodo: "pix",
      valorCentavos: 100_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "comissionada_bloqueada");
    assert.equal(pagarmeCalls, 0);
    ok("comissionada bloqueia e nao chama Pagar.me");
  }

  // Desconhecida bloqueia
  {
    const { repo } = seedRepo();
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(createMockPagarmeFetch([]) as never),
    });
    const r = await svc.criar({
      reservaId: RESERVA_DESC,
      metodo: "cartao",
      valorCentavos: 100_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "classificacao_desconhecida");
    ok("desconhecida bloqueia");
  }

  // nao_comissionada permite cartão
  {
    const { repo, state } = seedRepo();
    let calls = 0;
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: (u, m) => {
            if (m === "POST" && u.includes("/paymentlinks")) {
              calls += 1;
              return true;
            }
            return false;
          },
          body: fixturePaymentLinkResponse,
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({
      repo,
      client,
      newId: () => PAGARME_FIXTURE_COBRANCA_ID,
    });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 170_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, true);
    assert.equal(calls, 1);
    assert.equal(state.cobrancas.size, 1);
    const cob = [...state.cobrancas.values()][0]!;
    assert.equal(cob.status, "pending");
    assert.equal(cob.pagarme_payment_link_id, fixturePaymentLinkResponse.id);
    ok("nao_comissionada permite cartao + INSERT antes da API");
  }

  // Pix extrai QR
  {
    const { repo, state } = seedRepo();
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: (u, m) => m === "POST" && u.includes("/orders"),
          body: fixturePixOrderResponse,
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({
      repo,
      client,
      newId: () => PAGARME_FIXTURE_COBRANCA_ID,
    });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "pix",
      valorCentavos: 170_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, true);
    const cob = [...state.cobrancas.values()][0]!;
    assert.ok(cob.pix_qr_code);
    assert.ok(cob.pix_qr_code_url);
    assert.ok(cob.expira_em);
    assert.equal(cob.pagarme_charge_id, fixturePixOrderResponse.charges[0]!.id);
    ok("pix persiste qr/url/expires/charge de last_transaction");
  }

  // Concorrência: segunda criação não chama Pagar.me
  {
    const { repo, state } = seedRepo();
    let calls = 0;
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: (u, m) => {
            if (m === "POST" && u.includes("/paymentlinks")) {
              calls += 1;
              return true;
            }
            return false;
          },
          body: fixturePaymentLinkResponse,
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({ repo, client });
    const first = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(first.ok, true);
    const second = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.data.reused_existing, true);
    assert.equal(calls, 1);
    assert.equal(state.cobrancas.size, 1);
    ok("concorrencia: uma cobranca; segunda nao chama Pagar.me");
  }

  // Timeout após insert → processing (não failed)
  {
    const { repo, state } = seedRepo();
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: (u, m) => m === "POST" && u.includes("/paymentlinks"),
          throwError: Object.assign(new Error("aborted"), { name: "AbortError" }),
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({ repo, client });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "resultado_ambiguo");
    const cob = [...state.cobrancas.values()][0]!;
    assert.equal(cob.status, "processing");
    // segunda tentativa ainda bloqueada
    const second = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.data.reused_existing, true);
    ok("timeout => processing bloqueante; nao libera nova cobranca");
  }

  // 429 / 5xx => processing
  for (const status of [429, 503]) {
    const { repo, state } = seedRepo();
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: (u, m) => m === "POST" && u.includes("/paymentlinks"),
          status,
          body: { message: "tmp" },
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({ repo, client });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, false);
    const cob = [...state.cobrancas.values()][0]!;
    assert.equal(cob.status, "processing");
    ok(`${status} => processing bloqueante`);
  }

  // Erro definitivo => failed
  {
    const { repo, state } = seedRepo();
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: (u, m) => m === "POST" && u.includes("/paymentlinks"),
          status: 400,
          body: { message: "invalid" },
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({ repo, client });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, false);
    const cob = [...state.cobrancas.values()][0]!;
    assert.equal(cob.status, "failed");
    ok("400 definitivo => failed");
  }

  // Cancelar cartão sem charge_id cancela Payment Link
  {
    const { repo, state } = seedRepo();
    let cancelLink = 0;
    let cancelCharge = 0;
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: (u, m) => m === "POST" && u.includes("/paymentlinks"),
          body: fixturePaymentLinkResponse,
        },
        {
          match: (u, m) => {
            if (m === "PATCH" && u.includes("/paymentlinks/") && u.endsWith("/cancel")) {
              cancelLink += 1;
              return true;
            }
            if (m === "DELETE" && u.includes("/charges/")) {
              cancelCharge += 1;
              return true;
            }
            return false;
          },
          status: 204,
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({
      repo,
      client,
      newId: () => PAGARME_FIXTURE_COBRANCA_ID,
    });
    await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    const cancel = await svc.cancelar({ cobrancaId: PAGARME_FIXTURE_COBRANCA_ID });
    assert.equal(cancel.ok, true);
    assert.equal(cancelLink, 1);
    assert.equal(cancelCharge, 0);
    assert.equal([...state.cobrancas.values()][0]!.status, "canceled");
    ok("cartao sem charge_id cancela Payment Link");
  }

  // paid não cancela simples
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: "HITS-1",
      metodo: "pix",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "paid",
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: "or_x",
      pagarme_charge_id: PAGARME_FIXTURE_CHARGE_ID,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "paid",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(createMockPagarmeFetch([]) as never),
    });
    const r = await svc.cancelar({ cobrancaId: PAGARME_FIXTURE_COBRANCA_ID });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "pago_nao_cancelavel");
    ok("paid nao trata como cancelamento simples");
  }

  // Webhook: não confia no payload; GET S2S; sem duplicar evento/pagamento
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: "HITS-1",
      metodo: "pix",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: `yh-cobranca-${PAGARME_FIXTURE_COBRANCA_ID}`,
      status: "pending",
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: fixturePixOrderResponse.id,
      pagarme_charge_id: PAGARME_FIXTURE_CHARGE_ID,
      pix_qr_code: "x",
      pix_qr_code_url: "y",
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });

    let getChargeCalls = 0;
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: (u, m) => {
            if (m === "GET" && u.includes(`/charges/${PAGARME_FIXTURE_CHARGE_ID}`)) {
              getChargeCalls += 1;
              return true;
            }
            return false;
          },
          body: fixturePaidChargeResponse,
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({ repo, client });

    // Payload mentiroso: status unpaid no webhook, mas GET diz paid
    const mentiroso = {
      ...fixtureWebhookChargePaid,
      data: { ...fixtureWebhookChargePaid.data, status: "pending" },
    };
    const first = await svc.processWebhook(mentiroso);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.data.payment_registered, true);
      assert.equal(first.data.duplicate_event, false);
    }
    assert.equal(getChargeCalls, 1);
    assert.equal([...state.cobrancas.values()][0]!.status, "paid");
    assert.equal(state.pagamentos.size, 1);
    const pag = [...state.pagamentos.values()][0]!;
    assert.equal(pag.sincronizacao_hits_status, "aguardando_registro_hits");
    assert.equal(pag.pago_em, fixturePaidChargeResponse.paid_at);
    ok("webhook nao confia no payload; paid so apos GET S2S");

    const dup = await svc.processWebhook(mentiroso);
    assert.equal(dup.ok, true);
    if (dup.ok) assert.equal(dup.data.duplicate_event, true);
    assert.equal(getChargeCalls, 1);
    assert.equal(state.pagamentos.size, 1);
    ok("webhook repetido nao duplica evento nem pagamento");
  }

  // underpaid => revisão após GET S2S, não paid
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "pix",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "pending",
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: null,
      pagarme_charge_id: PAGARME_FIXTURE_CHARGE_ID,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => m === "GET" && u.includes(`/charges/${PAGARME_FIXTURE_CHARGE_ID}`),
            body: {
              ...fixturePaidChargeResponse,
              status: "underpaid",
              paid_amount: 1000,
            },
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook(fixtureWebhookUnderpaid);
    assert.equal(r.ok, true);
    const cob = [...state.cobrancas.values()][0]!;
    assert.equal(cob.status, "pending");
    assert.equal(cob.requer_revisao_operacional, true);
    assert.equal(cob.requer_revisao_motivo, "charge_underpaid");
    assert.ok(cob.requer_revisao_detectado_em);
    assert.equal(state.pagamentos.size, 0);
    ok("underpaid marca revisao atomica sem paid");
  }

  // --- Correções auditoria: obrigação já paga / refunded / chargeback ---
  function seedBlocking(
    status: "paid" | "refunded" | "chargeback" | "failed" | "expired" | "canceled",
  ) {
    const { repo, state } = seedRepo();
    state.cobrancas.set("prev-cob", {
      id: "prev-cob",
      reserva_id: RESERVA_OK,
      external_reservation_id: "HITS-1",
      metodo: "pix",
      valor_centavos: 100_000,
      moeda: "BRL",
      idempotency_key: "prev",
      status,
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: "or_prev",
      pagarme_charge_id: "ch_prev",
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: status,
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    return { repo, state };
  }

  for (const st of ["paid", "refunded", "chargeback"] as const) {
    const { repo } = seedBlocking(st);
    let calls = 0;
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: () => {
              calls += 1;
              return true;
            },
            body: fixturePaymentLinkResponse,
          },
        ]) as never,
      ),
    });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "obrigacao_ja_paga");
    assert.equal(calls, 0);
    ok(`${st} anterior bloqueia nova cobranca`);
  }

  for (const st of ["failed", "expired", "canceled"] as const) {
    const { repo, state } = seedBlocking(st);
    let calls = 0;
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => {
              if (m === "POST" && u.includes("/paymentlinks")) {
                calls += 1;
                return true;
              }
              return false;
            },
            body: fixturePaymentLinkResponse,
          },
        ]) as never,
      ),
    });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, true);
    assert.equal(calls, 1);
    assert.equal(state.cobrancas.size, 2);
    ok(`${st} permite nova tentativa`);
  }

  // 409 => processing bloqueante
  {
    const { repo, state } = seedRepo();
    let calls = 0;
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: (u, m) => {
            if (m === "POST" && u.includes("/paymentlinks")) {
              calls += 1;
              return true;
            }
            return false;
          },
          status: 409,
          body: { message: "conflict" },
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({ repo, client });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "resultado_ambiguo");
    assert.equal([...state.cobrancas.values()][0]!.status, "processing");
    const second = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 120_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(second.ok, true);
    if (second.ok) assert.equal(second.data.reused_existing, true);
    assert.equal(calls, 1);
    assert.equal(state.cobrancas.size, 1);
    ok("409 => processing; segunda tentativa nao chama Pagar.me");
  }

  // chargeback sem chargeId nao altera status
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "cartao",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "pending",
      pagarme_payment_link_id: "pl_x",
      pagarme_payment_link_url: "https://payment-link.pagar.me/pl_x",
      pagarme_order_id: null,
      pagarme_charge_id: null,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    let gets = 0;
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => {
              if (m === "GET") {
                gets += 1;
                return true;
              }
              return false;
            },
            body: fixturePaidChargeResponse,
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook({
      id: "evt_fake_cb",
      type: "charge.chargedback",
      data: { order_code: PAGARME_FIXTURE_COBRANCA_ID, status: "chargedback" },
    });
    assert.equal(r.ok, true);
    assert.equal(gets, 0);
    assert.equal([...state.cobrancas.values()][0]!.status, "pending");
    ok("chargeback sem chargeId nao altera status financeiro");
  }

  // chargeback com charge_id local + GET funciona
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "pix",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "paid",
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: fixturePixOrderResponse.id,
      pagarme_charge_id: PAGARME_FIXTURE_CHARGE_ID,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "paid",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => m === "GET" && u.includes(`/charges/${PAGARME_FIXTURE_CHARGE_ID}`),
            body: {
              ...fixturePaidChargeResponse,
              status: "chargedback",
            },
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook({
      id: "evt_cb_local",
      type: "chargeback.received",
      data: { order_code: PAGARME_FIXTURE_COBRANCA_ID },
    });
    assert.equal(r.ok, true);
    assert.equal([...state.cobrancas.values()][0]!.status, "chargeback");
    ok("chargeback via pagarme_charge_id local + GET S2S");
  }

  // Correlação fail-closed
  async function webhookPaidWithOrderCode(orderCode: string | null) {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "pix",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "pending",
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: fixturePixOrderResponse.id,
      pagarme_charge_id: PAGARME_FIXTURE_CHARGE_ID,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    const body = {
      ...fixturePaidChargeResponse,
      code: orderCode,
      order: { id: fixturePixOrderResponse.id, code: orderCode },
      metadata: orderCode ? { yes_hotel_cobranca_id: orderCode } : {},
    };
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => m === "GET" && u.includes(`/charges/${PAGARME_FIXTURE_CHARGE_ID}`),
            body,
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook(fixtureWebhookChargePaid);
    return { r, state };
  }

  {
    const { r, state } = await webhookPaidWithOrderCode(null);
    assert.equal(r.ok, true);
    assert.equal([...state.cobrancas.values()][0]!.status, "pending");
    assert.equal(state.pagamentos.size, 0);
    ok("orderCode ausente => nao paid (fail-closed)");
  }
  {
    const { r, state } = await webhookPaidWithOrderCode("00000000-0000-4000-8000-000000000099");
    assert.equal(r.ok, true);
    assert.equal([...state.cobrancas.values()][0]!.status, "pending");
    assert.equal(state.pagamentos.size, 0);
    ok("orderCode divergente => nao paid (fail-closed)");
  }
  {
    const { r, state } = await webhookPaidWithOrderCode(PAGARME_FIXTURE_COBRANCA_ID);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.data.payment_registered, true);
    assert.equal([...state.cobrancas.values()][0]!.status, "paid");
    assert.equal(state.pagamentos.size, 1);
    ok("orderCode correto => paid");
  }

  // Pix status pos-criacao
  {
    assert.equal(mapStatusAfterRemoteCreate("pending").localStatus, "pending");
    assert.equal(mapStatusAfterRemoteCreate("processing").localStatus, "processing");
    assert.equal(mapStatusAfterRemoteCreate("failed").localStatus, "failed");
    assert.equal(mapStatusAfterRemoteCreate("paid").localStatus, "pending");
    assert.equal(mapStatusAfterRemoteCreate("paid").registersPayment, false);
    ok("mapStatusAfterRemoteCreate: pending/processing/failed/paid");
  }

  {
    const { repo, state } = seedRepo();
    const failedOrder = {
      ...fixturePixOrderResponse,
      status: "failed",
      charges: [
        {
          ...fixturePixOrderResponse.charges[0],
          status: "failed",
          last_transaction: {
            ...fixturePixOrderResponse.charges[0]!.last_transaction,
            status: "failed",
          },
        },
      ],
    };
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          { match: (u, m) => m === "POST" && u.includes("/orders"), body: failedOrder },
        ]) as never,
      ),
      newId: () => PAGARME_FIXTURE_COBRANCA_ID,
    });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "pix",
      valorCentavos: 170_000,
      operadorUserId: OPERATOR,
    });
    assert.equal(r.ok, true);
    assert.equal([...state.cobrancas.values()][0]!.status, "failed");
    assert.equal(state.pagamentos.size, 0);
    ok("Pix response failed nao fica pending eterno");
  }

  // Secret não aparece em logs de erro do serviço
  {
    const { repo } = seedRepo();
    const client = homologClient(
      createMockPagarmeFetch([
        {
          match: () => true,
          status: 400,
          body: { message: `bad ${PAGARME_FIXTURE_SECRET}` },
        },
      ]) as never,
    );
    const svc = new CobrancaPagarmeService({ repo, client });
    const r = await svc.criar({
      reservaId: RESERVA_OK,
      metodo: "cartao",
      valorCentavos: 1000,
      operadorUserId: OPERATOR,
    });
    const dumped = JSON.stringify(r);
    assert.equal(dumped.includes(PAGARME_FIXTURE_SECRET), false);
    ok("secret nao aparece no resultado do servico");
  }

  // --- Prefilter Bee2Pay / unrelated: zero INSERT, zero GET, zero mutação ---
  assert.equal(isYesHotelCobrancaUuid(PAGARME_FIXTURE_COBRANCA_ID), true);
  assert.equal(isYesHotelCobrancaUuid("or_bee2pay_external_001"), false);
  assert.equal(isYesHotelCobrancaUuid("ch_bee2pay_external_001"), false);
  assert.equal(isYesHotelCobrancaUuid("pl_bee2pay_external_001"), false);
  assert.equal(isYesHotelCobrancaUuid("BEE2PAY-OTA-ORDER-XYZ"), false);
  ok("isYesHotelCobrancaUuid: UUID local vs or_/ch_/pl_/texto");

  async function assertUnrelatedIgnored(
    label: string,
    payload: Record<string, unknown>,
  ) {
    const { repo, state } = seedRepo();
    const reservaAntes = structuredClone(state.reservas.get(RESERVA_OK)!);
    let getCalls = 0;
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => {
              if (m === "GET") {
                getCalls += 1;
                return true;
              }
              return false;
            },
            body: fixturePaidChargeResponse,
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook(payload);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.data.unrelated_ignored, true);
      assert.equal(r.data.payment_registered, false);
      assert.equal(r.data.cobranca_id, null);
    }
    assert.equal(state.webhooks.size, 0);
    assert.equal(getCalls, 0);
    assert.equal(state.pagamentos.size, 0);
    assert.equal(state.cobrancas.size, 0);
    assert.deepEqual(state.reservas.get(RESERVA_OK), reservaAntes);
    ok(label);
  }

  // Reprodução do bug produção: or_* em lookup UUID → agora ignored sem throw
  await assertUnrelatedIgnored("bug or_* externo: unrelated sem exception/INSERT/GET", {
    id: "evt_bug_or_non_uuid",
    type: "charge.paid",
    data: {
      id: "ch_bee2pay_external_001",
      status: "paid",
      amount: 99900,
      order_id: "or_bee2pay_external_001",
      code: "BEE2PAY-EXTERNAL-CODE",
      payment_link_id: "pl_bee2pay_external_001",
    },
  });

  const UNRELATED_EVENTS = [
    "charge.paid",
    "charge.payment_failed",
    "charge.pending",
    "charge.processing",
    "charge.refunded",
    "chargeback.received",
    "charge.chargedback",
    "charge.underpaid",
    "charge.overpaid",
    "charge.partial_canceled",
  ] as const;

  for (const tipo of UNRELATED_EVENTS) {
    await assertUnrelatedIgnored(`unrelated ${tipo}: ignored sem INSERT/GET/mutacao`, {
      id: `evt_bee2pay_${tipo.replace(/\./g, "_")}`,
      type: tipo,
      data: {
        id: "ch_bee2pay_ota_unrelated_001",
        status: "paid",
        amount: 99900,
        order_id: "or_bee2pay_ota_unrelated_001",
        code: "BEE2PAY-OTA-ORDER-XYZ",
        payment_link_id: "pl_bee2pay_ota_unrelated_001",
      },
    });
  }

  // Hints isolados não-UUID / remotos externos
  await assertUnrelatedIgnored("hint A: so order_id or_*", {
    id: "evt_hint_or_only",
    type: "charge.paid",
    data: { order_id: "or_bee2pay_only_001", status: "paid" },
  });
  await assertUnrelatedIgnored("hint B: so charge_id ch_*", {
    id: "evt_hint_ch_only",
    type: "charge.paid",
    data: { id: "ch_bee2pay_only_001", status: "paid" },
  });
  await assertUnrelatedIgnored("hint C: so payment_link_id pl_*", {
    id: "evt_hint_pl_only",
    type: "charge.paid",
    data: { payment_link_id: "pl_bee2pay_only_001", status: "paid" },
  });
  await assertUnrelatedIgnored("hint D: so code nao-UUID", {
    id: "evt_hint_code_only",
    type: "charge.paid",
    data: { code: "BEE2PAY-CODE-ONLY", status: "paid" },
  });
  await assertUnrelatedIgnored("hint E: so order_code nao-UUID", {
    id: "evt_hint_order_code_only",
    type: "charge.paid",
    data: { order_code: "RESERVA-OTA-XYZ", status: "paid" },
  });
  await assertUnrelatedIgnored("hint F: metadata yes_hotel_cobranca_id nao-UUID", {
    id: "evt_hint_meta_only",
    type: "charge.paid",
    data: {
      status: "paid",
      metadata: { yes_hotel_cobranca_id: "not-a-uuid-external" },
    },
  });

  // Remote IDs legítimos Yes Hotel (colunas TEXT)
  async function assertRemoteIdFindsLocal(opts: {
    label: string;
    seed: Partial<{
      pagarme_order_id: string | null;
      pagarme_charge_id: string | null;
      pagarme_payment_link_id: string | null;
    }>;
    payloadData: Record<string, unknown>;
    remoteChargeIdForGet: string;
  }) {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "cartao",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "pending",
      pagarme_payment_link_id: opts.seed.pagarme_payment_link_id ?? null,
      pagarme_payment_link_url: null,
      pagarme_order_id: opts.seed.pagarme_order_id ?? null,
      pagarme_charge_id: opts.seed.pagarme_charge_id ?? null,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    let getCalls = 0;
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => {
              if (m === "GET" && u.includes(`/charges/${opts.remoteChargeIdForGet}`)) {
                getCalls += 1;
                return true;
              }
              return false;
            },
            body: {
              ...fixturePaidChargeResponse,
              id: opts.remoteChargeIdForGet,
              order_id: opts.seed.pagarme_order_id ?? PAGARME_FIXTURE_ORDER_ID,
              code: PAGARME_FIXTURE_COBRANCA_ID,
              order: {
                id: opts.seed.pagarme_order_id ?? PAGARME_FIXTURE_ORDER_ID,
                code: PAGARME_FIXTURE_COBRANCA_ID,
              },
            },
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook({
      id: `evt_remote_${opts.label}`,
      type: "charge.paid",
      data: opts.payloadData,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.data.unrelated_ignored, undefined);
      assert.equal(r.data.payment_registered, true);
    }
    assert.equal(state.webhooks.size, 1);
    assert.equal(getCalls, 1);
    assert.equal(state.pagamentos.size, 1);
    assert.equal(state.cobrancas.get(PAGARME_FIXTURE_COBRANCA_ID)!.status, "paid");
    ok(opts.label);
  }

  await assertRemoteIdFindsLocal({
    label: "remote order_id or_yes encontra pagarme_order_id",
    seed: { pagarme_order_id: "or_yes_123", pagarme_charge_id: null },
    payloadData: {
      id: "ch_yes_from_order",
      order_id: "or_yes_123",
      status: "paid",
      amount: 170000,
    },
    remoteChargeIdForGet: "ch_yes_from_order",
  });
  await assertRemoteIdFindsLocal({
    label: "remote charge_id ch_yes encontra pagarme_charge_id",
    seed: { pagarme_charge_id: "ch_yes_123" },
    payloadData: {
      id: "ch_yes_123",
      status: "paid",
      amount: 170000,
      code: PAGARME_FIXTURE_COBRANCA_ID,
    },
    remoteChargeIdForGet: "ch_yes_123",
  });
  await assertRemoteIdFindsLocal({
    label: "remote pl_yes encontra pagarme_payment_link_id",
    seed: { pagarme_payment_link_id: "pl_yes_123" },
    payloadData: {
      id: "ch_yes_from_pl",
      payment_link_id: "pl_yes_123",
      status: "paid",
      amount: 170000,
      code: PAGARME_FIXTURE_COBRANCA_ID,
    },
    remoteChargeIdForGet: "ch_yes_from_pl",
  });

  // Adversarial: UUID local forjado no payload + charge remoto alheio → GET + fail-closed
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "cartao",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "pending",
      pagarme_payment_link_id: PAGARME_FIXTURE_PAYMENT_LINK_ID,
      pagarme_payment_link_url: PAGARME_FIXTURE_LINK_URL,
      pagarme_order_id: null,
      pagarme_charge_id: null,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    let getCalls = 0;
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => {
              if (m === "GET" && u.includes("/charges/ch_bee2pay_foreign_001")) {
                getCalls += 1;
                return true;
              }
              return false;
            },
            body: {
              ...fixturePaidChargeResponse,
              id: "ch_bee2pay_foreign_001",
              order_id: "or_bee2pay_foreign_001",
              code: "00000000-0000-4000-8000-000000000099",
              order: {
                id: "or_bee2pay_foreign_001",
                code: "00000000-0000-4000-8000-000000000099",
              },
              metadata: {
                yes_hotel_cobranca_id: "00000000-0000-4000-8000-000000000099",
              },
            },
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook({
      id: "evt_forged_uuid_payload",
      type: "charge.paid",
      data: {
        id: "ch_bee2pay_foreign_001",
        code: PAGARME_FIXTURE_COBRANCA_ID,
        status: "paid",
        amount: 170000,
      },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.data.unrelated_ignored, undefined);
      assert.equal(r.data.payment_registered, false);
    }
    assert.equal(state.webhooks.size, 1);
    assert.equal(getCalls, 1);
    assert.equal(state.pagamentos.size, 0);
    const cobForged = state.cobrancas.get(PAGARME_FIXTURE_COBRANCA_ID)!;
    assert.equal(cobForged.status, "pending");
    assert.equal(cobForged.pagarme_charge_id, null);
    assert.equal(cobForged.pagarme_order_id, null);
    assert.equal(cobForged.pagarme_payment_link_id, PAGARME_FIXTURE_PAYMENT_LINK_ID);
    ok("forjado: rejeita paid e NAO contamina charge_id/order_id");
  }

  // IDs legítimos pré-existentes permanecem intactos sob snapshot estrangeiro
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "cartao",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "pending",
      pagarme_payment_link_id: "pl_yes_legitimo",
      pagarme_payment_link_url: "https://payment-link.pagar.me/pl_yes_legitimo",
      pagarme_order_id: "or_yes_legitimo",
      pagarme_charge_id: "ch_yes_legitimo",
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => m === "GET" && u.includes("/charges/ch_bee2pay_foreign_002"),
            body: {
              ...fixturePaidChargeResponse,
              id: "ch_bee2pay_foreign_002",
              order_id: "or_bee2pay_foreign_002",
              code: "00000000-0000-4000-8000-000000000088",
              order: {
                id: "or_bee2pay_foreign_002",
                code: "00000000-0000-4000-8000-000000000088",
              },
            },
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook({
      id: "evt_foreign_vs_legit_ids",
      type: "charge.paid",
      data: {
        id: "ch_bee2pay_foreign_002",
        code: PAGARME_FIXTURE_COBRANCA_ID,
        status: "paid",
        amount: 170000,
      },
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.data.payment_registered, false);
    const cob = state.cobrancas.get(PAGARME_FIXTURE_COBRANCA_ID)!;
    assert.equal(cob.status, "pending");
    assert.equal(cob.pagarme_charge_id, "ch_yes_legitimo");
    assert.equal(cob.pagarme_order_id, "or_yes_legitimo");
    assert.equal(cob.pagarme_payment_link_id, "pl_yes_legitimo");
    assert.equal(state.pagamentos.size, 0);
    ok("IDs legitimos pre-existentes intactos sob snapshot estrangeiro");
  }

  // payment_failed estrangeiro nao contamina IDs
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "cartao",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "pending",
      pagarme_payment_link_id: PAGARME_FIXTURE_PAYMENT_LINK_ID,
      pagarme_payment_link_url: PAGARME_FIXTURE_LINK_URL,
      pagarme_order_id: null,
      pagarme_charge_id: null,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => m === "GET" && u.includes("/charges/ch_bee2pay_fail_001"),
            body: {
              ...fixturePaidChargeResponse,
              id: "ch_bee2pay_fail_001",
              order_id: "or_bee2pay_fail_001",
              status: "failed",
              code: "00000000-0000-4000-8000-000000000077",
              order: {
                id: "or_bee2pay_fail_001",
                code: "00000000-0000-4000-8000-000000000077",
              },
              paid_amount: null,
              paid_at: null,
            },
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook({
      id: "evt_foreign_failed",
      type: "charge.payment_failed",
      data: {
        id: "ch_bee2pay_fail_001",
        code: PAGARME_FIXTURE_COBRANCA_ID,
        status: "failed",
      },
    });
    assert.equal(r.ok, true);
    const cob = state.cobrancas.get(PAGARME_FIXTURE_COBRANCA_ID)!;
    assert.equal(cob.status, "pending");
    assert.equal(cob.pagarme_charge_id, null);
    assert.equal(cob.pagarme_order_id, null);
    assert.equal(cob.pagarme_payment_link_id, PAGARME_FIXTURE_PAYMENT_LINK_ID);
    ok("payment_failed estrangeiro: zero contaminacao de IDs");
  }

  // chargeback estrangeiro nao contamina IDs
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "cartao",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "paid",
      pagarme_payment_link_id: "pl_yes_legitimo",
      pagarme_payment_link_url: null,
      pagarme_order_id: "or_yes_legitimo",
      pagarme_charge_id: "ch_yes_legitimo",
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "paid",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => m === "GET" && u.includes("/charges/ch_bee2pay_cb_001"),
            body: {
              ...fixturePaidChargeResponse,
              id: "ch_bee2pay_cb_001",
              order_id: "or_bee2pay_cb_001",
              status: "chargedback",
              code: "00000000-0000-4000-8000-000000000066",
              order: {
                id: "or_bee2pay_cb_001",
                code: "00000000-0000-4000-8000-000000000066",
              },
            },
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook({
      id: "evt_foreign_cb",
      type: "charge.chargedback",
      data: {
        id: "ch_bee2pay_cb_001",
        code: PAGARME_FIXTURE_COBRANCA_ID,
        status: "chargedback",
      },
    });
    assert.equal(r.ok, true);
    const cob = state.cobrancas.get(PAGARME_FIXTURE_COBRANCA_ID)!;
    assert.equal(cob.status, "paid");
    assert.equal(cob.pagarme_charge_id, "ch_yes_legitimo");
    assert.equal(cob.pagarme_order_id, "or_yes_legitimo");
    ok("chargeback estrangeiro: zero contaminacao; status intacto");
  }

  // Hints contraditórios: charge aponta A, code aponta C — correlação falha sem contaminar
  {
    const otherId = "22222222-2222-4222-8222-222222222222";
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "cartao",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "a",
      status: "pending",
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: null,
      pagarme_charge_id: "ch_candidate_a",
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    state.cobrancas.set(otherId, {
      id: otherId,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "cartao",
      valor_centavos: 50_000,
      moeda: "BRL",
      idempotency_key: "b",
      status: "failed",
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: "or_candidate_b",
      pagarme_charge_id: null,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "failed",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => m === "GET" && u.includes("/charges/ch_candidate_a"),
            body: {
              ...fixturePaidChargeResponse,
              id: "ch_candidate_a",
              order_id: "or_foreign_snap",
              code: otherId,
              order: { id: "or_foreign_snap", code: otherId },
              amount: 170000,
              paid_amount: 170000,
            },
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook({
      id: "evt_contradictory_hints",
      type: "charge.paid",
      data: {
        id: "ch_candidate_a",
        order_id: "or_candidate_b",
        code: otherId,
        status: "paid",
        amount: 170000,
      },
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.data.payment_registered, false);
    const a = state.cobrancas.get(PAGARME_FIXTURE_COBRANCA_ID)!;
    const b = state.cobrancas.get(otherId)!;
    assert.equal(a.status, "pending");
    assert.equal(a.pagarme_charge_id, "ch_candidate_a");
    assert.equal(a.pagarme_order_id, null);
    assert.equal(b.status, "failed");
    assert.equal(b.pagarme_order_id, "or_candidate_b");
    assert.equal(state.pagamentos.size, 0);
    ok("hints contraditorios: fail-closed sem contaminacao");
  }

  // charge.payment_failed local — fluxo preservado (espelho sem paid)
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "pix",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "pending",
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: fixturePixOrderResponse.id,
      pagarme_charge_id: PAGARME_FIXTURE_CHARGE_ID,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    let getCalls = 0;
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => {
              if (m === "GET" && u.includes(`/charges/${PAGARME_FIXTURE_CHARGE_ID}`)) {
                getCalls += 1;
                return true;
              }
              return false;
            },
            body: {
              ...fixturePaidChargeResponse,
              status: "failed",
              paid_amount: null,
              paid_at: null,
            },
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook({
      id: "evt_local_payment_failed",
      type: "charge.payment_failed",
      data: {
        id: PAGARME_FIXTURE_CHARGE_ID,
        status: "failed",
        order_id: fixturePixOrderResponse.id,
        code: PAGARME_FIXTURE_COBRANCA_ID,
      },
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.data.unrelated_ignored, undefined);
      assert.equal(r.data.payment_registered, false);
    }
    assert.equal(state.webhooks.size, 1);
    assert.equal(getCalls, 1);
    assert.equal(state.pagamentos.size, 0);
    const cob = [...state.cobrancas.values()][0]!;
    // Semântica atual: pending não promove via webhook failed; só espelha raw.
    assert.equal(cob.status, "pending");
    assert.equal(cob.pagarme_status_raw, "failed");
    ok("charge.payment_failed local: INSERT+GET; sem pagamento (espelho raw)");
  }

  // charge.paid local — revalida INSERT=1 GET=1 pagamento
  {
    const { repo, state } = seedRepo();
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: null,
      metodo: "pix",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "x",
      status: "pending",
      pagarme_payment_link_id: null,
      pagarme_payment_link_url: null,
      pagarme_order_id: fixturePixOrderResponse.id,
      pagarme_charge_id: PAGARME_FIXTURE_CHARGE_ID,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });
    let getCalls = 0;
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => {
              if (m === "GET" && u.includes(`/charges/${PAGARME_FIXTURE_CHARGE_ID}`)) {
                getCalls += 1;
                return true;
              }
              return false;
            },
            body: fixturePaidChargeResponse,
          },
        ]) as never,
      ),
    });
    const r = await svc.processWebhook(fixtureWebhookChargePaid);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.data.payment_registered, true);
      assert.equal(r.data.unrelated_ignored, undefined);
    }
    assert.equal(state.webhooks.size, 1);
    assert.equal(getCalls, 1);
    assert.equal(state.pagamentos.size, 1);
    assert.equal([...state.cobrancas.values()][0]!.status, "paid");
    ok("charge.paid local apos prefilter: INSERT=1 GET=1 pagamento");
  }

  // Combinado: Payment Link cartão SEM order_id/charge_id locais + primeiro charge.paid
  // Hint de candidato = data.code (UUID local), como buildPaymentLinkRequestBody.order_code.
  {
    const { repo, state } = seedRepo();
    const reservaAntes = structuredClone(state.reservas.get(RESERVA_OK)!);
    state.cobrancas.set(PAGARME_FIXTURE_COBRANCA_ID, {
      id: PAGARME_FIXTURE_COBRANCA_ID,
      reserva_id: RESERVA_OK,
      external_reservation_id: "HITS-1",
      metodo: "cartao",
      valor_centavos: 170_000,
      moeda: "BRL",
      idempotency_key: "yh-cobranca-pl-preids",
      status: "pending",
      pagarme_payment_link_id: PAGARME_FIXTURE_PAYMENT_LINK_ID,
      pagarme_payment_link_url: PAGARME_FIXTURE_LINK_URL,
      pagarme_order_id: null,
      pagarme_charge_id: null,
      pix_qr_code: null,
      pix_qr_code_url: null,
      expira_em: null,
      pagarme_status_raw: "pending",
      requer_revisao_operacional: false,
      requer_revisao_motivo: null,
      requer_revisao_detectado_em: null,
      criado_por_user_id: OPERATOR,
    });

    let getCalls = 0;
    const svc = new CobrancaPagarmeService({
      repo,
      client: homologClient(
        createMockPagarmeFetch([
          {
            match: (u, m) => {
              if (m === "GET" && u.includes(`/charges/${PAGARME_FIXTURE_CHARGE_ID}`)) {
                getCalls += 1;
                return true;
              }
              return false;
            },
            body: {
              ...fixturePaidChargeResponse,
              payment_method: "credit_card",
            },
          },
        ]) as never,
      ),
    });

    // Fixture homologada: data.code = UUID local (order_code do Payment Link).
    assert.equal(fixtureWebhookChargePaid.data.code, PAGARME_FIXTURE_COBRANCA_ID);
    assert.equal(
      [...state.cobrancas.values()][0]!.pagarme_order_id,
      null,
    );
    assert.equal(
      [...state.cobrancas.values()][0]!.pagarme_charge_id,
      null,
    );

    const first = await svc.processWebhook(fixtureWebhookChargePaid);
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.equal(first.data.unrelated_ignored, undefined);
      assert.equal(first.data.payment_registered, true);
      assert.equal(first.data.cobranca_id, PAGARME_FIXTURE_COBRANCA_ID);
      assert.equal(first.data.duplicate_event, false);
    }
    assert.equal(state.webhooks.size, 1);
    assert.equal(getCalls, 1);

    const cob = state.cobrancas.get(PAGARME_FIXTURE_COBRANCA_ID)!;
    assert.equal(cob.status, "paid");
    assert.equal(cob.pagarme_order_id, PAGARME_FIXTURE_ORDER_ID);
    assert.equal(cob.pagarme_charge_id, PAGARME_FIXTURE_CHARGE_ID);
    assert.equal(state.pagamentos.size, 1);
    const pag = [...state.pagamentos.values()][0]!;
    assert.equal(pag.cobranca_id, PAGARME_FIXTURE_COBRANCA_ID);
    assert.equal(pag.sincronizacao_hits_status, "aguardando_registro_hits");
    assert.equal(pag.valor_centavos_recebido, 170_000);
    assert.deepEqual(state.reservas.get(RESERVA_OK), reservaAntes);
    assert.equal(state.reservas.get(RESERVA_OK)!.pagamento_status, "pendente");
    ok("PL cartao pre-IDs: candidate via data.code; paid+IDs+1 pagamento; HITS pendente");

    const dup = await svc.processWebhook(fixtureWebhookChargePaid);
    assert.equal(dup.ok, true);
    if (dup.ok) {
      assert.equal(dup.data.duplicate_event, true);
      assert.equal(dup.data.payment_registered, false);
    }
    assert.equal(state.webhooks.size, 1);
    assert.equal(getCalls, 1);
    assert.equal(state.pagamentos.size, 1);
    assert.equal(state.cobrancas.get(PAGARME_FIXTURE_COBRANCA_ID)!.status, "paid");
    ok("PL cartao pre-IDs: reprocesso idempotente (1 webhook, 1 pagamento, GET nao repete)");
  }

  console.log(`\n[test-cobranca-pagarme-service] ${passed} assertions OK\n`);
}

main().catch((error) => {
  console.error("[test-cobranca-pagarme-service] FALHOU:", error);
  process.exit(1);
});
