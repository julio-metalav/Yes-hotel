/**
 * Testes do dia operacional (07:00 America/Campo_Grande) e ranges de período.
 * Inclui regressão: chegadas futuras do mês (ex.: 14/08 comissionada) entram em
 * "7 dias" / "Este mês" / período custom — não só até "hoje".
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { resolve } from "node:path";

const src = readFileSync(resolve("ui/checkin-operacional-mvp.js"), "utf8");

const OP_HOTEL_TZ = "America/Campo_Grande";
const OP_DAY_START_HOUR = 7;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function addDaysYmd(ymd: string, days: number) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function endOfMonthYmd(ymd: string) {
  const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}
function hotelLocalParts(now: Date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: OP_HOTEL_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
  };
}
function resolveOperationalTodayYmd(now: Date) {
  const { ymd, hour } = hotelLocalParts(now);
  if (hour < OP_DAY_START_HOUR) return addDaysYmd(ymd, -1);
  return ymd;
}
function resolvePeriodRangeYmd(
  periodo: string,
  opts: { now?: Date; fromYmd?: string; toYmd?: string } = {},
) {
  const today = resolveOperationalTodayYmd(opts.now || new Date());
  const yesterday = addDaysYmd(today, -1);
  if (periodo === "hoje") return { from: today, to: today };
  if (periodo === "ontem") return { from: yesterday, to: yesterday };
  if (periodo === "7dias") return { from: today, to: addDaysYmd(today, 6) };
  if (periodo === "este_mes") {
    return { from: `${today.slice(0, 7)}-01`, to: endOfMonthYmd(today) };
  }
  if (periodo === "periodo") {
    let from = String(opts.fromYmd || "").slice(0, 10);
    let to = String(opts.toYmd || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return { from: today, to: today };
    }
    if (from > to) return { from: to, to: from };
    return { from, to };
  }
  return { from: today, to: today };
}

function inRange(checkIn: string, range: { from: string; to: string }) {
  const ymd = String(checkIn).slice(0, 10);
  return ymd >= range.from && ymd <= range.to;
}

// Sanity: funções existem no arquivo do painel
assert.match(src, /OP_DAY_START_HOUR = 7/);
assert.match(src, /resolveOperationalTodayYmd/);
assert.match(src, /endOfMonthYmd/);
assert.match(src, /periodoAtivo = "hoje"/);
assert.match(src, /\.in\("reserva_id", ids\)/);
assert.doesNotMatch(src, /op-sidebar-collapse/);
assert.match(src, /\.gte\("check_in_previsto", range\.from\)/);
assert.match(src, /\.lte\("check_in_previsto", range\.to\)/);
assert.match(src, /op-period-apply/);
assert.match(src, /applyCustomPeriodAndReload/);
assert.match(src, /Datas customizadas só disparam consulta no botão Aplicar/);
assert.doesNotMatch(src, /#op-period-from"\)\?\.addEventListener\("change"/);
// Não truncar este_mês / 7dias em "hoje"
assert.match(src, /to: endOfMonthYmd\(today\)/);
assert.match(src, /to: addDaysYmd\(today, 6\)/);
assert.doesNotMatch(
  src,
  /periodo === "este_mes"[\s\S]{0,120}to: today/,
);

// 06:30 Campo Grande = 10:30 UTC (UTC-4)
{
  const now = new Date("2026-08-12T10:30:00.000Z");
  assert.equal(resolveOperationalTodayYmd(now), "2026-08-11");
}
// 07:00 Campo Grande = 11:00 UTC
{
  const now = new Date("2026-08-12T11:00:00.000Z");
  assert.equal(resolveOperationalTodayYmd(now), "2026-08-12");
}
{
  const now = new Date("2026-08-12T15:00:00.000Z"); // 11:00 local → hoje=12
  assert.deepEqual(resolvePeriodRangeYmd("ontem", { now }), {
    from: "2026-08-11",
    to: "2026-08-11",
  });
  assert.deepEqual(resolvePeriodRangeYmd("hoje", { now }), {
    from: "2026-08-12",
    to: "2026-08-12",
  });
  assert.deepEqual(resolvePeriodRangeYmd("7dias", { now }), {
    from: "2026-08-12",
    to: "2026-08-18",
  });
  assert.deepEqual(resolvePeriodRangeYmd("este_mes", { now }), {
    from: "2026-08-01",
    to: "2026-08-31",
  });
  assert.deepEqual(
    resolvePeriodRangeYmd("periodo", { now, fromYmd: "2026-08-20", toYmd: "2026-08-10" }),
    { from: "2026-08-10", to: "2026-08-20" },
  );
}

// Regressão E2E: reserva 12/08 + comissionada 14/08
{
  const now = new Date("2026-08-12T15:00:00.000Z"); // operacional 12/08
  const r12 = {
    checkIn: "2026-08-12",
    classificacao: "nao_comissionada",
  };
  const r14 = {
    checkIn: "2026-08-14",
    classificacao: "comissionada",
  };

  const hoje = resolvePeriodRangeYmd("hoje", { now });
  assert.equal(inRange(r12.checkIn, hoje), true);
  assert.equal(inRange(r14.checkIn, hoje), false);

  const sete = resolvePeriodRangeYmd("7dias", { now });
  assert.equal(inRange(r12.checkIn, sete), true);
  assert.equal(inRange(r14.checkIn, sete), true);

  const mes = resolvePeriodRangeYmd("este_mes", { now });
  assert.equal(inRange(r12.checkIn, mes), true);
  assert.equal(inRange(r14.checkIn, mes), true);
  // Classificação não entra no range (existência da linha).
  assert.equal(r14.classificacao, "comissionada");

  const custom = resolvePeriodRangeYmd("periodo", {
    now,
    fromYmd: "2026-08-14",
    toYmd: "2026-08-15",
  });
  assert.equal(inRange(r12.checkIn, custom), false);
  assert.equal(inRange(r14.checkIn, custom), true);
}

// Fevereiro não-bissexto / mês com 30 dias
assert.equal(endOfMonthYmd("2026-02-10"), "2026-02-28");
assert.equal(endOfMonthYmd("2026-04-01"), "2026-04-30");
assert.equal(endOfMonthYmd("2026-08-12"), "2026-08-31");

const html = readFileSync(resolve("ui/checkin-operacional-mvp.html"), "utf8");
assert.match(html, /option value="hoje" selected/);
assert.doesNotMatch(html, /op-sidebar-collapse/);
assert.match(html, /id="op-period-apply"/);
assert.match(html, /value="ontem"/);
assert.match(html, /value="7dias"/);
assert.match(html, /value="este_mes"/);
assert.match(html, /value="periodo"/);

console.log("ok: test-checkin-operational-period");
void createContext;
void runInContext;
