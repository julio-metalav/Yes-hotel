/**
 * Fundação Gestão/CRM — fórmulas e identidade. Fixtures sintéticas. Sem I/O externo.
 */
import assert from "node:assert/strict";
import { summarizeCompany } from "../src/lib/crm/company.ts";
import { historicalLtvCents, isRecurrentGuest, summarizeGuest } from "../src/lib/crm/guest-profile.ts";
import { isValidCpf, resolveGuestIdentity } from "../src/lib/crm/identity.ts";
import { evaluateManagementAlerts } from "../src/lib/management/alerts.ts";
import type { CanonicalReservationInput } from "../src/lib/management/canonical.ts";
import { derivedRoomNights } from "../src/lib/management/canonical.ts";
import { canonicalChannelFromOperational } from "../src/lib/management/channel.ts";
import { computePickup } from "../src/lib/management/forecast.ts";
import { DEFAULT_SELLABLE_ROOMS } from "../src/lib/management/inventory.ts";
import {
  adr,
  averageLengthOfStay,
  channelParticipation,
  lodgingRevenueSum,
  netRevenueByChannel,
  occupancyFromReservations,
  occupancyRate,
  receivableAging,
  revpar,
  ticketAveragePerGuest,
  ticketAveragePerReservation,
} from "../src/lib/management/metrics.ts";
import { roomNightsBetween } from "../src/lib/management/temporal.ts";
import { canonicalReservationFromSynced } from "../src/lib/management/from-synced-reservation.ts";
import {
  hitsSourceReservationIdIsValid,
  receivableAgingV1,
  reservationChannelPairIsValid,
  reservationIdempotencyKey,
  shouldPersistChannelCost,
  snapshotUniquenessKey,
  stayCountsTowardOccupancy,
  stayNightsMatchSchedule,
} from "../src/lib/management/persistence.ts";
import type { SyncedReservation } from "../src/lib/domain/yes-hotel/synced-reservation.ts";

const VALID_CPF = "52998224725";
let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function res(
  partial: Partial<CanonicalReservationInput> &
    Pick<CanonicalReservationInput, "externalReservationId" | "arrivalDate" | "departureDate" | "channel">,
): CanonicalReservationInput {
  return {
    sourceSystem: "manual",
    status: "booked",
    bookedAt: null,
    apartmentCode: "01",
    companyExternalId: null,
    companyName: null,
    lodgingRevenueCents: 100_000,
    channelCommissionCents: null,
    balanceDueCents: 0,
    guests: [],
    ...partial,
  };
}

console.log("\n=== Gestão/CRM foundation ===\n");

{
  assert.equal(roomNightsBetween("2026-03-20", "2026-03-23"), 3);
  assert.equal(derivedRoomNights({ arrivalDate: "2026-03-20", departureDate: "2026-03-21" }), 1);
  ok("noites civis (checkout exclusivo)");
}

{
  assert.equal(DEFAULT_SELLABLE_ROOMS, 40);
  const occ = occupancyRate({ occupiedRoomNights: 20, availableRoomNights: 40 });
  assert.equal(occ.value, 0.5);
  ok("ocupação 20/40 = 50%");
}

{
  const a = adr({ lodgingRevenueCents: 400_000, roomsSold: 2 });
  assert.equal(a.value, 200_000);
  const r = revpar({ lodgingRevenueCents: 400_000, availableRoomNights: 40 });
  assert.equal(r.value, 10_000);
  ok("ADR e RevPAR em centavos");
}

{
  const occ = occupancyFromReservations({
    from: "2026-03-20",
    to: "2026-03-21",
    sellableRooms: 40,
    reservations: [
      res({
        externalReservationId: "A",
        arrivalDate: "2026-03-20",
        departureDate: "2026-03-22",
        channel: { kind: "direct", code: "direct", label: "Direto" },
      }),
    ],
  });
  assert.equal(occ.occupiedRoomNights, 2);
  assert.equal(occ.availableRoomNights, 80);
  assert.equal(occ.occupancy.value, 2 / 80);
  ok("ocupação a partir de reservas × inventário 40");
}

{
  const cancelled = occupancyFromReservations({
    from: "2026-03-20",
    to: "2026-03-20",
    sellableRooms: 40,
    reservations: [
      res({
        externalReservationId: "X",
        status: "cancelled",
        arrivalDate: "2026-03-20",
        departureDate: "2026-03-21",
        channel: { kind: "ota", code: "booking", label: "Booking" },
      }),
    ],
  });
  assert.equal(cancelled.occupiedRoomNights, 0);
  ok("cancelada não ocupa quarto");
}

{
  const stay = averageLengthOfStay({ roomNightsSold: 10, eligibleStayCount: 4 });
  assert.equal(stay.value, 2.5);
  const tRes = ticketAveragePerReservation({ lodgingRevenueCents: 300_000, reservationCount: 3 });
  assert.equal(tRes.value, 100_000);
  const tGuest = ticketAveragePerGuest({ lodgingRevenueCents: 300_000, uniqueGuestCount: 2 });
  assert.equal(tGuest.value, 150_000);
  ok("permanência e tickets (reserva vs hóspede)");
}

{
  const engine = canonicalChannelFromOperational({
    originKind: "booking_engine",
    label: "Booking Engine",
  });
  const ota = canonicalChannelFromOperational({
    originKind: "ota",
    matchedOtaId: "booking",
    label: "Booking",
  });
  assert.equal(engine.kind, "booking_engine");
  assert.equal(ota.kind, "ota");
  assert.notEqual(engine.kind, ota.kind);
  ok("Booking Engine ≠ Booking OTA");
}

{
  const rows = [
    res({
      externalReservationId: "1",
      arrivalDate: "2026-04-01",
      departureDate: "2026-04-03",
      lodgingRevenueCents: 200_000,
      channel: { kind: "ota", code: "booking", label: "Booking" },
    }),
    res({
      externalReservationId: "2",
      arrivalDate: "2026-04-01",
      departureDate: "2026-04-02",
      lodgingRevenueCents: 200_000,
      channel: { kind: "direct", code: "direct", label: "Direto" },
    }),
    res({
      externalReservationId: "3",
      arrivalDate: "2026-04-01",
      departureDate: "2026-04-02",
      lodgingRevenueCents: 100_000,
      channel: { kind: "booking_engine", code: "booking_engine", label: "Booking Engine" },
    }),
  ];
  const share = channelParticipation(rows);
  const ota = share.find((s) => s.kind === "ota")!;
  const direct = share.find((s) => s.kind === "direct")!;
  const be = share.find((s) => s.kind === "booking_engine")!;
  assert.equal(ota.reservations, 1);
  assert.equal(direct.shareOfReservations, 1 / 3);
  assert.equal(be.shareOfRevenue, 100_000 / 500_000);
  assert.equal(ota.group, "ota");
  assert.equal(direct.group, "direct");
  assert.equal(be.group, "direct");
  ok("participação por canal (reservas e receita)");
}

{
  const withCommission = netRevenueByChannel([
    res({
      externalReservationId: "c1",
      arrivalDate: "2026-04-01",
      departureDate: "2026-04-02",
      lodgingRevenueCents: 100_000,
      channelCommissionCents: 15_000,
      channel: { kind: "ota", code: "booking", label: "Booking" },
    }),
  ]);
  assert.equal(withCommission[0].netRevenueCents, 85_000);

  const unknownCommission = netRevenueByChannel([
    res({
      externalReservationId: "c2",
      arrivalDate: "2026-04-01",
      departureDate: "2026-04-02",
      lodgingRevenueCents: 100_000,
      channelCommissionCents: null,
      channel: { kind: "ota", code: "expedia", label: "Expedia" },
    }),
  ]);
  assert.equal(unknownCommission[0].netRevenueCents, null);
  ok("receita líquida: comissão conhecida vs não fabricada");
}

{
  const aging = receivableAging(
    [
      { dueDate: "2026-03-01", openCents: 10_000 },
      { dueDate: "2026-02-01", openCents: 20_000 },
      { dueDate: "2026-01-10", openCents: 30_000 },
      { dueDate: "2025-11-01", openCents: 40_000 },
    ],
    "2026-03-15",
  );
  assert.equal(aging[0].openCents, 10_000);
  assert.equal(aging[1].openCents, 20_000);
  assert.equal(aging[2].openCents, 30_000);
  assert.equal(aging[3].openCents, 40_000);
  ok("aging 0-30 / 31-60 / 61-90 / 90+");
}

{
  const pickup = computePickup({
    earlierAsOf: "2026-03-01",
    laterAsOf: "2026-03-08",
    stayDates: ["2026-04-10"],
    snapshots: [
      {
        asOfDate: "2026-03-01",
        stayDate: "2026-04-10",
        roomsOnBooks: 10,
        lodgingRevenueCents: 100_000,
        reservationCount: 8,
      },
      {
        asOfDate: "2026-03-08",
        stayDate: "2026-04-10",
        roomsOnBooks: 14,
        lodgingRevenueCents: 150_000,
        reservationCount: 11,
      },
    ],
  });
  assert.equal(pickup[0].roomsDelta, 4);
  assert.equal(pickup[0].revenueDeltaCents, 50_000);
  assert.equal(pickup[0].reservationsDelta, 3);
  ok("pickup = snapshot posterior − anterior");
}

{
  assert.equal(isValidCpf(VALID_CPF), true);
  assert.equal(isValidCpf("11111111111"), false);
  const br = resolveGuestIdentity({
    documentType: "cpf",
    documentNumber: VALID_CPF,
    nationality: "BR",
  });
  assert.equal(br.matchKey, `cpf:${VALID_CPF}`);
  const foreign = resolveGuestIdentity({
    documentType: "passport",
    documentNumber: "AB123456",
    nationality: "AR",
  });
  assert.equal(foreign.matchKey, "passport:AB123456");
  const emailIsNotIdentity = resolveGuestIdentity({
    documentType: null,
    documentNumber: null,
    nationality: null,
  });
  assert.equal(emailIsNotIdentity.matchKey, null);
  ok("identidade CPF/passaporte; e-mail não é chave");
}

{
  assert.equal(isRecurrentGuest(1), false);
  assert.equal(isRecurrentGuest(2), true);
  assert.equal(historicalLtvCents([{ lodgingRevenueCents: 100 }, { lodgingRevenueCents: 50 }]), 150);
  const summary = summarizeGuest({
    matchKey: `cpf:${VALID_CPF}`,
    asOfDate: "2026-08-01",
    stays: [
      {
        matchKey: `cpf:${VALID_CPF}`,
        stayId: "s1",
        departureDate: "2025-01-10",
        lodgingRevenueCents: 200_000,
        roomNights: 2,
        channelKind: "ota",
      },
      {
        matchKey: `cpf:${VALID_CPF}`,
        stayId: "s2",
        departureDate: "2026-06-10",
        lodgingRevenueCents: 300_000,
        roomNights: 3,
        channelKind: "direct",
      },
    ],
  });
  assert.equal(summary.isRecurrent, true);
  assert.equal(summary.historicalRevenueCents, 500_000);
  assert.equal(summary.otaToDirectReturn, true);
  assert.equal(summary.b2bToDirectReturn, false);
  assert.equal(summary.segment, "high_value");
  ok("recorrência, LTV histórico, OTA→direto");
}

{
  const b2bThenDirect = summarizeGuest({
    matchKey: `cpf:${VALID_CPF}`,
    asOfDate: "2026-08-01",
    stays: [
      {
        matchKey: `cpf:${VALID_CPF}`,
        stayId: "b1",
        departureDate: "2025-02-01",
        lodgingRevenueCents: 100_000,
        roomNights: 1,
        channelKind: "b2b",
      },
      {
        matchKey: `cpf:${VALID_CPF}`,
        stayId: "b2",
        departureDate: "2026-03-01",
        lodgingRevenueCents: 100_000,
        roomNights: 1,
        channelKind: "booking_engine",
      },
    ],
  });
  assert.equal(b2bThenDirect.otaToDirectReturn, false);
  assert.equal(b2bThenDirect.b2bToDirectReturn, true);
  ok("B2B→direto distinto de OTA→direto");
}

{
  const company = summarizeCompany({
    companyKey: "acme",
    name: "Acme Ltda",
    previousPeriodRevenueCents: 400_000,
    stays: [
      {
        companyKey: "acme",
        reservationId: "r1",
        departureDate: "2026-05-01",
        lodgingRevenueCents: 250_000,
        roomNights: 5,
        guestMatchKeys: [`cpf:${VALID_CPF}`],
      },
    ],
  });
  assert.equal(company.trend, "down");
  assert.equal(company.linkedGuestCount, 1);
  ok("CRM empresa B2B tendência");
}

{
  const alerts = evaluateManagementAlerts({
    futureOccupancy: 0.4,
    historicalOccupancy: 0.7,
    currentAdrCents: 80_000,
    previousAdrCents: 100_000,
    currentCancelRate: 0.12,
    previousCancelRate: 0.04,
    currentDirectShare: 0.2,
    previousDirectShare: 0.4,
    otaShare: 0.8,
    overdueCents: 50_000,
    b2bRevenueDeltaRatio: -0.4,
    highValueInactiveCount: 1,
  });
  assert.ok(alerts.some((a) => a.code === "future_occupancy_below_history"));
  assert.ok(alerts.some((a) => a.code === "adr_drop"));
  assert.ok(alerts.some((a) => a.code === "ota_share_excessive"));
  assert.ok(alerts.some((a) => a.code === "overdue_receivables"));
  ok("alertas gerenciais determinísticos");
}

{
  assert.equal(lodgingRevenueSum([]), 0);
  assert.equal(
    lodgingRevenueSum([
      res({
        externalReservationId: "z",
        arrivalDate: "2026-01-01",
        departureDate: "2026-01-02",
        lodgingRevenueCents: null,
        channel: { kind: "unknown", code: null, label: null },
      }),
    ]),
    null,
  );
  ok("soma de receita: vazio=0; desconhecida=null");
}

{
  const synced = (salesChannel: string): SyncedReservation => ({
    provider: "hits",
    externalReservationId: "9001",
    sourceUpdatedAt: null,
    syncedAt: null,
    reservationStatus: "ativa",
    checkIn: "2026-03-20",
    checkOut: "2026-03-22",
    apartmentCode: "05",
    mainGuestName: "Teste",
    guests: [
      {
        externalGuestId: "g1",
        name: "Teste",
        isPrincipal: true,
        isMinor: false,
        phone: "11999990000",
        email: "a@b.com",
        nationality: "BR",
        documentType: "cpf",
        documentNumber: VALID_CPF,
      },
    ],
    adults: 1,
    minors: 0,
    totalGuests: 1,
    mealPlanDesc: null,
    paymentStatus: "pendente",
    phone: null,
    email: null,
    channelManager: null,
    salesChannel,
    billingEntity: null,
    reservationChannelId: null,
    reservationBalanceDue: 10,
    reservationTotalAmount: 100,
    classificacaoComissionamento: null,
    rawSanitized: null,
  });
  const engine = canonicalReservationFromSynced(synced("Booking Engine"));
  const ota = canonicalReservationFromSynced(synced("Booking"));
  assert.equal(engine.channel.kind, "booking_engine");
  assert.equal(ota.channel.kind, "ota");
  assert.equal(engine.bookedAt, null);
  assert.equal(engine.channelCommissionCents, null);
  assert.equal(engine.lodgingRevenueCents, 10_000);
  assert.equal(engine.guests[0]?.identity?.kind, "cpf");
  ok("projeção SyncedReservation → canônico (sem bookedAt/comissão)");
}

{
  assert.equal(reservationIdempotencyKey("hits", "9001"), "hits:9001");
  assert.throws(() => reservationIdempotencyKey("hits", " "));
  assert.equal(snapshotUniquenessKey("2026-03-08", "2026-04-10"), "2026-03-08|2026-04-10|eod");
  assert.notEqual(
    snapshotUniquenessKey("2026-03-08", "2026-04-10", "eod"),
    snapshotUniquenessKey("2026-03-08", "2026-04-10", "midday"),
  );
  ok("chaves de idempotência reserva e snapshot");
}

{
  assert.equal(stayCountsTowardOccupancy("planned"), true);
  assert.equal(stayCountsTowardOccupancy("occupied"), true);
  assert.equal(stayCountsTowardOccupancy("completed"), true);
  assert.equal(stayCountsTowardOccupancy("cancelled"), false);
  assert.equal(stayCountsTowardOccupancy("no_show"), false);
  ok("estadia cancelada/no-show não ocupa");
}

{
  const aging = receivableAgingV1(
    [
      { dueDate: "2026-03-20", openCents: 5_000 },
      { dueDate: "2026-03-10", openCents: 10_000 },
      { dueDate: "2026-02-01", openCents: 20_000 },
    ],
    "2026-03-15",
  );
  assert.equal(aging[0].bucket, "current");
  assert.equal(aging[0].openCents, 5_000);
  assert.equal(aging[1].bucket, "1_30");
  assert.equal(aging[1].openCents, 10_000);
  assert.equal(aging[2].openCents, 20_000);
  ok("aging V1 current / 1-30 / 31-60");
}

{
  assert.equal(shouldPersistChannelCost(null), false);
  assert.equal(shouldPersistChannelCost(undefined), false);
  assert.equal(shouldPersistChannelCost(0), true);
  assert.equal(shouldPersistChannelCost(1500), true);
  ok("custo de canal: null não persiste; 0 só se conhecido");
}

{
  assert.equal(hitsSourceReservationIdIsValid("manual", null), true);
  assert.equal(hitsSourceReservationIdIsValid("unknown", null), true);
  assert.equal(hitsSourceReservationIdIsValid("hits", "9001"), true);
  assert.equal(hitsSourceReservationIdIsValid("hits", null), false);
  assert.equal(hitsSourceReservationIdIsValid("hits", "  "), false);
  ok("HITS exige source_reservation_id; manual pode sem ID");
}

{
  assert.equal(reservationChannelPairIsValid("booking_engine", "booking_engine"), true);
  assert.equal(reservationChannelPairIsValid("ota", "booking"), true);
  assert.equal(reservationChannelPairIsValid("ota", "booking_engine"), false);
  assert.equal(reservationChannelPairIsValid("booking_engine", "booking"), false);
  ok("canal: booking_engine ≠ booking OTA");
}

{
  assert.equal(
    stayNightsMatchSchedule({
      nights: 2,
      scheduledCheckinDate: "2026-03-20",
      scheduledCheckoutDate: "2026-03-22",
    }),
    true,
  );
  assert.equal(
    stayNightsMatchSchedule({
      nights: 3,
      scheduledCheckinDate: "2026-03-20",
      scheduledCheckoutDate: "2026-03-22",
    }),
    false,
  );
  assert.equal(
    stayNightsMatchSchedule({
      nights: 0,
      scheduledCheckinDate: "2026-03-20",
      scheduledCheckoutDate: "2026-03-20",
    }),
    false,
  );
  ok("noites coerentes com datas (checkout exclusivo)");
}

console.log(`\n=== ${passed} checks Gestão/CRM foundation OK ===\n`);
