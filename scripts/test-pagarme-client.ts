/**
 * Testes locais â€” cliente / mapper / config Pagar.me.
 * Sem rede real. Sem secret real.
 */
import assert from "node:assert/strict";
import {
  PAGARME_CHECKOUT_TEST_API_BASE_URL,
  PAGARME_CORE_API_BASE_URL,
  PAGARME_FIXTURE_COBRANCA_ID,
  PAGARME_FIXTURE_SECRET,
  PAGARME_HOMOLOG_API_BASE_URL,
  PAGARME_PRODUCTION_API_BASE_URL,
  PagarmeClient,
  PagarmeError,
  assertNoSensitiveLeak,
  buildCreditCardInstallments,
  classifyPagarmeSecretKey,
  createMockPagarmeFetch,
  evaluatePagarmeBaseUrl,
  evaluatePagarmeCheckoutBaseUrl,
  evaluatePagarmeCoreBaseUrl,
  extractPixFromOrder,
  fixturePixOrderResponse,
  fixturePaymentLinkResponse,
  getPagarmeConfig,
  maxInstallmentsForAmount,
  sanitizeUnknown,
} from "../src/lib/integrations/pagarme";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function homologEnv(extra: Record<string, string> = {}) {
  return {
    PAGARME_ENV: "test",
    PAGARME_INTEGRATION_ENABLED: "true",
    PAGARME_SECRET_KEY: PAGARME_FIXTURE_SECRET,
    PAGARME_CORE_API_BASE_URL: PAGARME_CORE_API_BASE_URL,
    PAGARME_CHECKOUT_API_BASE_URL: PAGARME_CHECKOUT_TEST_API_BASE_URL,
    ...extra,
  };
}

async function main() {
  console.log("\n[test-pagarme-client]");

  // --- Parcelamento (limites obrigatÃ³rios) ---
  assert.deepEqual(
    buildCreditCardInstallments(119_999).map((i) => i.number),
    [1],
  );
  ok("installments 119999 => [1]");

  assert.deepEqual(
    buildCreditCardInstallments(120_000).map((i) => i.number),
    [1, 2],
  );
  assert.equal(buildCreditCardInstallments(120_000)[1]!.total, 120_000);
  ok("installments 120000 => [1,2] total=valor");

  assert.deepEqual(
    buildCreditCardInstallments(179_999).map((i) => i.number),
    [1, 2],
  );
  ok("installments 179999 => [1,2]");

  assert.deepEqual(
    buildCreditCardInstallments(180_000).map((i) => i.number),
    [1, 2, 3],
  );
  assert.equal(buildCreditCardInstallments(180_000)[2]!.total, 180_000);
  ok("installments 180000 => [1,2,3] total=valor");

  // Exemplos de negÃ³cio
  assert.equal(maxInstallmentsForAmount(50_000), 1);
  assert.equal(maxInstallmentsForAmount(60_000), 1);
  assert.equal(maxInstallmentsForAmount(170_000), 2);
  assert.equal(maxInstallmentsForAmount(500_000), 3);
  ok("exemplos de negocio parcelamento");

  // --- Payment Link payload ---
  const client = new PagarmeClient({
    config: getPagarmeConfig(homologEnv()),
    fetchImpl: createMockPagarmeFetch([]) as never,
  });
  const linkBody = client.buildPaymentLinkBody({
    cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
    valorCentavos: 170_000,
    idempotencyKey: "idem-1",
  });
  const ps = linkBody.payment_settings as Record<string, unknown>;
  assert.deepEqual(ps.accepted_payment_methods, ["credit_card"]);
  assert.equal(linkBody.max_paid_sessions, 1);
  assert.equal(linkBody.order_code, PAGARME_FIXTURE_COBRANCA_ID);
  assert.equal(linkBody.type, "order");
  assert.equal("amount" in linkBody, false);
  const methods = ps.accepted_payment_methods as string[];
  assert.equal(methods.includes("pix"), false);
  assert.equal(methods.includes("boleto"), false);
  const cc = ps.credit_card_settings as Record<string, unknown>;
  assert.equal(cc.operation_type, "auth_and_capture");
  const installments = cc.installments as Array<{ number: number; total: number }>;
  assert.deepEqual(installments, [
    { number: 1, total: 170_000 },
    { number: 2, total: 170_000 },
  ]);
  const items = (linkBody.cart_settings as { items: Array<Record<string, unknown>> }).items;
  assert.equal(items[0]!.amount, 170_000);
  assert.equal(items[0]!.default_quantity, 1);
  ok("payment link: credit_card only, max_paid_sessions=1, cart amount, order_code");

  // --- Pix extract from last_transaction ---
  const pix = extractPixFromOrder(fixturePixOrderResponse);
  assert.equal(pix.qrCode, fixturePixOrderResponse.charges[0]!.last_transaction.qr_code);
  assert.equal(pix.qrCodeUrl, fixturePixOrderResponse.charges[0]!.last_transaction.qr_code_url);
  assert.equal(pix.expiresAt, fixturePixOrderResponse.charges[0]!.last_transaction.expires_at);
  assert.equal(pix.orderId, fixturePixOrderResponse.id);
  assert.equal(pix.chargeId, fixturePixOrderResponse.charges[0]!.id);
  ok("pix extract de charge.last_transaction");

  // --- SuperfÃ­cies: Core vs Checkout ---
  const coreOk = evaluatePagarmeCoreBaseUrl(PAGARME_CORE_API_BASE_URL, "test");
  assert.equal(coreOk.allowed, true);
  const coreSdx = evaluatePagarmeCoreBaseUrl(PAGARME_CHECKOUT_TEST_API_BASE_URL, "test");
  assert.equal(coreSdx.allowed, false);
  assert.equal(coreSdx.reason, "wrong_surface_for_env");
  ok("Core: api.pagar.me permitido; sdx bloqueado para orders");

  const checkoutOk = evaluatePagarmeCheckoutBaseUrl(PAGARME_CHECKOUT_TEST_API_BASE_URL, "test");
  assert.equal(checkoutOk.allowed, true);
  const checkoutCore = evaluatePagarmeCheckoutBaseUrl(PAGARME_CORE_API_BASE_URL, "test");
  assert.equal(checkoutCore.allowed, false);
  assert.equal(checkoutCore.reason, "wrong_surface_for_env");
  ok("Checkout TEST: sdx permitido; api.pagar.me bloqueado para paymentlinks");

  // Legado evaluatePagarmeBaseUrl = checkout test only
  const legacyCore = evaluatePagarmeBaseUrl(PAGARME_PRODUCTION_API_BASE_URL);
  assert.equal(legacyCore.allowed, false);
  assert.equal(legacyCore.reason, "production_base_blocked");
  const legacySdx = evaluatePagarmeBaseUrl(PAGARME_HOMOLOG_API_BASE_URL);
  assert.equal(legacySdx.allowed, true);
  ok("legado evaluatePagarmeBaseUrl: sdx ok, api.pagar.me blocked as checkout");

  // --- Fail-closed env Ã— chave (checkpoint sÃ³ TEST) ---
  assert.equal(classifyPagarmeSecretKey(PAGARME_FIXTURE_SECRET), "test");
  assert.equal(classifyPagarmeSecretKey("sk_homolog_generic_not_live_000"), "unknown");
  assert.equal(classifyPagarmeSecretKey("sk_live_synthetic_not_real"), "live");
  assert.equal(classifyPagarmeSecretKey("pk_test_x"), "unknown");

  const cfgOk = getPagarmeConfig(homologEnv());
  assert.equal(cfgOk.transportAllowed, true);
  assert.equal(cfgOk.env, "test");
  assert.equal(cfgOk.coreApiBaseUrl, PAGARME_CORE_API_BASE_URL);
  assert.equal(cfgOk.checkoutApiBaseUrl, PAGARME_CHECKOUT_TEST_API_BASE_URL);
  ok("test + sk_test + Core api + Checkout sdx => permitido");

  const cfgGenericSk = getPagarmeConfig(
    homologEnv({ PAGARME_SECRET_KEY: "sk_homolog_generic_not_live_000" }),
  );
  assert.equal(cfgGenericSk.transportAllowed, false);
  assert.equal(cfgGenericSk.blockReason, "secret_kind_unknown");
  ok("test + sk_<generica> => bloqueia");

  const cfgLiveKey = getPagarmeConfig(
    homologEnv({ PAGARME_SECRET_KEY: "sk_live_synthetic_not_real" }),
  );
  assert.equal(cfgLiveKey.transportAllowed, false);
  assert.equal(cfgLiveKey.blockReason, "live_secret_blocked");
  const blockedLive = new PagarmeClient({
    config: cfgLiveKey,
    fetchImpl: createMockPagarmeFetch([]) as never,
  });
  await assert.rejects(
    () =>
      blockedLive.createPixOrder({
        cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
        valorCentavos: 1000,
        idempotencyKey: "x",
        customer: { name: "A", email: "a@example.invalid", document: "52998224725", phone_number: "11999990000" },
      }),
    (e: unknown) => e instanceof PagarmeError && e.code === "live_secret_blocked",
  );
  ok("test + sk_live => bloqueado");

  const cfgProd = getPagarmeConfig(
    homologEnv({
      PAGARME_ENV: "production",
      PAGARME_CHECKOUT_API_BASE_URL: PAGARME_CORE_API_BASE_URL,
    }),
  );
  assert.equal(cfgProd.transportAllowed, false);
  assert.equal(cfgProd.blockReason, "production_env_unsupported");
  const blockedProd = new PagarmeClient({
    config: cfgProd,
    fetchImpl: createMockPagarmeFetch([]) as never,
  });
  await assert.rejects(
    () =>
      blockedProd.createPaymentLink({
        cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
        valorCentavos: 1000,
        idempotencyKey: "prod-x",
      }),
    (e: unknown) => e instanceof PagarmeError && e.code === "production_env_unsupported",
  );
  ok("production => bloqueado incondicionalmente");

  const cfgNoEnv = getPagarmeConfig({
    PAGARME_INTEGRATION_ENABLED: "true",
    PAGARME_SECRET_KEY: PAGARME_FIXTURE_SECRET,
    PAGARME_CORE_API_BASE_URL: PAGARME_CORE_API_BASE_URL,
    PAGARME_CHECKOUT_API_BASE_URL: PAGARME_CHECKOUT_TEST_API_BASE_URL,
  });
  assert.equal(cfgNoEnv.transportAllowed, false);
  assert.equal(cfgNoEnv.blockReason, "env_missing");
  ok("config sem PAGARME_ENV => bloqueado");

  const cfgBadPrefix = getPagarmeConfig(
    homologEnv({ PAGARME_SECRET_KEY: "not_a_secret_key" }),
  );
  assert.equal(cfgBadPrefix.transportAllowed, false);
  assert.equal(cfgBadPrefix.blockReason, "secret_kind_unknown");
  ok("secret que nao comeca sk_ => bloqueado");

  const cfgLegacy = getPagarmeConfig({
    PAGARME_ENV: "test",
    PAGARME_INTEGRATION_ENABLED: "true",
    PAGARME_SECRET_KEY: PAGARME_FIXTURE_SECRET,
    PAGARME_API_BASE_URL: PAGARME_CHECKOUT_TEST_API_BASE_URL,
  });
  assert.equal(cfgLegacy.transportAllowed, false);
  assert.equal(cfgLegacy.blockReason, "legacy_ambiguous_base_url");
  ok("PAGARME_API_BASE_URL legado sozinho => bloqueado");

  const cfgCheckoutWrong = getPagarmeConfig(
    homologEnv({ PAGARME_CHECKOUT_API_BASE_URL: PAGARME_CORE_API_BASE_URL }),
  );
  assert.equal(cfgCheckoutWrong.transportAllowed, false);
  assert.equal(cfgCheckoutWrong.blockReason, "checkout_base_wrong_surface");
  ok("test + api.pagar.me para paymentlink => bloqueado");

  const cfgCoreWrong = getPagarmeConfig(
    homologEnv({ PAGARME_CORE_API_BASE_URL: PAGARME_CHECKOUT_TEST_API_BASE_URL }),
  );
  assert.equal(cfgCoreWrong.transportAllowed, false);
  assert.equal(cfgCoreWrong.blockReason, "core_base_wrong_surface");
  ok("test + sdx-api para orders => bloqueado");

  // --- Secret nÃ£o vaza em sanitize ---
  const leakedAttempt = sanitizeUnknown({
    authorization: `Basic ${PAGARME_FIXTURE_SECRET}`,
    qr_code: fixturePixOrderResponse.charges[0]!.last_transaction.qr_code,
    url: fixturePaymentLinkResponse.url,
  });
  const text = JSON.stringify(leakedAttempt);
  assert.equal(text.includes(PAGARME_FIXTURE_SECRET), false);
  assert.equal(text.includes("000201"), false);
  assertNoSensitiveLeak({ ok: true, event: "test" }, [PAGARME_FIXTURE_SECRET]);
  ok("secret/qr/link nao aparecem em sanitize");

  // --- createPixOrder (Core) + createPaymentLink (Checkout) com mock ---
  let sawCoreOrders = false;
  let sawSdxLinks = false;
  let sawWrongRouting = false;
  const mockFetch = createMockPagarmeFetch([
    {
      match: (url, method) => {
        if (method === "POST" && url.includes("/orders")) {
          if (url.includes("sdx-api")) sawWrongRouting = true;
          if (url.includes("api.pagar.me/core/v5") && !url.includes("sdx-api")) {
            sawCoreOrders = true;
          }
          return true;
        }
        return false;
      },
      body: fixturePixOrderResponse,
    },
    {
      match: (url, method) => {
        if (method === "POST" && url.includes("/paymentlinks")) {
          if (url.includes("api.pagar.me/core/v5") && !url.includes("sdx-api")) {
            sawWrongRouting = true;
          }
          if (url.includes("sdx-api.pagar.me")) sawSdxLinks = true;
          return true;
        }
        return false;
      },
      body: fixturePaymentLinkResponse,
    },
  ]);
  const live = new PagarmeClient({
    config: getPagarmeConfig(homologEnv()),
    fetchImpl: mockFetch as never,
  });
  const createdPix = await live.createPixOrder({
    cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
    valorCentavos: 170_000,
    idempotencyKey: "idem-pix",
    customer: {
      name: "Hospede Sintetico",
      email: "sintetico@example.invalid",
      document: "52998224725",
      phone_number: "11999990000",
    },
  });
  assert.ok(createdPix.extract.qrCode);
  const createdLink = await live.createPaymentLink({
    cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
    valorCentavos: 170_000,
    idempotencyKey: "idem-link",
  });
  assert.equal(createdLink.extract.paymentLinkId, fixturePaymentLinkResponse.id);
  assert.equal(sawCoreOrders, true);
  assert.equal(sawSdxLinks, true);
  assert.equal(sawWrongRouting, false);
  ok("orders via Core api.pagar.me; paymentlinks via sdx; sem misturar");

  // --- 429 / 5xx / timeout = ambiguous ---
  const ambiguousClient = new PagarmeClient({
    config: getPagarmeConfig(homologEnv()),
    fetchImpl: createMockPagarmeFetch([
      { match: (u, m) => m === "POST" && u.includes("/orders"), status: 429, body: { message: "rate" } },
    ]) as never,
  });
  await assert.rejects(
    () =>
      ambiguousClient.createPixOrder({
        cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
        valorCentavos: 1000,
        idempotencyKey: "a",
        customer: {
          name: "A",
          email: "a@example.invalid",
          document: "52998224725",
          phone_number: "11999990000",
        },
      }),
    (e: unknown) => e instanceof PagarmeError && e.ambiguous === true && e.code === "ambiguous_response",
  );
  ok("429 e ambiguo");

  const s5 = new PagarmeClient({
    config: getPagarmeConfig(homologEnv()),
    fetchImpl: createMockPagarmeFetch([
      { match: (u, m) => m === "POST" && u.includes("/orders"), status: 503, body: { message: "down" } },
    ]) as never,
  });
  await assert.rejects(
    () =>
      s5.createPixOrder({
        cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
        valorCentavos: 1000,
        idempotencyKey: "b",
        customer: { name: "A", email: "a@example.invalid", document: "52998224725", phone_number: "11999990000" },
      }),
    (e: unknown) => e instanceof PagarmeError && e.ambiguous === true,
  );
  ok("5xx e ambiguo");

  const timeoutClient = new PagarmeClient({
    config: getPagarmeConfig(homologEnv()),
    fetchImpl: createMockPagarmeFetch([
      {
        match: (u, m) => m === "POST" && u.includes("/orders"),
        throwError: Object.assign(new Error("aborted"), { name: "AbortError" }),
      },
    ]) as never,
  });
  await assert.rejects(
    () =>
      timeoutClient.createPixOrder({
        cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
        valorCentavos: 1000,
        idempotencyKey: "c",
        customer: { name: "A", email: "a@example.invalid", document: "52998224725", phone_number: "11999990000" },
      }),
    (e: unknown) => e instanceof PagarmeError && e.ambiguous === true && e.code === "timeout",
  );
  ok("timeout e ambiguo");

  // 400 definitivo
  const def = new PagarmeClient({
    config: getPagarmeConfig(homologEnv()),
    fetchImpl: createMockPagarmeFetch([
      { match: (u, m) => m === "POST" && u.includes("/orders"), status: 400, body: { message: "bad" } },
    ]) as never,
  });
  await assert.rejects(
    () =>
      def.createPixOrder({
        cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
        valorCentavos: 1000,
        idempotencyKey: "d",
        customer: { name: "A", email: "a@example.invalid", document: "52998224725", phone_number: "11999990000" },
      }),
    (e: unknown) =>
      e instanceof PagarmeError && e.ambiguous === false && e.code === "bad_request",
  );
  ok("400 e definitivo");

  // 409 Ã© ambÃ­guo (nÃ£o definitivo)
  const c409 = new PagarmeClient({
    config: getPagarmeConfig(homologEnv()),
    fetchImpl: createMockPagarmeFetch([
      { match: (u, m) => m === "POST" && u.includes("/orders"), status: 409, body: { message: "conflict" } },
    ]) as never,
  });
  await assert.rejects(
    () =>
      c409.createPixOrder({
        cobrancaId: PAGARME_FIXTURE_COBRANCA_ID,
        valorCentavos: 1000,
        idempotencyKey: "e",
        customer: { name: "A", email: "a@example.invalid", document: "52998224725", phone_number: "11999990000" },
      }),
    (e: unknown) =>
      e instanceof PagarmeError && e.ambiguous === true && e.httpStatus === 409,
  );
  ok("409 e ambiguo");

  console.log(`\n[test-pagarme-client] ${passed} assertions OK\n`);
}

main().catch((error) => {
  console.error("[test-pagarme-client] FALHOU:", error);
  process.exit(1);
});

