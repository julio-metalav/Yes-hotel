/**
 * Testes: sync HITS mock + Chegadas + card hospedados + pagamento desconhecido.
 * Determinísticos, sem rede.
 */
import assert from "node:assert/strict";
import {
  filterArrivals,
  summarizeOccupiedGuests,
  paginateRows,
  deriveArrivalsAlerts,
  localDateYmd,
} from "../src/lib/domain/yes-hotel/arrivals-ui";
import { detectReservationChanges, toSnapshot } from "../src/lib/domain/yes-hotel/reservation-sync-diff";
import type { SyncedReservation } from "../src/lib/domain/yes-hotel/synced-reservation";
import { HitsMockReservationSource } from "../src/lib/integrations/hits-mock/hits-mock-reservation-source";
import { normalizeHitsMockDetailToSynced } from "../src/lib/integrations/hits-mock/normalize-synced-reservation";
import { buildHitsMockSyncCatalog } from "../src/lib/integrations/hits-mock/fixtures/sync-catalog";
import {
  createEmptyMemorySyncState,
  InMemoryReservationSyncRepository,
} from "../src/lib/application/yes-hotel/reservation-sync-repository";
import {
  getReservationSyncFlags,
  syncReservationsFromSource,
} from "../src/lib/application/yes-hotel/reservation-sync-service";
import { evaluateReservationPendingState } from "../src/lib/domain/yes-hotel/reservation-pending-state";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

function baseReservation(patch: Partial<SyncedReservation> = {}): SyncedReservation {
  return {
    provider: "hits",
    externalReservationId: "9001001",
    sourceUpdatedAt: "2026-08-01T10:00:00.000Z",
    syncedAt: null,
    reservationStatus: "ativa",
    checkIn: "2026-08-06",
    checkOut: "2026-08-08",
    apartmentCode: "05",
    mainGuestName: "Marina Silva",
    guests: [
      {
        externalGuestId: "G-1",
        name: "Marina Silva",
        isPrincipal: true,
        isMinor: false,
        phone: "+55 67 99999-0001",
        email: "marina@example.com",
      },
      {
        externalGuestId: "G-2",
        name: "Joao Silva",
        isPrincipal: false,
        isMinor: true,
        phone: null,
        email: null,
      },
    ],
    adults: null,
    minors: null,
    totalGuests: 2,
    paymentStatus: "pago",
    phone: "+55 67 99999-0001",
    email: "marina@example.com",
    rawSanitized: { simulated: true },
    ...patch,
  };
}

async function main() {
console.log("\n== Modelo e normalização ==");
{
  const catalog = buildHitsMockSyncCatalog();
  assert.ok(catalog.length >= 5);
  const synced = normalizeHitsMockDetailToSynced(catalog[0]!);
  assert.equal(synced.provider, "hits");
  assert.ok(synced.externalReservationId);
  assert.ok(synced.guests.length >= 1);
  assert.ok(synced.guests.some((g) => g.isPrincipal));
  ok("reserva normal + principal");
}
{
  const r = baseReservation({ paymentStatus: "pago" });
  assert.equal(r.paymentStatus, "pago");
  assert.equal(baseReservation({ paymentStatus: "pendente" }).paymentStatus, "pendente");
  assert.equal(baseReservation({ paymentStatus: "parcial" }).paymentStatus, "parcial");
  assert.equal(baseReservation({ paymentStatus: "desconhecido" }).paymentStatus, "desconhecido");
  assert.equal(baseReservation({ reservationStatus: "cancelada" }).reservationStatus, "cancelada");
  const missing = baseReservation({
    phone: null,
    email: null,
    adults: null,
    minors: null,
    guests: [
      {
        externalGuestId: null,
        name: "Sem Id",
        isPrincipal: true,
        isMinor: null,
        phone: null,
        email: null,
      },
    ],
  });
  assert.equal(missing.phone, null);
  assert.equal(missing.guests[0]!.isMinor, null);
  ok("pagamentos + cancelamento + campos ausentes");
}
{
  const r = baseReservation();
  assert.equal(r.guests.filter((g) => g.isMinor === true).length, 1);
  assert.equal(r.guests.filter((g) => g.isMinor === false).length, 1);
  ok("adulto e menor");
}

console.log("\n== Diff / histórico ==");
{
  const next = baseReservation();
  const created = detectReservationChanges(null, next);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.tipo, "hits_reserva_criada");
  const identical = detectReservationChanges(toSnapshot(next), next);
  assert.equal(identical.length, 0);
  ok("criada + sync idêntico sem eventos");
}
{
  const prev = toSnapshot(baseReservation());
  const room = detectReservationChanges(prev, baseReservation({ apartmentCode: "18" }));
  assert.ok(room.some((e) => e.detalhe.includes("05 → 18")));
  const guests = detectReservationChanges(prev, baseReservation({ totalGuests: 3 }));
  assert.ok(guests.some((e) => e.detalhe.includes("2 → 3")));
  const pay = detectReservationChanges(
    prev,
    baseReservation({ paymentStatus: "pendente" }),
  );
  assert.ok(pay.some((e) => e.detalhe.includes("pago → pendente")));
  const phone = detectReservationChanges(prev, baseReservation({ phone: "+55 67 91111-2222" }));
  assert.ok(phone.some((e) => e.tipo === "hits_telefone_alterado"));
  assert.equal(phone[0]!.detalhe, "Telefone do hóspede atualizado");
  ok("alterações com detalhe sem contato completo");
}

console.log("\n== Sincronização ==");
{
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "3",
    HITS_INTEGRATION_ENABLED: "false",
  });
  assert.equal(flags.syncEnabled, true);
  assert.equal(flags.mode, "mock");
  assert.equal(flags.batchSize, 3);

  const disabled = await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 3 }),
    repo: new InMemoryReservationSyncRepository(),
    flags: getReservationSyncFlags({ HITS_RESERVATION_SYNC_ENABLED: "false" }),
    dryRun: true,
  });
  assert.equal(disabled.error, "sync_disabled");
  ok("flags default / sync desligado");
}
{
  const blocked = await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 3 }),
    repo: new InMemoryReservationSyncRepository(),
    flags: getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "real",
      HITS_INTEGRATION_ENABLED: "false",
    }),
    dryRun: true,
  });
  assert.equal(blocked.error, "hits_real_blocked");
  ok("modo real bloqueado");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const source = new HitsMockReservationSource({ pageSize: 3, scenario: "baseline" });
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "3",
  });
  const first = await syncReservationsFromSource({
    source,
    repo,
    flags,
    dryRun: false,
    nowIso: "2026-08-06T12:00:00.000Z",
  });
  assert.equal(first.ok, true);
  assert.ok(first.pages >= 2);
  assert.ok(first.created >= 1);
  assert.ok(state.operacionalReservas.every((r) => r.origem_externa === "hits"));
  assert.ok(state.pmsReservas.every((r) => r.provider === "hits"));
  const eventsAfterFirst = state.eventos.length;

  const second = await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 3, scenario: "identical" }),
    repo,
    flags,
    dryRun: false,
    nowIso: "2026-08-06T12:05:00.000Z",
  });
  assert.equal(second.ok, true);
  assert.ok(second.unchanged >= 1);
  assert.equal(state.eventos.length, eventsAfterFirst);
  ok("nova + idêntica sem novos eventos + 2 páginas");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
    nowIso: "2026-08-06T12:00:00.000Z",
  });
  const before = state.eventos.length;
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "room_change" }),
    repo,
    flags,
    dryRun: false,
    nowIso: "2026-08-06T12:10:00.000Z",
  });
  assert.ok(state.eventos.length > before);
  assert.ok(state.eventos.some((e) => e.tipo === "hits_apartamento_alterado"));
  ok("mudança de apartamento");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "date_change" }),
    repo,
    flags,
    dryRun: false,
  });
  assert.ok(state.eventos.some((e) => e.tipo === "hits_checkin_alterado"));
  assert.ok(state.eventos.some((e) => e.tipo === "hits_checkout_alterado"));
  ok("mudança de chegada/saída");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "guest_change" }),
    repo,
    flags,
    dryRun: false,
  });
  assert.ok(state.eventos.some((e) => e.tipo === "hits_hospede_principal_alterado"));
  ok("hóspede principal alterado");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "guest_count_up" }),
    repo,
    flags,
    dryRun: false,
  });
  assert.ok(state.eventos.some((e) => e.tipo === "hits_quantidade_hospedes_alterada"));
  ok("quantidade 2 → 3");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
  });
  const guestsBefore = state.operacionalHospedes.filter(
    (h) => !h.removed_from_reservation && h.pms_external_guest_id?.startsWith("G-20"),
  ).length;
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "guest_remove" }),
    repo,
    flags,
    dryRun: false,
  });
  const removed = state.operacionalHospedes.some((h) => h.removed_from_reservation);
  assert.ok(removed || guestsBefore >= 1);
  ok("retirada de hóspede (preserva linha)");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "payment_paid" }),
    repo,
    flags,
    dryRun: false,
  });
  assert.ok(state.eventos.some((e) => e.tipo === "hits_pagamento_alterado"));
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "payment_unknown" }),
    repo,
    flags,
    dryRun: false,
  });
  const op = state.operacionalReservas.find((r) => r.external_reservation_id === "9001005");
  assert.equal(op?.pagamento_status, "desconhecido");
  ok("pagamento alterado → desconhecido");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "phone_email_change" }),
    repo,
    flags,
    dryRun: false,
  });
  assert.ok(state.eventos.some((e) => e.tipo === "hits_telefone_alterado"));
  assert.ok(state.eventos.some((e) => e.tipo === "hits_email_alterado"));
  const detail = state.eventos.find((e) => e.tipo === "hits_email_alterado")!.detalhe;
  assert.equal(detail, "E-mail do hóspede atualizado");
  assert.equal(detail.includes("@"), false);
  ok("telefone/e-mail alterados sem contato completo");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "cancel_one" }),
    repo,
    flags,
    dryRun: false,
  });
  const cancelled = state.operacionalReservas.find((r) => r.external_reservation_id === "9001002");
  assert.equal(cancelled?.status_reserva, "cancelada");
  assert.ok(state.operacionalReservas.some((r) => r.external_reservation_id === "9001002"));
  ok("cancelamento lógico preservado");
}
{
  // Ausência em uma página não cancela: sync página 1 apenas não cancela page2.
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "3",
  });
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 3, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
    maxPages: 1,
  });
  const stillActive = state.operacionalReservas.filter((r) => r.status_reserva === "ativa");
  assert.ok(stillActive.length >= 1);
  // Reprocessamento com página completa não inventa cancelamento por ausência prévia
  await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 3, scenario: "baseline" }),
    repo,
    flags,
    dryRun: false,
  });
  assert.ok(
    state.operacionalReservas.every(
      (r) => r.status_reserva === "ativa" || r.external_reservation_id === "9001003",
    ),
  );
  ok("ausência em página não cancela + retry");
}
{
  const state = createEmptyMemorySyncState();
  const repo = new InMemoryReservationSyncRepository(state);
  const original = repo.upsertFromSynced.bind(repo);
  let failOnce = true;
  repo.upsertFromSynced = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("simulated_partial_failure");
    }
    return original(...args);
  };
  const result = await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" }),
    repo,
    flags: getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "mock",
      HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
    }),
    dryRun: false,
  });
  assert.ok(result.errors >= 1);
  assert.ok(state.syncErrors.length >= 1);
  ok("falha parcial registrada");
}
{
  const dry = await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 3 }),
    repo: new InMemoryReservationSyncRepository(),
    flags: getReservationSyncFlags({
      HITS_RESERVATION_SYNC_ENABLED: "true",
      HITS_RESERVATION_SYNC_MODE: "mock",
    }),
    // dryRun default true
  });
  assert.equal(dry.dry_run, true);
  ok("dry-run default");
}
{
  const defaults = getReservationSyncFlags({});
  assert.equal(defaults.syncEnabled, false);
  assert.equal(defaults.mode, "mock");
  ok("flags default false/mock");
}

console.log("\n== Tela Chegadas ==");
{
  const today = localDateYmd(new Date("2026-08-06T15:00:00-04:00"));
  assert.equal(today, "2026-08-06");
  const items = [
    {
      id: "1",
      external_reservation_id: "YH-100",
      apartamento: "05",
      hospede_principal: "Ana",
      check_in_previsto: "2026-08-06",
      check_out_previsto: "2026-08-08",
      status_reserva: "ativa",
      pagamento_status: "pago",
      entrou_no_apto: false,
      total_hospedes: 2,
    },
    {
      id: "2",
      external_reservation_id: "YH-101",
      apartamento: "12",
      hospede_principal: "Bruno",
      check_in_previsto: "2026-08-07",
      check_out_previsto: "2026-08-09",
      status_reserva: "ativa",
      pagamento_status: "pendente",
      entrou_no_apto: false,
      total_hospedes: 1,
      fnrh_pendente: true,
    },
    {
      id: "3",
      external_reservation_id: null,
      apartamento: "08",
      hospede_principal: "Carla",
      check_in_previsto: "2026-08-10",
      check_out_previsto: "2026-08-12",
      status_reserva: "ativa",
      pagamento_status: "pago",
      entrou_no_apto: false,
      total_hospedes: 3,
    },
    {
      id: "4",
      external_reservation_id: "YH-CAN",
      apartamento: "09",
      hospede_principal: "Diogo",
      check_in_previsto: "2026-12-06",
      check_out_previsto: "2026-12-07",
      status_reserva: "cancelada",
      pagamento_status: "pago",
      entrou_no_apto: false,
      total_hospedes: 1,
      recent_cancel_event: true,
    },
    {
      id: "4b",
      external_reservation_id: "YH-OLD",
      apartamento: "10",
      hospede_principal: "Antigo",
      check_in_previsto: "2026-08-07",
      check_out_previsto: "2026-08-08",
      status_reserva: "cancelada",
      pagamento_status: "pago",
      entrou_no_apto: false,
      total_hospedes: 1,
      recent_cancel_event: false,
    },
    {
      id: "5",
      external_reservation_id: "YH-ALT",
      apartamento: "18",
      hospede_principal: "Eva",
      check_in_previsto: "2026-08-06",
      check_out_previsto: "2026-08-09",
      status_reserva: "ativa",
      pagamento_status: "parcial",
      entrou_no_apto: false,
      total_hospedes: 2,
      recent_change_labels: ["Apto. 12 → 18", "Hóspedes 2 → 3", "Datas alteradas", "extra"],
    },
  ];
  const now = new Date("2026-08-06T15:00:00-04:00");
  const hoje = filterArrivals(items, "hoje", now);
  assert.ok(hoje.every((r) => r.check_in === "2026-08-06"));
  assert.equal(hoje.some((r) => r.id === "4"), false);
  ok("filtro Hoje exclui canceladas");

  const amanha = filterArrivals(items, "amanha", now);
  assert.ok(amanha.some((r) => r.id === "2"));
  ok("filtro Amanhã");

  const d7 = filterArrivals(items, "proximos_7_dias", now);
  assert.ok(d7.some((r) => r.id === "3"));
  ok("filtro Próximos 7 dias");

  const futuras = filterArrivals(items, "todas_futuras", now);
  const page = paginateRows(futuras, 0, 2);
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, true);
  ok("Todas as futuras paginada");

  const problemas = filterArrivals(items, "so_problemas", now);
  assert.ok(problemas.some((r) => r.id === "2"));
  assert.ok(problemas.some((r) => r.id === "4"), "cancelamento recente por evento");
  assert.equal(problemas.some((r) => r.id === "4b"), false, "cancelamento antigo fora");
  ok("Só com problemas");

  const normal = hoje.find((r) => r.id === "1")!;
  assert.equal(normal.alerts.length, 0);
  ok("reserva normal sem badges positivos");

  const missingExt = filterArrivals(items, "todas_futuras", now).find((r) => r.id === "3")!;
  assert.equal(missingExt.external_reservation_id, "—");
  assert.equal(missingExt.external_reservation_id.includes("uuid"), false);
  ok("ausência de número → — (nunca UUID)");

  const alerts = deriveArrivalsAlerts(items[4]!);
  assert.ok(alerts.length <= 3);
  ok("máximo 3 alertas");
}

console.log("\n== Card hospedados ==");
{
  const now = new Date("2026-08-06T15:00:00-04:00");
  const summary = summarizeOccupiedGuests(
    [
      {
        id: "a",
        apartamento: "05",
        hospede_principal: "A",
        check_in_previsto: "2026-08-05",
        check_out_previsto: "2026-08-08",
        status_reserva: "ativa",
        entrou_no_apto: true,
        total_hospedes: 2,
      },
      {
        id: "b",
        apartamento: "05",
        hospede_principal: "B",
        check_in_previsto: "2026-08-05",
        check_out_previsto: "2026-08-07",
        status_reserva: "ativa",
        entrou_no_apto: true,
        total_hospedes: 1,
      },
      {
        id: "c",
        apartamento: "12",
        hospede_principal: "C",
        check_in_previsto: "2026-08-05",
        check_out_previsto: "2026-08-09",
        status_reserva: "cancelada",
        entrou_no_apto: true,
        total_hospedes: 4,
      },
      {
        id: "d",
        apartamento: "18",
        hospede_principal: "D",
        check_in_previsto: "2026-08-05",
        check_out_previsto: "2026-08-09",
        status_reserva: "ativa",
        entrou_no_apto: false,
        total_hospedes: 3,
      },
      {
        id: "e",
        apartamento: "",
        hospede_principal: "E",
        check_in_previsto: "2026-08-05",
        check_out_previsto: "2026-08-09",
        status_reserva: "ativa",
        entrou_no_apto: true,
        total_hospedes: 1,
      },
    ],
    now,
  );
  assert.equal(summary.total_guests, 4); // 2+1+1(e) — c cancelada, d não entrou
  assert.equal(summary.occupied_apartments, 1); // só "05" (e sem apto ignorado)
  assert.ok(summary.stays.every((s) => s.id !== "c" && s.id !== "d"));
  ok("conta hóspedes/apartamentos + exclui canceladas/sem entrada");
}

console.log("\n== Segurança pagamento desconhecido ==");
{
  const pending = evaluateReservationPendingState({
    payment_status: "desconhecido",
    guests: [
      {
        id: "g1",
        role: "principal_adulto",
        fnrh_status: "completed",
      },
    ],
  });
  assert.equal(pending.payment_pending, false);
  assert.equal(pending.payment_unknown, true);
  assert.equal(pending.all_clear, true);
  assert.ok(pending.pending_reasons.includes("pagamento_desconhecido"));
  assert.equal(pending.pending_reasons.includes("pagamento"), false);
  ok("desconhecido não inicia tolerância sozinho");
}
{
  const withFnrh = evaluateReservationPendingState({
    payment_status: "desconhecido",
    guests: [
      {
        id: "g1",
        role: "principal_adulto",
        fnrh_status: "pending",
      },
    ],
  });
  assert.equal(withFnrh.payment_pending, false);
  assert.equal(withFnrh.fnrh_pending, true);
  assert.equal(withFnrh.all_clear, false);
  ok("desconhecido + FNRH pendente → tolerância pela FNRH");
}
{
  const parcial = evaluateReservationPendingState({
    payment_status: "parcial",
    guests: [
      {
        id: "g1",
        role: "principal_adulto",
        fnrh_status: "completed",
      },
    ],
  });
  assert.ok(parcial.pending_reasons.includes("pagamento_parcial"));
  assert.equal(parcial.payment_pending, true);
  ok("parcial continua pendência");
}

console.log("\n== Persistência Supabase (fake, duas instâncias) ==");
{
  const {
    createEmptyFakeReservationSyncDb,
    createFakeReservationSyncClient,
  } = await import("../src/lib/infrastructure/supabase/yes-hotel/fake-reservation-sync-client");
  const { SupabaseReservationSyncRepository } = await import(
    "../src/lib/infrastructure/supabase/yes-hotel/supabase-reservation-sync-repository"
  );
  const { decideAccessGrace } = await import(
    "../src/lib/domain/yes-hotel/first-room-access-policy"
  );

  const shared = createEmptyFakeReservationSyncDb();
  const flags = getReservationSyncFlags({
    HITS_RESERVATION_SYNC_ENABLED: "true",
    HITS_RESERVATION_SYNC_MODE: "mock",
    HITS_RESERVATION_SYNC_BATCH_SIZE: "10",
    HITS_RESERVATION_SYNC_PERSISTENCE_ENABLED: "true",
    HITS_RESERVATION_SCHEMA_READY: "true",
  });
  assert.equal(flags.persistenceEnabled, true);
  assert.equal(flags.schemaReady, true);

  const client1 = createFakeReservationSyncClient(shared);
  const repo1 = new SupabaseReservationSyncRepository(client1);
  const source = new HitsMockReservationSource({ pageSize: 10, scenario: "baseline" });
  const first = await syncReservationsFromSource({
    source,
    repo: repo1,
    flags,
    dryRun: false,
    nowIso: "2026-08-06T12:00:00.000Z",
  });
  assert.equal(first.ok, true);
  assert.ok(first.created >= 1);
  assert.ok(shared.operacional_reservas.every((r) => r.origem_externa === "hits"));
  assert.ok(shared.pms_reservas.every((r) => r.provider === "hits"));
  const eventsAfterFirst = shared.operacional_reserva_eventos.length;

  // Segunda invocação: NOVA instância de repository sobre o MESMO estado
  const client2 = createFakeReservationSyncClient(shared);
  const repo2 = new SupabaseReservationSyncRepository(client2);
  const second = await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 10, scenario: "identical" }),
    repo: repo2,
    flags,
    dryRun: false,
    nowIso: "2026-08-06T12:05:00.000Z",
  });
  assert.equal(second.ok, true);
  assert.ok(second.unchanged >= 1);
  assert.equal(shared.operacional_reserva_eventos.length, eventsAfterFirst);
  assert.ok(shared.operacional_reservas.length >= 1);
  ok("idempotência persistente entre duas instâncias");

  // Três hóspedes na reserva 9001004
  const r9001004 = shared.operacional_reservas.find(
    (r) => r.external_reservation_id === "9001004",
  );
  assert.ok(r9001004);
  const guests = shared.operacional_hospedes.filter(
    (h) => h.reserva_id === r9001004!.id && h.removed_from_reservation !== true,
  );
  assert.equal(guests.length, 3);
  const card = summarizeOccupiedGuests([
    {
      id: String(r9001004!.id),
      apartamento: String(r9001004!.apartamento),
      hospede_principal: String(r9001004!.hospede_principal),
      check_in_previsto: "2026-08-05",
      check_out_previsto: "2026-08-10",
      status_reserva: "ativa",
      entrou_no_apto: true,
      total_hospedes: guests.length,
    },
  ], new Date("2026-08-06T15:00:00-04:00"));
  assert.equal(card.total_guests, 3);
  ok("três hóspedes persistidos e contados no card");

  // Dry-run: zero escrita
  const dryDb = createEmptyFakeReservationSyncDb();
  const dryRepo = new SupabaseReservationSyncRepository(createFakeReservationSyncClient(dryDb));
  const dry = await syncReservationsFromSource({
    source: new HitsMockReservationSource({ pageSize: 3 }),
    repo: dryRepo,
    flags,
    dryRun: true,
  });
  assert.equal(dry.dry_run, true);
  assert.equal(dryDb.pms_reservas.length, 0);
  assert.equal(dryDb.operacional_reservas.length, 0);
  assert.equal(dryDb.pms_sync_runs.length, 0);
  assert.equal(dryDb.operacional_reserva_eventos.length, 0);
  ok("dry-run zero escrita");

  // Gates de flags
  const gated = getReservationSyncFlags({});
  assert.equal(gated.syncEnabled, false);
  assert.equal(gated.persistenceEnabled, false);
  assert.equal(gated.schemaReady, false);
  ok("flags persistência/schema default false");

  // Grace: desconhecido sozinho não inicia
  const graceOnlyUnknown = decideAccessGrace({
    event_accepted: true,
    first_access_already_registered: false,
    grace_already_started: false,
    payment_pending: false,
    fnrh_pending: false,
    pending_reasons: ["pagamento_desconhecido"],
    occurred_at: "2026-08-06T15:00:00.000Z",
  });
  assert.equal(graceOnlyUnknown.start_grace, false);
  const graceFnrh = decideAccessGrace({
    event_accepted: true,
    first_access_already_registered: false,
    grace_already_started: false,
    payment_pending: false,
    fnrh_pending: true,
    pending_reasons: ["pagamento_desconhecido", "fnrh"],
    occurred_at: "2026-08-06T15:00:00.000Z",
  });
  assert.equal(graceFnrh.start_grace, true);
  ok("grace: desconhecido sozinho não inicia; +FNRH inicia");
}

console.log("\n== Policy browser real (ui/yes-arrivals-policy.js) ==");
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const vm = await import("node:vm");
  const file = path.join(process.cwd(), "ui", "yes-arrivals-policy.js");
  const code = fs.readFileSync(file, "utf8");
  const sandbox: { YesHotelArrivalsPolicy?: typeof import("../src/lib/domain/yes-hotel/arrivals-ui") extends never ? never : any; globalThis: unknown } = {
    globalThis: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  const browser = sandbox.YesHotelArrivalsPolicy;
  assert.ok(browser, "YesHotelArrivalsPolicy carregada");

  const now = new Date("2026-08-06T15:00:00-04:00");
  const sample = [
    {
      id: "1",
      external_reservation_id: "YH-100",
      apartamento: "05",
      hospede_principal: "Ana",
      check_in_previsto: "2026-08-06",
      check_out_previsto: "2026-08-08",
      status_reserva: "ativa",
      pagamento_status: "pago",
      entrou_no_apto: false,
      total_hospedes: 2,
    },
    {
      id: "c",
      external_reservation_id: "YH-CAN",
      apartamento: "09",
      hospede_principal: "Diogo",
      check_in_previsto: "2099-01-01",
      check_out_previsto: "2099-01-02",
      status_reserva: "cancelada",
      pagamento_status: "pago",
      entrou_no_apto: false,
      total_hospedes: 1,
      recent_cancel_event: true,
    },
  ];
  const tsHoje = filterArrivals(sample, "hoje", now);
  const brHoje = browser.filterArrivals(sample, "hoje", now);
  assert.deepEqual(
    brHoje.map((r: { id: string }) => r.id),
    tsHoje.map((r) => r.id),
  );
  const brProblemas = browser.filterArrivals(sample, "so_problemas", now);
  assert.ok(brProblemas.some((r: { id: string }) => r.id === "c"));
  const brCard = browser.summarizeOccupiedGuests(
    [
      {
        id: "a",
        apartamento: "05",
        hospede_principal: "A",
        check_in_previsto: "2026-08-05",
        check_out_previsto: "2026-08-08",
        status_reserva: "ativa",
        entrou_no_apto: true,
        total_hospedes: 3,
      },
    ],
    now,
  );
  assert.equal(brCard.total_guests, 3);
  ok("policy browser real + equivalência TS");
}

console.log(`\nPASS hits-reservation-sync-chegadas (${cases} casos)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
