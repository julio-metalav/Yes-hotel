import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_SELLABLE_ROOMS } from "../src/lib/management/inventory.ts";
import { adr, occupancyRate, revpar } from "../src/lib/management/metrics.ts";
import { parseBrlToCents } from "../src/lib/management/import/brl.ts";
import { classifyReportChannel } from "../src/lib/management/import/channel-from-report.ts";
import { daysInMonth, monthKey, nightsBetween, parseReportDate } from "../src/lib/management/import/dates.ts";
import { isEligibleLodgingNight } from "../src/lib/management/import/hits-eligibility.ts";
import { normalizeReportText } from "../src/lib/management/import/normalize.ts";
import { reconcileHitsStay, type OmniReservation } from "../src/lib/management/import/reconcile.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extractedDir = join(root, "tmp", "management-import", "extracted");

type HitsRaw = {
  sourceFile: string;
  auditDate: string;
  op: string;
  tipo: string;
  diaria: string;
  ab: string;
  diariaAb: string;
  guestRaw: string;
  stayIn: string | null;
  stayOut: string | null;
  accountOrigin: string | null;
};

type OmniRaw = {
  res_no?: string;
  estado?: string;
  booked_at?: string;
  checkin?: string;
  checkout?: string;
  guest?: string;
  channel?: string;
  los?: string;
  total?: string;
};

const CHANNEL_ORDER = [
  "direct",
  "be_mobile",
  "booking_engine",
  "booking",
  "expedia",
  "airbnb",
  "despegar",
  "b2b",
  "unknown",
] as const;

function loadJson<T>(name: string): T {
  const path = join(extractedDir, name);
  if (!existsSync(path)) {
    throw new Error(`Extração ausente: ${path}. Rode o extractor de PDF.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseLos(raw: string | undefined): number | null {
  const match = String(raw ?? "").match(/\d+/);
  if (!match) return null;
  return Number(match[0]);
}

function stayKeyOf(row: HitsRaw, checkin: string, checkout: string): string {
  if (row.accountOrigin) return row.accountOrigin;
  return `${normalizeReportText(row.guestRaw)}|${checkin}|${checkout}`;
}

function availableNights(year: number, month: number): number {
  return DEFAULT_SELLABLE_ROOMS * daysInMonth(year, month);
}

function emptyChannelBag() {
  const bag: Record<
    string,
    { code: string; label: string; kind: string; group: string; nights: number; lodgingCents: number; stays: Set<string> }
  > = {};
  return bag;
}

function addChannel(
  bag: ReturnType<typeof emptyChannelBag>,
  code: string,
  meta: { label: string; kind: string; group: string },
  stayKey: string,
  lodgingCents: number,
) {
  if (!bag[code]) {
    bag[code] = { code, label: meta.label, kind: meta.kind, group: meta.group, nights: 0, lodgingCents: 0, stays: new Set() };
  }
  bag[code].nights += 1;
  bag[code].lodgingCents += lodgingCents;
  bag[code].stays.add(stayKey);
}

type MonthAcc = {
  lodgingCents: number;
  abCents: number;
  diariaCents: number;
  nights: number;
  stays: Set<string>;
  losSum: number;
  identifiedLodging: number;
  identifiedNights: number;
  exact: number;
  high: number;
  unmatched: number;
  ambiguous: number;
  channels: ReturnType<typeof emptyChannelBag>;
};

function newMonth(): MonthAcc {
  return {
    lodgingCents: 0,
    abCents: 0,
    diariaCents: 0,
    nights: 0,
    stays: new Set(),
    losSum: 0,
    identifiedLodging: 0,
    identifiedNights: 0,
    exact: 0,
    high: 0,
    unmatched: 0,
    ambiguous: 0,
    channels: emptyChannelBag(),
  };
}

function serializePeriod(key: string, label: string, acc: MonthAcc, available: number) {
  const occ = occupancyRate({ occupiedRoomNights: acc.nights, availableRoomNights: available });
  const adrRes = adr({ lodgingRevenueCents: acc.lodgingCents, roomsSold: acc.nights });
  const rev = revpar({ lodgingRevenueCents: acc.lodgingCents, availableRoomNights: available });
  const channels = CHANNEL_ORDER.map((code) => {
    const row = acc.channels[code];
    if (!row) {
      return null;
    }
    const channelAdr = adr({ lodgingRevenueCents: row.lodgingCents, roomsSold: row.nights });
    return {
      code: row.code,
      kind: row.kind,
      group: row.group,
      label: row.label,
      stayCount: row.stays.size,
      roomNights: row.nights,
      lodgingRevenueCents: row.lodgingCents,
      adrCents: channelAdr.value,
      shareOfReservations: acc.stays.size ? row.stays.size / acc.stays.size : 0,
      shareOfRevenue: acc.lodgingCents ? row.lodgingCents / acc.lodgingCents : 0,
      shareOfNights: acc.nights ? row.nights / acc.nights : 0,
    };
  }).filter(Boolean);
  return {
    key,
    label,
    lodgingRevenueCents: acc.lodgingCents,
    abCents: acc.abCents,
    diariaTotalCents: acc.diariaCents,
    roomNights: acc.nights,
    availableRoomNights: available,
    occupancy: occ.value,
    adrCents: adrRes.value,
    revparCents: rev.value,
    reservationCount: acc.stays.size,
    averageLos: acc.stays.size ? acc.nights / acc.stays.size : null,
    coverage: {
      revenueIdentified: acc.lodgingCents ? acc.identifiedLodging / acc.lodgingCents : 0,
      nightsIdentified: acc.nights ? acc.identifiedNights / acc.nights : 0,
      exact: acc.exact,
      highConfidence: acc.high,
      unmatched: acc.unmatched,
      ambiguous: acc.ambiguous,
    },
    channels,
  };
}

function ensureExtracted() {
  if (existsSync(join(extractedDir, "hits-rows.json")) && existsSync(join(extractedDir, "omnibees-rows.json"))) {
    return;
  }
  const py = spawnSync("python", [join(root, "scripts", "extract-management-pdfs.py")], {
    cwd: root,
    stdio: "inherit",
  });
  if (py.status !== 0) {
    throw new Error("Falha ao extrair PDFs");
  }
}

function main() {
  ensureExtracted();
  const hits = loadJson<HitsRaw[]>("hits-rows.json");
  const omniRaw = loadJson<OmniRaw[]>("omnibees-rows.json");

  const omnibees: OmniReservation[] = [];
  let omniCanceladas = 0;
  for (const row of omniRaw) {
    try {
      const checkin = parseReportDate(row.checkin || "");
      const checkout = parseReportDate(row.checkout || "");
      const estado = String(row.estado || "").trim();
      if (estado === "Cancelada") omniCanceladas += 1;
      omnibees.push({
        resNo: String(row.res_no || "").replace(/\s+/g, ""),
        estado,
        checkin,
        checkout,
        guestNorm: normalizeReportText(row.guest || ""),
        channelRaw: String(row.channel || "").trim(),
        los: parseLos(row.los) ?? nightsBetween(checkin, checkout),
      });
    } catch {
      continue;
    }
  }

  const months = new Map<string, MonthAcc>();
  const ytd = newMonth();
  const stayMatch = new Map<string, ReturnType<typeof reconcileHitsStay>>();
  let skipped2025 = 0;

  for (const row of hits) {
    if (!isEligibleLodgingNight(row)) continue;
    const auditIso = parseReportDate(row.auditDate);
    const y = Number(auditIso.slice(0, 4));
    const m = Number(auditIso.slice(5, 7));
    if (y !== 2026 || m < 1 || m > 7) {
      skipped2025 += 1;
      continue;
    }
    const checkin = row.stayIn ? parseReportDate(row.stayIn) : auditIso;
    const checkout = row.stayOut ? parseReportDate(row.stayOut) : auditIso;
    const key = stayKeyOf(row, checkin, checkout);
    if (!stayMatch.has(key)) {
      stayMatch.set(
        key,
        reconcileHitsStay(
          {
            stayKey: key,
            guestNorm: normalizeReportText(row.guestRaw),
            guestRaw: row.guestRaw,
            checkin,
            checkout,
          },
          omnibees,
        ),
      );
    }
    const match = stayMatch.get(key)!;
    const hitsChannel = classifyReportChannel(row.guestRaw);
    let channel = hitsChannel;
    if (channel.kind === "unknown" && (match.status === "exact" || match.status === "high_confidence") && match.channelRaw) {
      channel = classifyReportChannel(match.channelRaw);
    }

    const lodging = parseBrlToCents(row.diariaAb);
    const ab = parseBrlToCents(row.ab);
    const diaria = parseBrlToCents(row.diaria);
    const mk = monthKey(auditIso);
    if (!months.has(mk)) months.set(mk, newMonth());
    const acc = months.get(mk)!;
    for (const bucket of [acc, ytd]) {
      bucket.nights += 1;
      bucket.lodgingCents += lodging;
      bucket.abCents += ab;
      bucket.diariaCents += diaria;
      if (!bucket.stays.has(key)) {
        bucket.stays.add(key);
        if (match.status === "exact") bucket.exact += 1;
        else if (match.status === "high_confidence") bucket.high += 1;
        else if (match.status === "ambiguous") bucket.ambiguous += 1;
        else bucket.unmatched += 1;
      }
      addChannel(bucket.channels, channel.code, channel, key, lodging);
      if (channel.kind !== "unknown") {
        bucket.identifiedLodging += lodging;
        bucket.identifiedNights += 1;
      }
    }
  }

  const periodLabels: Record<string, string> = {
    "2026-01": "Janeiro/2026",
    "2026-02": "Fevereiro/2026",
    "2026-03": "Março/2026",
    "2026-04": "Abril/2026",
    "2026-05": "Maio/2026",
    "2026-06": "Junho/2026",
    "2026-07": "Julho/2026",
    "2026-ytd": "Acumulado Jan–Jul/2026",
  };

  const periods: Record<string, ReturnType<typeof serializePeriod>> = {};
  let ytdAvailable = 0;
  for (const mk of Object.keys(periodLabels).filter((k) => k !== "2026-ytd")) {
    const [ys, ms] = mk.split("-").map(Number);
    const avail = availableNights(ys, ms);
    ytdAvailable += avail;
    periods[mk] = serializePeriod(mk, periodLabels[mk], months.get(mk) ?? newMonth(), avail);
  }
  periods["2026-ytd"] = serializePeriod("2026-ytd", periodLabels["2026-ytd"], ytd, ytdAvailable);

  const monthKeys = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
  function alertsFor(currentKey: string, previousKey: string | null) {
    const cur = periods[currentKey];
    const prev = previousKey ? periods[previousKey] : null;
    const alerts: Array<{ code: string; severity: string; message: string }> = [];
    if (prev && cur.occupancy != null && prev.occupancy != null && prev.occupancy - cur.occupancy >= 0.05) {
      alerts.push({ code: "occupancy_down", severity: "warning", message: "Ocupação caiu frente ao mês anterior." });
    }
    if (prev && cur.adrCents != null && prev.adrCents != null && prev.adrCents > 0 && (prev.adrCents - cur.adrCents) / prev.adrCents >= 0.08) {
      alerts.push({ code: "adr_drop", severity: "warning", message: "ADR caiu frente ao mês anterior." });
    }
    if (prev && cur.lodgingRevenueCents < prev.lodgingRevenueCents * 0.92) {
      alerts.push({ code: "revenue_down", severity: "warning", message: "Receita de hospedagem caiu frente ao mês anterior." });
    }
    const ota = (row: typeof cur) =>
      (row.channels as Array<{ group: string; shareOfRevenue: number }>).filter((c) => c.group === "ota").reduce((s, c) => s + c.shareOfRevenue, 0);
    const direct = (row: typeof cur) =>
      (row.channels as Array<{ group: string; shareOfRevenue: number }>).filter((c) => c.group === "direct").reduce((s, c) => s + c.shareOfRevenue, 0);
    if (prev && ota(cur) - ota(prev) >= 0.08) {
      alerts.push({ code: "ota_share_up", severity: "warning", message: "Participação OTA na receita cresceu frente ao mês anterior." });
    }
    if (prev && direct(prev) - direct(cur) >= 0.08) {
      alerts.push({ code: "direct_down", severity: "warning", message: "Participação de reservas diretas/motor caiu frente ao mês anterior." });
    }
    if (cur.coverage.revenueIdentified < 0.6) {
      alerts.push({
        code: "coverage_low",
        severity: "info",
        message: "Cobertura de canal abaixo de 60% da receita realizada.",
      });
    }
    return alerts.slice(0, 5);
  }

  for (let i = 0; i < monthKeys.length; i++) {
    const prev = i === 0 ? null : monthKeys[i - 1];
    (periods[monthKeys[i]] as { alerts?: unknown }).alerts = alertsFor(monthKeys[i], prev);
  }
  (periods["2026-ytd"] as { alerts?: unknown }).alerts = alertsFor("2026-07", "2026-06");

  const payload = {
    source: "hits_omnibees_reports",
    periodStart: "2026-01-01",
    periodEnd: "2026-07-31",
    generatedAt: new Date().toISOString(),
    sellableRooms: DEFAULT_SELLABLE_ROOMS,
    banner: "DADOS HISTÓRICOS REAIS — HITS + Omnibees — Jan a Jul/2026",
    footnote: "Atualização manual por relatórios · integração automática HITS pendente",
    sources: [
      "HITS diarias lancadas Jan-Mar",
      "HITS diarias lancadas Apr-Jun",
      "HITS diarias lancadas Jul",
      "Omnibees reservas Jan-Jul",
    ],
    methodology: {
      eligibleNights: "Tipo Regular e operação L",
      excludedTipos: ["Early ck-in", "Late ck-out", "No show", "Cortesia"],
      excludedOps: ["E"],
      occupancyDenominator: "40 apartamentos × dias do mês (sem bloqueios registrados)",
      lodgingRevenue: "coluna Diária-A&B das noites elegíveis",
      notes: [
        "HITS é a fonte do realizado. Omnibees só enriquece canal quando o match é exact ou high_confidence.",
        "Ambiguous não recebe canal Omnibees.",
        skipped2025 ? `${skipped2025} noite(s) Regular fora de Jan–Jul/2026 foram excluídas do recorte.` : "",
      ].filter(Boolean),
    },
    omnibees: {
      parsedReservations: omnibees.length,
      cancelled: omniCanceladas,
      reportHeaderApartments: 581,
      reportHeaderTotalBrl: 417466.02,
    },
    defaultPeriod: "2026-07",
    periods,
  };

  const outDir = join(root, "ui", "data");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "management-historical-2026.json");
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writeFileSync(
    join(outDir, "management-historical-2026.js"),
    `(function (globalScope) {\n  globalScope.YesHotelGestaoHistorico = ${JSON.stringify(payload)};\n})(typeof window !== "undefined" ? window : globalThis);\n`,
    "utf8",
  );

  console.log("Wrote", jsonPath);
  console.log("skipped_outside_2026_h1", skipped2025);
  console.log("omnibees_parsed", omnibees.length, "canceladas", omniCanceladas);
  for (const key of [...monthKeys, "2026-ytd"]) {
    const p = periods[key];
    console.log(
      [
        key,
        `rn=${p.roomNights}`,
        `lodging=${(p.lodgingRevenueCents / 100).toFixed(2)}`,
        `ab=${(p.abCents / 100).toFixed(2)}`,
        `occ=${p.occupancy == null ? "-" : (p.occupancy * 100).toFixed(1)}%`,
        `adr=${p.adrCents == null ? "-" : (p.adrCents / 100).toFixed(2)}`,
        `revpar=${p.revparCents == null ? "-" : (p.revparCents / 100).toFixed(2)}`,
        `cov=${(p.coverage.revenueIdentified * 100).toFixed(1)}%`,
      ].join(" | "),
    );
  }
}

main();
