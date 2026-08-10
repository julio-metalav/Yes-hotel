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

  console.log(`\n[test-cobranca-pagarme-service] ${passed} assertions OK\n`);
}

main().catch((error) => {
  console.error("[test-cobranca-pagarme-service] FALHOU:", error);
  process.exit(1);
});
