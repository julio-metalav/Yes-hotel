/**
 * Suite sem rede: preparação oficial da integração HITS.
 * Garante flags off, contrato AccessSecret, policy de check-in e transporte mockado.
 */
import assert from "node:assert/strict";
import {
  HitsClient,
  HitsError,
  HitsApiError,
  createHitsClient,
  createHitsFixtureFetch,
  createHitsTransport,
  evaluateHitsCheckInEligibility,
  getHitsConfig,
  hitsConfigStatus,
  mapStatusToCode,
  sanitizeMessage,
  sanitizeUnknown,
  assertNoSensitiveLeak,
  fixtureAuthorizeApproved,
  fixtureCheckInApproved,
  fixtureProperties,
  fixtureReservationDetails,
  fixtureReservationsList,
  type HitsConfig,
} from "../src/lib/integrations/hits";

async function main(): Promise<void> {
  let passed = 0;
  function ok(name: string): void {
    passed += 1;
    console.log(`OK ${passed}: ${name}`);
  }

  function baseConfig(overrides: Partial<HitsConfig> = {}): HitsConfig {
    return {
      apiBaseUrl: "https://api.hitspms.net",
      sharedAccessSecret: "synthetic-shared-secret-not-real",
      propertyId: "00000000-0000-4000-8000-000000000002",
      integrationEnabled: false,
      checkinEnabled: false,
      requestTimeoutMs: 1000,
      apiVersion: "1",
      tenantName: "synthetic-tenant",
      propertyCode: "2",
      partnerUserId: "0",
      clientId: "synthetic-client",
      languageCode: "pt-BR",
      scopes: ["WebCheckIn"],
      authContractStatus: "verified",
      checkInBodyContractStatus: "unverified",
      ...overrides,
    };
  }

  function enabledConfig(overrides: Partial<HitsConfig> = {}): HitsConfig {
    return baseConfig({
      integrationEnabled: true,
      checkinEnabled: true,
      checkInBodyContractStatus: "verified",
      ...overrides,
    });
  }

  let networkCalls = 0;
  const countingFetch: typeof fetch = async (input, init) => {
    networkCalls += 1;
    return createHitsFixtureFetch("happy")(input, init);
  };

  // 1 flags default false
  {
    const prevEnabled = process.env.HITS_INTEGRATION_ENABLED;
    const prevCheckin = process.env.HITS_CHECKIN_ENABLED;
    const prevSecret = process.env.HITS_SHARED_ACCESS_SECRET;
    const prevProp = process.env.HITS_PROPERTY_ID;
    delete process.env.HITS_INTEGRATION_ENABLED;
    delete process.env.HITS_CHECKIN_ENABLED;
    delete process.env.HITS_SHARED_ACCESS_SECRET;
    delete process.env.HITS_PROPERTY_ID;
    const c = getHitsConfig();
    assert.equal(c.integrationEnabled, false);
    assert.equal(c.checkinEnabled, false);
    assert.equal(c.apiBaseUrl, "https://api.hitspms.net");
    if (prevEnabled === undefined) delete process.env.HITS_INTEGRATION_ENABLED;
    else process.env.HITS_INTEGRATION_ENABLED = prevEnabled;
    if (prevCheckin === undefined) delete process.env.HITS_CHECKIN_ENABLED;
    else process.env.HITS_CHECKIN_ENABLED = prevCheckin;
    if (prevSecret === undefined) delete process.env.HITS_SHARED_ACCESS_SECRET;
    else process.env.HITS_SHARED_ACCESS_SECRET = prevSecret;
    if (prevProp === undefined) delete process.env.HITS_PROPERTY_ID;
    else process.env.HITS_PROPERTY_ID = prevProp;
    ok("flags default false");
  }

  // 2 integração desligada impede fetch
  {
    networkCalls = 0;
    const client = createHitsClient({ config: baseConfig(), fetchImpl: countingFetch });
    await assert.rejects(() => client.authorize(), (e: unknown) => {
      assert.ok(e instanceof HitsError);
      assert.equal(e.code, "integration_disabled");
      return true;
    });
    assert.equal(networkCalls, 0);
    ok("integração desligada impede fetch");
  }

  // 3 check-in desligado impede mutação
  {
    networkCalls = 0;
    const client = createHitsClient({
      config: baseConfig({ integrationEnabled: true, checkinEnabled: false }),
      fetchImpl: countingFetch,
    });
    await assert.rejects(() => client.checkInReservation("900001"), (e: unknown) => {
      assert.ok(e instanceof HitsError);
      assert.equal(e.code, "checkin_disabled");
      return true;
    });
    assert.equal(networkCalls, 0);
    ok("check-in desligado impede mutação");
  }

  // 4 shared secret ausente falha sanitizado
  {
    networkCalls = 0;
    const client = createHitsClient({
      config: enabledConfig({ sharedAccessSecret: "" }),
      fetchImpl: countingFetch,
    });
    await assert.rejects(() => client.authorize(), (e: unknown) => {
      assert.ok(e instanceof HitsError);
      assert.equal(e.code, "missing_secret");
      assert.ok(!String(e.message).toLowerCase().includes("synthetic-shared"));
      return true;
    });
    assert.equal(networkCalls, 0);
    ok("shared secret ausente falha sanitizado");
  }

  // 5 propertyId ausente bloqueia
  {
    networkCalls = 0;
    const client = createHitsClient({
      config: enabledConfig({ propertyId: "" }),
      fetchImpl: countingFetch,
    });
    await assert.rejects(() => client.listProperties(), (e: unknown) => {
      assert.ok(e instanceof HitsError);
      assert.equal(e.code, "missing_property_id");
      return true;
    });
    assert.equal(networkCalls, 0);
    ok("propertyId ausente bloqueia consulta dependente");
  }

  // 6 authorize monta contrato AccessSecret
  {
    const client = createHitsClient({ config: enabledConfig() });
    const body = client.buildAuthorizeRequestBody();
    assert.equal(body.secret, "synthetic-shared-secret-not-real");
    assert.equal(body.propertyId, "00000000-0000-4000-8000-000000000002");
    assert.deepEqual(body.scopes, ["WebCheckIn"]);
    assert.ok(!("accessSecret" in body));
    ok("authorize monta contrato AccessSecret");
  }

  // 7 token não aparece em logs / sanitize
  {
    const leaked = sanitizeUnknown({
      token: fixtureAuthorizeApproved.token,
      nested: { accessToken: "abc123tokenvalue" },
    }) as Record<string, unknown>;
    assert.equal(leaked.token, "[REDACTED]");
    assert.equal((leaked.nested as Record<string, unknown>).accessToken, "[REDACTED]");
    ok("token não aparece em sanitize/logs");
  }

  // 8 secret não aparece em logs
  {
    const secret = "super-secret-value-xyz";
    assert.throws(() => assertNoSensitiveLeak({ note: `x ${secret} y` }, [secret]));
    ok("secret não aparece em logs (assertNoSensitiveLeak)");
  }

  // 9 timeout aborta
  {
    const client = createHitsClient({
      config: enabledConfig({ requestTimeoutMs: 50 }),
      fetchImpl: createHitsFixtureFetch("timeout"),
    });
    await assert.rejects(() => client.healthCheck(), (e: unknown) => {
      assert.ok(e instanceof HitsError);
      assert.equal(e.code, "timeout");
      return true;
    });
    ok("timeout aborta");
  }

  // 10–15 status mapping
  {
    assert.equal(mapStatusToCode(401), "unauthorized");
    assert.equal(mapStatusToCode(403), "forbidden");
    assert.equal(mapStatusToCode(404), "not_found");
    assert.equal(mapStatusToCode(409), "conflict");
    assert.equal(mapStatusToCode(429), "rate_limited");
    assert.equal(mapStatusToCode(500), "server_error");
    ok("401 mapeado");
    ok("403 mapeado");
    ok("404 mapeado");
    ok("409 mapeado");
    ok("429 mapeado");
    ok("5xx mapeado");
  }

  // 16 JSON inválido
  {
    const transport = createHitsTransport(createHitsFixtureFetch("invalid_json"));
    await assert.rejects(
      () =>
        transport.request({
          method: "GET",
          url: "https://api.hitspms.net/api/HealthCheck",
          timeoutMs: 1000,
          maxRetries: 0,
        }),
      (e: unknown) => {
        assert.ok(e instanceof HitsError);
        assert.equal(e.code, "invalid_json");
        return true;
      },
    );
    ok("JSON inválido rejeitado");
  }

  // 17 healthCheck fixture
  {
    const client = createHitsClient({
      config: enabledConfig(),
      fetchImpl: createHitsFixtureFetch("happy"),
    });
    const health = await client.healthCheck();
    assert.equal(health.ok, true);
    ok("healthCheck fixture");
  }

  // 18 listProperties fixture
  {
    const client = createHitsClient({
      config: enabledConfig(),
      fetchImpl: createHitsFixtureFetch("happy"),
    });
    const props = await client.listProperties();
    assert.equal(props.length, fixtureProperties.length);
    assert.equal(props[0]?.name, fixtureProperties[0]?.name);
    ok("listProperties fixture");
  }

  // 19 listWebCheckinReservations fixture
  {
    const client = createHitsClient({
      config: enabledConfig(),
      fetchImpl: createHitsFixtureFetch("happy"),
    });
    const list = await client.listWebCheckinReservations({ type: 0, status: 1 });
    assert.ok(Array.isArray(list));
    assert.equal((list as unknown[]).length, fixtureReservationsList.length);
    ok("listWebCheckinReservations fixture");
  }

  // 20 getWebCheckinReservation fixture
  {
    const client = createHitsClient({
      config: enabledConfig(),
      fetchImpl: createHitsFixtureFetch("happy"),
    });
    const detail = await client.getWebCheckinReservation("900001");
    assert.equal(String(detail.idReservation), String(fixtureReservationDetails.idReservation));
    ok("getWebCheckinReservation fixture");
  }

  // 21 check-in aprovado fixture
  {
    const client = createHitsClient({
      config: enabledConfig({ checkInBodyContractStatus: "verified" }),
      fetchImpl: createHitsFixtureFetch("happy"),
    });
    const result = await client.checkInReservation("900001", {});
    assert.equal(result.folioId, fixtureCheckInApproved.folioId);
    ok("check-in aprovado fixture");
  }

  // 22 check-in duplicado não vira novo sucesso
  {
    const client = createHitsClient({
      config: enabledConfig({ checkInBodyContractStatus: "verified" }),
      fetchImpl: createHitsFixtureFetch("checkin_duplicate"),
    });
    await assert.rejects(() => client.checkInReservation("900001"), (e: unknown) => {
      assert.ok(e instanceof HitsApiError);
      assert.equal(e.status, 409);
      assert.equal(e.code, "conflict");
      return true;
    });
    ok("check-in duplicado não vira novo sucesso");
  }

  // 23–31 policy
  {
    const r23 = evaluateHitsCheckInEligibility({
      integration_enabled: true,
      checkin_enabled: true,
      hits_reservation_id: "900001",
      first_room_access_confirmed: false,
      access_method: "room_passcode",
      already_checked_in: false,
      reservation_cancelled: false,
      reservation_closed: false,
      payment_pending: false,
      fnrh_pending: false,
    });
    assert.equal(r23.allowed, false);
    assert.ok(r23.reasons.includes("first_room_access_not_confirmed"));
    ok("gate bloqueia sem primeiro acesso");

    const r24 = evaluateHitsCheckInEligibility({
      integration_enabled: true,
      checkin_enabled: true,
      hits_reservation_id: "900001",
      first_room_access_confirmed: true,
      access_method: "room_passcode",
      already_checked_in: false,
      reservation_cancelled: false,
      reservation_closed: false,
      payment_pending: false,
      fnrh_pending: false,
    });
    assert.equal(r24.allowed, true);
    ok("gate permite senha válida na porta");

    const r25 = evaluateHitsCheckInEligibility({
      integration_enabled: true,
      checkin_enabled: true,
      hits_reservation_id: "900001",
      first_room_access_confirmed: true,
      access_method: "gate_passcode",
      already_checked_in: false,
      reservation_cancelled: false,
      reservation_closed: false,
      payment_pending: false,
      fnrh_pending: false,
    });
    assert.equal(r25.allowed, false);
    assert.ok(r25.reasons.includes("gate_passcode_not_allowed"));
    ok("portão bloqueia");

    for (const method of ["app", "admin", "card", "key"] as const) {
      const r = evaluateHitsCheckInEligibility({
        integration_enabled: true,
        checkin_enabled: true,
        hits_reservation_id: "900001",
        first_room_access_confirmed: true,
        access_method: method,
        already_checked_in: false,
        reservation_cancelled: false,
        reservation_closed: false,
        payment_pending: false,
        fnrh_pending: false,
      });
      assert.equal(r.allowed, false, method);
      assert.ok(r.reasons.some((x) => x.includes(method)), method);
    }
    ok("app/admin/cartão/chave bloqueiam");

    const r27 = evaluateHitsCheckInEligibility({
      integration_enabled: true,
      checkin_enabled: true,
      hits_reservation_id: "900001",
      first_room_access_confirmed: true,
      access_method: "room_passcode",
      already_checked_in: false,
      reservation_cancelled: false,
      reservation_closed: false,
      payment_pending: true,
      fnrh_pending: false,
    });
    assert.equal(r27.allowed, true);
    ok("pagamento pendente não bloqueia");

    const r28 = evaluateHitsCheckInEligibility({
      integration_enabled: true,
      checkin_enabled: true,
      hits_reservation_id: "900001",
      first_room_access_confirmed: true,
      access_method: "room_passcode",
      already_checked_in: false,
      reservation_cancelled: false,
      reservation_closed: false,
      payment_pending: false,
      fnrh_pending: true,
    });
    assert.equal(r28.allowed, true);
    ok("FNRH pendente não bloqueia");

    const r29 = evaluateHitsCheckInEligibility({
      integration_enabled: true,
      checkin_enabled: true,
      hits_reservation_id: "900001",
      first_room_access_confirmed: true,
      access_method: "room_passcode",
      already_checked_in: false,
      reservation_cancelled: true,
      reservation_closed: false,
      payment_pending: false,
      fnrh_pending: false,
    });
    assert.equal(r29.allowed, false);
    ok("cancelada bloqueia");

    const r30 = evaluateHitsCheckInEligibility({
      integration_enabled: true,
      checkin_enabled: true,
      hits_reservation_id: "900001",
      first_room_access_confirmed: true,
      access_method: "room_passcode",
      already_checked_in: false,
      reservation_cancelled: false,
      reservation_closed: true,
      payment_pending: false,
      fnrh_pending: false,
    });
    assert.equal(r30.allowed, false);
    ok("encerrada bloqueia");

    const r31 = evaluateHitsCheckInEligibility({
      integration_enabled: true,
      checkin_enabled: true,
      hits_reservation_id: "900001",
      first_room_access_confirmed: true,
      access_method: "room_passcode",
      already_checked_in: true,
      reservation_cancelled: false,
      reservation_closed: false,
      payment_pending: false,
      fnrh_pending: false,
    });
    assert.equal(r31.allowed, false);
    ok("já checked-in bloqueia");
  }

  // 32 nenhuma chamada real de rede
  {
    networkCalls = 0;
    const client = createHitsClient({ config: baseConfig(), fetchImpl: countingFetch });
    await assert.rejects(() => client.listWebCheckinReservations());
    assert.equal(networkCalls, 0);
    ok("nenhuma chamada real de rede (desligada)");
  }

  // 33–35 nenhum método de pagamento/hóspede/documento
  {
    const proto = HitsClient.prototype as unknown as Record<string, unknown>;
    assert.equal(typeof proto.includePayment, "undefined");
    assert.equal(typeof proto.addGuest, "undefined");
    assert.equal(typeof proto.updateGuest, "undefined");
    assert.equal(typeof proto.updateIdentificationCard, "undefined");
    assert.equal(typeof proto.includeGuest, "undefined");
    ok("nenhum método de pagamento criado");
    ok("nenhum método de hóspede criado");
    ok("nenhum método de documento criado");
  }

  // extras
  {
    networkCalls = 0;
    const client = createHitsClient({
      config: enabledConfig({ checkInBodyContractStatus: "unverified" }),
      fetchImpl: countingFetch,
    });
    await assert.rejects(() => client.checkInReservation("900001"), (e: unknown) => {
      assert.ok(e instanceof HitsError);
      assert.equal(e.code, "checkin_body_unverified");
      return true;
    });
    assert.equal(networkCalls, 0);
    ok("check-in body unverified bloqueia sem fetch");

    const s = hitsConfigStatus(baseConfig());
    assert.equal(s.integration_enabled, false);
    assert.equal(s.auth_contract, "verified");
    ok("hitsConfigStatus coerente");

    const msg = sanitizeMessage("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb failed");
    assert.ok(!msg.includes("eyJ"));
    ok("sanitizeMessage remove token-like");
  }

  console.log(`\nPASS ${passed} testes HITS prep (sem rede).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
