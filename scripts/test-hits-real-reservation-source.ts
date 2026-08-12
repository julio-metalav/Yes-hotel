/**
 * PR1 — HitsReservationSource + resolve mock|real + smoke limits + financeiro.
 * Sem rede. Fixtures + client fake.
 */
import assert from "node:assert/strict";
import {
  createEmptyMemorySyncState,
  InMemoryReservationSyncRepository,
} from "../src/lib/application/yes-hotel/reservation-sync-repository.ts";
import {
  getReservationSyncFlags,
  syncReservationsFromSource,
} from "../src/lib/application/yes-hotel/reservation-sync-service.ts";
import {
  classifyCommissionFromHits,
  isFinanceiramenteLiberadoParaAcesso,
  isMotorDeReservasChannel,
  resolveFinancialStatusVisible,
  shouldCreatePagarmeCharge,
} from "../src/lib/domain/yes-hotel/reservation-financial-classification.ts";
import { HitsMockReservationSource } from "../src/lib/integrations/hits-mock/hits-mock-reservation-source.ts";
import type { HitsConfig } from "../src/lib/integrations/hits/config.ts";
import { HitsReservationSource } from "../src/lib/integrations/hits/hits-reservation-source.ts";
import { normalizeHitsDetailToSynced } from "../src/lib/integrations/hits/normalize-hits-detail-to-synced.ts";
import { resolveHitsReservationSource } from "../src/lib/integrations/hits/resolve-hits-reservation-source.ts";
import type { HitsClient } from "../src/lib/integrations/hits/client.ts";

function ok(label: string) {
  console.log(`  ok — ${label}`);
}

function syntheticHitsConfig(partial: Partial<HitsConfig> = {}): HitsConfig {
  return {
    apiBaseUrl: "https://api.hitspms.net",
    sharedAccessSecret: "test-secret",
    propertyId: "00000000-0000-4000-8000-000000000001",
    integrationEnabled: true,
    checkinEnabled: false,
    requestTimeoutMs: 12_000,
    apiVersion: "1",
    tenantName: "TenantTest",
    propertyCode: "PROP1",
    partnerUserId: "partner-1",
    clientId: "client-1",
    languageCode: "pt-BR",
    scopes: ["WebCheckIn"],
    authContractStatus: "verified",
    checkInBodyContractStatus: "unverified",
    ...partial,
  };
}

function detailFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idReservation: "HITS-1001",
    dateUp: "2026-08-10T12:00:00Z",
    status: "1",
    contactName: "Maria Silva",
    contact1: "maria@example.com",
    contact2: "67999990000",
    integrator: null,
    companyName: null,
    reservationChannelId: null,
    reservationBalanceDue: 150,
    reservationTotalAmount: 500,
    rooms: [
      {
        code: "101",
        checkIn: "2026-08-12",
        checkOut: "2026-08-14",
        pax: 2,
        mealPlanDesc: "Café",
      },
    ],
    guests: [
      {
        idEntity: "G1",
        name: "Maria Silva",
        main: true,
        contactPhone: "67999990000",
        contactMail: "maria@example.com",
      },
    ],
    ...overrides,
  };
}

function assertSyncedOrigin(
  companyName: string | null,
  integrator: string | null,
  balance: number | null,
  expect: {
    classificacao: string;
    status: string;
    originKind?: string;
  },
) {
  const synced = normalizeHitsDetailToSynced(
    detailFixture({
      companyName,
      integrator,
      reservationBalanceDue: balance,
    }),
  );
  assert.equal(synced.classificacaoComissionamento, expect.classificacao);
  const status = resolveFinancialStatusVisible({
    pagamentoStatus: synced.paymentStatus,
    balanceDue: synced.reservationBalanceDue,
    classificacao: synced.classificacaoComissionamento,
  });
  assert.equal(status, expect.status);
  if (expect.originKind) {
    const c = classifyCommissionFromHits({
      channelManager: synced.channelManager,
      salesChannel: synced.salesChannel,
      companyName,
      integrator,
    });
    assert.equal(c.originKind, expect.originKind);
  }
  return synced;
}

async function main() {
  // --- 1–4: resolve source mock|real ---
  {
    const mockFlags = getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "mock",
      HITS_INTEGRATION_ENABLED: "false",
    });
    const r = resolveHitsReservationSource({ flags: mockFlags });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.kind, "mock");
    ok("1. mode mock → mock source");
  }

  {
    const flags = getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "real",
      HITS_INTEGRATION_ENABLED: "false",
    });
    const r = resolveHitsReservationSource({ flags });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "hits_real_blocked");
    ok("2. mode real + integração OFF → bloqueado");
  }

  {
    const flags = getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "real",
      HITS_INTEGRATION_ENABLED: "true",
    });
    const r = resolveHitsReservationSource({
      flags,
      hitsConfig: syntheticHitsConfig({
        sharedAccessSecret: "",
        propertyId: "",
      }),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "hits_real_missing_credentials");
    ok("3. mode real + config ausente → bloqueado");
  }

  {
    const flags = getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "real",
      HITS_INTEGRATION_ENABLED: "true",
    });
    const r = resolveHitsReservationSource({
      flags,
      hitsConfig: syntheticHitsConfig(),
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.kind, "real");
      assert.ok(r.source instanceof HitsReservationSource);
    }
    ok("4. mode real + config válida sintética → real source");
  }

  // --- 5–8: paginação / datas / maxPages / limite ---
  {
    const source = new HitsMockReservationSource({ pageSize: 2, scenario: "baseline" });
    const p0 = await source.listReservations({ pageSize: 2, cursor: null });
    assert.equal(p0.items.length, 2);
    assert.equal(p0.hasMore, true);
    assert.equal(p0.nextCursor, "1");
    const p1 = await source.listReservations({ pageSize: 2, cursor: "1" });
    assert.ok(p1.items.length >= 1);
    ok("5. paginação");
  }

  {
    const source = new HitsMockReservationSource({ pageSize: 50, scenario: "baseline" });
    const all = await source.listReservations({ pageSize: 50 });
    const sample = all.items[0];
    assert.ok(sample);
    const day = sample.checkIn.slice(0, 10);
    const filtered = await source.listReservations({
      pageSize: 50,
      dateFrom: day,
      dateTo: day,
    });
    for (const item of filtered.items) {
      assert.equal(item.checkIn.slice(0, 10), day);
    }
    ok("6. dateFrom/dateTo");
  }

  {
    const flags = getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "mock",
      HITS_RESERVATION_SYNC_BATCH_SIZE: "2",
    });
    const repo = new InMemoryReservationSyncRepository(createEmptyMemorySyncState());
    const result = await syncReservationsFromSource({
      source: new HitsMockReservationSource({ pageSize: 2, scenario: "baseline" }),
      repo,
      flags,
      dryRun: true,
      maxPages: 1,
    });
    assert.equal(result.pages, 1);
    assert.equal(result.stopped_reason, "max_pages");
    ok("7. maxPages");
  }

  {
    const flags = getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "mock",
      HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
    });
    const repo = new InMemoryReservationSyncRepository(createEmptyMemorySyncState());
    const result = await syncReservationsFromSource({
      source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
      repo,
      flags,
      dryRun: true,
      maxReservations: 2,
    });
    assert.equal(result.processed, 2);
    assert.equal(result.stopped_reason, "max_reservations");
    ok("8. limite controlado (max_reservations)");
  }

  {
    assertSyncedOrigin("Booking", "Omnibees", 120, {
      classificacao: "comissionada",
      status: "pendente_comissionado",
      originKind: "ota",
    });
    ok("9. Booking");
  }

  {
    assertSyncedOrigin("Booking Engine", "Omnibees", 120, {
      classificacao: "nao_comissionada",
      status: "pendente",
      originKind: "booking_engine",
    });
    ok("10. Booking Engine");
  }

  {
    assertSyncedOrigin("Expedia", null, 90, {
      classificacao: "comissionada",
      status: "pendente_comissionado",
    });
    ok("11. Expedia");
  }

  {
    assertSyncedOrigin(null, "B2BRESERVAS", 200, {
      classificacao: "comissionada",
      status: "pendente_comissionado",
      originKind: "b2b",
    });
    ok("12. B2B");
  }

  {
    assert.equal(isMotorDeReservasChannel("Motor de Reservas"), true);
    assert.equal(isMotorDeReservasChannel("MOTORADERESERVAS"), true);
    assertSyncedOrigin("Motor de Reservas", null, 75, {
      classificacao: "nao_comissionada",
      status: "pendente",
      originKind: "motor_particular",
    });
    ok("13. Motor de Reservas");
  }

  {
    assertSyncedOrigin(null, null, 60, {
      classificacao: "nao_comissionada",
      status: "pendente",
      originKind: "manual_hits",
    });
    ok("14. manual HITS");
  }

  {
    assertSyncedOrigin("Canal XYZ Desconhecido", "GestorX", 40, {
      classificacao: "nao_comissionada",
      status: "pendente",
      originKind: "unknown",
    });
    ok("15. desconhecido → Pendente (não comissionada)");
  }

  {
    const synced = assertSyncedOrigin("Booking", null, 0, {
      classificacao: "comissionada",
      status: "pago",
    });
    assert.equal(synced.paymentStatus, "pago");
    ok("16. saldo zero → Pago");
  }

  {
    const gate = shouldCreatePagarmeCharge({
      pagamentoStatus: "pendente",
      balanceDue: 100,
      classificacao: "comissionada",
    });
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, "comissionada_bloqueada");
    ok("17. comissionada não gera Pagar.me");
  }

  {
    assert.equal(
      isFinanceiramenteLiberadoParaAcesso({
        pagamentoStatus: "pendente",
        balanceDue: 100,
        classificacao: "desconhecida",
      }),
      false,
    );
    ok("18. desconhecida não recebe liberação financeira");
  }

  {
    const flags = getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "mock",
      HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
    });
    const repo = new InMemoryReservationSyncRepository(createEmptyMemorySyncState());
    const source = new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" });
    const first = await syncReservationsFromSource({
      source,
      repo,
      flags,
      dryRun: false,
    });
    assert.ok(first.created > 0);
    const second = await syncReservationsFromSource({
      source: new HitsMockReservationSource({ pageSize: 10, scenario: "identical" }),
      repo,
      flags,
      dryRun: false,
    });
    assert.ok(second.unchanged >= first.created || second.updated === 0);
    ok("19. idempotência");
  }

  {
    const flags = getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "mock",
    });
    const state = createEmptyMemorySyncState();
    const repo = new InMemoryReservationSyncRepository(state);
    const before = state.operacionalReservas.length;
    const dry = await syncReservationsFromSource({
      source: new HitsMockReservationSource({ pageSize: 3 }),
      repo,
      flags,
      dryRun: true,
    });
    assert.equal(dry.dry_run, true);
    assert.ok(dry.created > 0 || dry.processed > 0);
    assert.equal(state.operacionalReservas.length, before);
    ok("20. dry-run sem escrita");
  }

  {
    const listed: Array<Record<string, unknown>> = [];
    const fakeClient = {
      listWebCheckinReservations: async (params: {
        initialDate?: string;
        finalDate?: string;
        page?: number;
        size?: number;
      }) => {
        listed.push({ ...params });
        return {
          data: [
            {
              idReservation: "R1",
              name: "A",
              checkIn: "2026-08-12",
              checkOut: "2026-08-13",
              status: "1",
              integrator: null,
              reservationChannelId: null,
              mail: null,
              phone: null,
            },
          ],
        };
      },
      getWebCheckinReservation: async (id: string) =>
        detailFixture({
          idReservation: id,
          companyName: "Booking Engine",
          reservationBalanceDue: 10,
        }),
    } as unknown as HitsClient;

    const source = new HitsReservationSource({
      client: fakeClient,
      config: syntheticHitsConfig(),
      maxReservations: 3,
    });
    const page = await source.listReservations({
      dateFrom: "2026-08-12",
      dateTo: "2026-08-12",
      pageSize: 10,
    });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]!.externalReservationId, "R1");
    assert.equal(page.items[0]!.classificacaoComissionamento, "nao_comissionada");
    assert.equal(listed[0]!.initialDate, "2026-08-12");
    assert.equal(listed[0]!.finalDate, "2026-08-12");
    assert.equal(page.hasMore, false);
    ok("real source fake client: dateFrom/dateTo + map");
  }

  console.log("\nPASS test-hits-real-reservation-source\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
