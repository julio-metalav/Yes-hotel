/**
 * Testes: Café da manhã sob o universo HITS.
 *  - RPC operacional_cafe_listar_hospedagens (migration): população vem do
 *    snapshot HITS, enriquecida pelo banco; regra de data check_in < D <= check_out;
 *    universo indisponível → erro explícito (nunca população local antiga).
 *  - Regra de data executada de verdade pela policy do café (mesma do SQL).
 *  - UI do café: id sintético para reserva ainda só no HITS; atendimento só
 *    para reserva materializada; entitlement intocado.
 * Sem rede, sem banco.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const sqlCodeOf = (sql: string) => sql.replace(/^\s*--.*$/gm, "");

function loadPolicy() {
  const src = read("ui/yes-cafe-policy.js");
  const sandbox: Record<string, unknown> = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const key = Object.keys(sandbox).find((k) => /cafe/i.test(k) && k !== "window" && k !== "globalThis" && k !== "console");
  assert.ok(key, "policy do café deve expor um objeto global");
  return sandbox[key!] as {
    selectCafeStaysForDate: (rows: unknown[], ymd: string) => Array<{ id: string }>;
  };
}

function main() {
  console.log("\n== Migration: RPC do café governada pelo snapshot HITS ==");
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith("_cafe_universo_hits.sql"));
  assert.equal(files.length, 1, "exatamente 1 migration nova do café");
  const sql = read(join("supabase/migrations", files[0]!));
  const code = sqlCodeOf(sql);
  {
    assert.match(code, /create or replace function public\.operacional_cafe_listar_hospedagens\(p_data_cafe date\)/);
    assert.equal((code.match(/create or replace function/g) ?? []).length, 1, "só a RPC do café");
    assert.doesNotMatch(code, /create table|drop table|alter table|delete from|update |truncate|insert into/i, "nada além do CREATE OR REPLACE");
    assert.doesNotMatch(code, /operacional_cafe_atendimentos/, "atendimentos intocados");
    assert.match(code, /security definer/);
    assert.match(code, /set search_path = ''/);
    assert.match(code, /public\.is_yes_hotel_cafe_reader\(\)/);
    ok("migration mínima: 1 CREATE OR REPLACE, sem tabela/dados/atendimentos, mesmo gate de perfil");

    // 12–13: população = snapshot; local só enriquece (LEFT JOIN por external_reservation_id).
    assert.match(code, /from public\.hits_reservas_snapshot s\s*left join public\.operacional_reservas r\s*on r\.external_reservation_id = s\.external_reservation_id/);
    assert.match(code, /and r\.origem_externa = 'hits'/);
    assert.doesNotMatch(code, /from public\.operacional_reservas r\s*where/, "nunca parte do banco local");
    ok("universo = hits_reservas_snapshot; operacional_reservas só por LEFT JOIN (fantasma local fora)");

    // 14–16: regra de data no SQL: check_in < D e check_out >= D, nas datas do snapshot.
    assert.match(code, /and s\.check_in < p_data_cafe\s*and s\.check_out >= p_data_cafe/);
    assert.match(code, /s\.check_in as check_in_previsto/);
    assert.match(code, /s\.check_out as check_out_previsto/);
    assert.match(code, /s\.apartamento as apartment_code/);
    ok("regra exata: check_in < D <= check_out, com datas e apartamento do HITS");

    // 17: cancelada/ausente do snapshot não entra.
    assert.match(code, /where s\.status_reserva <> 'cancelada'/);
    ok("cancelada no snapshot não entra; ausente do snapshot não existe para o café");

    // 19: snapshot indisponível → erro explícito, não população antiga.
    assert.match(code, /from public\.hits_snapshot_sync_state s/);
    assert.match(code, /v_last_success is null or v_last_success < now\(\) - interval '6 hours'/);
    assert.match(code, /raise exception 'Universo HITS indisponível/);
    ok("sem sucesso recente do snapshot (6 h) → exceção explícita; nada de dados locais antigos");

    // 23: entitlement intocado: meal_plan_desc continua sendo o campo local, sem regra nova.
    assert.match(code, /r\.meal_plan_desc,/);
    assert.doesNotMatch(code, /cafe_kind|quantidade_direito|mealPlanDesc|Café da Manhã/i);
    ok("entitlement do café intocado (meal_plan_desc passa como antes; sem cafe_kind/quantidade_direito)");
  }

  console.log("\n== Regra de data executada (policy do café, mesma do SQL) ==");
  {
    const policy = loadPolicy();
    const D = "2026-09-25";
    const rows = [
      { id: "a", checkInYmd: "2026-09-24", checkOutYmd: "2026-09-26", statusReserva: "ativa" }, // dormiu 24→25
      { id: "b", checkInYmd: "2026-09-25", checkOutYmd: "2026-09-27", statusReserva: "ativa" }, // chega em D
      { id: "c", checkInYmd: "2026-09-23", checkOutYmd: "2026-09-25", statusReserva: "ativa" }, // sai em D
      { id: "d", checkInYmd: "2026-09-20", checkOutYmd: "2026-09-24", statusReserva: "ativa" }, // já saiu
      { id: "e", checkInYmd: "2026-09-24", checkOutYmd: "2026-09-26", statusReserva: "cancelada" },
    ];
    const ids = policy.selectCafeStaysForDate(rows, D).map((r) => r.id).sort();
    assert.deepEqual(ids, ["a", "c"]);
    ok("check_in < D e check_out >= D: entra quem dormiu 24→25 e quem sai em D; chegada em D e cancelada ficam fora");
  }

  console.log("\n== UI do café ==");
  {
    const js = read("ui/cafe-da-manha-mvp.js");
    assert.match(js, /id: r\.reservation_id \|\| "hits:" \+ String\(r\.external_reservation_id \|\| ""\)/);
    assert.match(js, /__somenteHits: !r\.reservation_id/);
    assert.match(js, /const ids = enriched\.filter\(\(r\) => !r\.__somenteHits\)\.map\(\(r\) => r\.id\);/);
    assert.match(js, /indexOf\("hits:"\) === 0/, "atendimento não é gravado para reserva ainda só no HITS");
    ok("reserva só no snapshot entra na lista com id sintético e sem gravação de atendimento");

    // Nenhuma mudança no direito ao café.
    assert.match(js, /policy\.resolveCafeBreakfastEntitlementFromHits\(\{\s*guestCount: stay\.totalGuests,\s*mealPlanDesc: stay\.mealPlanDesc,\s*\}\)/);
    const policySrc = read("ui/yes-cafe-policy.js");
    const mainSrc = read("ui/checkin-operacional-mvp.js");
    assert.doesNotMatch(js, /p_cafe_kind|p_quantidade_direito/, "UI não envia cafe_kind/quantidade_direito ao servidor");
    assert.match(js, /p_operacional_reserva_id: card\.reservationId,\s*p_acao: action,/, "contrato de gravação inalterado");
    assert.ok(policySrc.includes("function resolveCafeBreakfastEntitlementFromHits"), "policy intocada");
    assert.ok(!/HITS_MATERIALIZACAO_AUTOMATICA_ATIVA/.test(policySrc));
    assert.ok(mainSrc.length > 0);
    ok("resolveCafeBreakfastEntitlementFromHits/mealPlanDesc/cafe_kind/quantidade_direito intocados");

    // Erro da RPC (universo indisponível) vira estado de erro explícito na tela.
    assert.match(js, /if \(errRpc\) throw new Error\(errRpc\.message \|\| "Falha ao carregar reservas\."\);/);
    assert.match(js, /setLoadState\(\s*"error",\s*error\?\.message/);
    ok("universo indisponível → mensagem de erro na tela, cards vazios (sem população antiga)");
  }

  console.log(`\nOK test-cafe-universo-hits (${cases} casos)`);
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
