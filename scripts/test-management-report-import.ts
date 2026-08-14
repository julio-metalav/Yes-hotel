import assert from "node:assert/strict";
import { parseBrlToCents } from "../src/lib/management/import/brl.ts";
import { classifyReportChannel } from "../src/lib/management/import/channel-from-report.ts";
import { daysInMonth, nightsBetween, parseReportDate } from "../src/lib/management/import/dates.ts";
import { isEligibleLodgingNight, isExcludedHitsTipo } from "../src/lib/management/import/hits-eligibility.ts";
import { adr, occupancyRate, revpar } from "../src/lib/management/metrics.ts";
import { reconcileHitsStay } from "../src/lib/management/import/reconcile.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  OK ", name);
}

assert.equal(parseBrlToCents("$168.786,52"), 16_878_652);
assert.equal(parseBrlToCents("-$203,75"), -20_375);
assert.equal(parseBrlToCents("1.038,00 BRL"), 103_800);
ok("parser de moeda brasileira");

assert.equal(parseReportDate("01/07/26"), "2026-07-01");
assert.equal(parseReportDate("31/07/2026"), "2026-07-31");
assert.equal(nightsBetween("2026-07-01", "2026-07-06"), 5);
assert.equal(daysInMonth(2026, 2), 28);
ok("parsing das datas");

assert.equal(isEligibleLodgingNight({ tipo: "Regular", op: "L" }), true);
assert.equal(isEligibleLodgingNight({ tipo: "Regular", op: "E" }), false);
assert.equal(isEligibleLodgingNight({ tipo: "Early ck-in", op: "L" }), false);
assert.equal(isExcludedHitsTipo("Late ck-out"), true);
assert.equal(isExcludedHitsTipo("No show"), true);
assert.equal(isExcludedHitsTipo("Cortesia"), true);
ok("estorno e exclusão early/late/no-show/cortesia");

const engine = classifyReportChannel("Booking Engine");
assert.equal(engine.kind, "booking_engine");
assert.equal(engine.group, "direct");
const bookingOta = classifyReportChannel("Booking");
assert.equal(bookingOta.kind, "ota");
assert.equal(bookingOta.code, "booking");
assert.notEqual(engine.group, bookingOta.group);
assert.equal(classifyReportChannel("BOOKING.COM").code, "booking");
assert.equal(classifyReportChannel("BE Mobile").kind, "direct");
assert.equal(classifyReportChannel("BE Mobile").group, "direct");
assert.equal(classifyReportChannel("Onfly BH - Conexão Direta").kind, "b2b");
assert.equal(classifyReportChannel("COPASTUR VIAGENS E TURISMO LTDA").kind, "b2b");
assert.equal(classifyReportChannel("Expedia").kind, "ota");
ok("Booking Engine ≠ OTA; BE Mobile direto; B2B separado");

const omni = [
  {
    resNo: "RES1",
    estado: "Confirmada",
    checkin: "2026-03-11",
    checkout: "2026-03-12",
    guestNorm: "ROSELMA RODRIGUES DE CARVALHO",
    channelRaw: "Booking Engine",
    los: 1,
  },
  {
    resNo: "RES2",
    estado: "Confirmada",
    checkin: "2026-03-11",
    checkout: "2026-03-12",
    guestNorm: "ROSELMA RODRIGUES DE CARVALHO",
    channelRaw: "Booking",
    los: 1,
  },
];
const exact = reconcileHitsStay(
  {
    stayKey: "s1",
    guestNorm: "JOAO SILVA TESTE",
    guestRaw: "Joao Silva Teste",
    checkin: "2026-01-10",
    checkout: "2026-01-12",
  },
  [
    {
      resNo: "R9",
      estado: "Confirmada",
      checkin: "2026-01-10",
      checkout: "2026-01-12",
      guestNorm: "JOAO SILVA TESTE",
      channelRaw: "BE Mobile",
      los: 2,
    },
  ],
);
assert.equal(exact.status, "exact");
ok("match exact");

const unmatched = reconcileHitsStay(
  {
    stayKey: "s2",
    guestNorm: "HOSPEDE INEXISTENTE XYZ",
    guestRaw: "Hospede Inexistente Xyz",
    checkin: "2026-02-01",
    checkout: "2026-02-03",
  },
  omni,
);
assert.equal(unmatched.status, "unmatched");
assert.equal(unmatched.channelRaw, null);
ok("unmatched preservado");

const ambiguous = reconcileHitsStay(
  {
    stayKey: "s3",
    guestNorm: "ROSELMA RODRIGUES DE CARVALHO",
    guestRaw: "Roselma Rodrigues de Carvalho",
    checkin: "2026-03-11",
    checkout: "2026-03-12",
  },
  omni,
);
assert.equal(ambiguous.status, "ambiguous");
assert.equal(ambiguous.channelRaw, null);
ok("ambiguous sem canal inventado");

const otaBrand = reconcileHitsStay(
  {
    stayKey: "s4",
    guestNorm: "BOOKING COM",
    guestRaw: "BOOKING.COM",
    checkin: "2026-01-01",
    checkout: "2026-01-02",
  },
  omni,
);
assert.equal(otaBrand.status, "unmatched");
ok("BOOKING.COM HITS não casa por nome com Omnibees");

assert.equal(occupancyRate({ occupiedRoomNights: 595, availableRoomNights: 1240 }).value, 595 / 1240);
assert.equal(adr({ lodgingRevenueCents: 16_878_652, roomsSold: 595 }).value, 16_878_652 / 595);
assert.equal(revpar({ lodgingRevenueCents: 16_878_652, availableRoomNights: 1240 }).value, 16_878_652 / 1240);
ok("ocupação, ADR e RevPAR");

const jsonPath = join(root, "ui/data/management-historical-2026.json");
assert.equal(existsSync(jsonPath), true);
const data = JSON.parse(readFileSync(jsonPath, "utf8"));
assert.equal(data.source, "hits_omnibees_reports");
assert.equal(data.periods["2026-07"].roomNights, 595);
assert.equal(data.periods["2026-07"].lodgingRevenueCents, 16_878_652);
assert.equal(data.periods["2026-ytd"].roomNights, 3505);
const blob = JSON.stringify(data);
assert.equal(/cpf|passaporte/i.test(blob), false);
assert.equal(/Tanielle|Sandim|guestRaw/i.test(blob), false);
ok("soma mensal julho e dataset sem PII");

const ytdChannels = data.periods["2026-ytd"].channels;
assert.equal(ytdChannels.some((c: { kind: string; group: string }) => c.kind === "booking_engine" && c.group === "ota"), false);
assert.equal(ytdChannels.some((c: { kind: string }) => c.kind === "b2b"), true);
assert.ok(ytdChannels.some((c: { stayCount?: number }) => (c.stayCount ?? 0) > 0));
ok("dataset: engine ≠ OTA e B2B separado");

console.log(`\n=== ${cases} checks import relatórios Gestão OK ===`);
