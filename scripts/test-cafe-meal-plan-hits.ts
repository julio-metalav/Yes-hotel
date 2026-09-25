/**
 * Café da manhã — `rooms[].mealPlanDesc` do HITS até a previsão na tela.
 *
 * Cobre a cadeia inteira: homologação do valor → linha do leitor → snapshot →
 * materialização/reconciliação → RPC do universo → direito → KPIs e filtros.
 * Sem rede, sem banco: cliente Supabase falso e leitura do SQL versionado.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAFE_MEAL_PLAN_HOMOLOGADO,
  classifyMealPlanDesc,
  normalizeMealPlanDesc,
} from "../src/lib/domain/yes-hotel/cafe-meal-plan.ts";
import { resolveCafeBreakfastEntitlementFromHits } from "../src/lib/domain/yes-hotel/cafe-breakfast-entitlement.ts";
import { summarizeCafeKpis } from "../src/lib/domain/yes-hotel/cafe-attendance-policy.ts";
import {
  HITS_SNAPSHOT_CAMPOS_FUNCIONAIS,
  toSnapshotRows,
} from "../src/lib/integrations/hits/hits-snapshot-sync.ts";
import { toHitsSandboxRow } from "../src/lib/integrations/hits/hits-gateway-read.ts";
import {
  materializarReservaSincronizada,
  reconciliarPlanoRefeicaoDaReserva,
  type SupabaseAdminLike,
} from "../src/lib/integrations/hits/hits-materializar.ts";
import { normalizeHitsDetailToSynced } from "../src/lib/integrations/hits/normalize-hits-detail-to-synced.ts";
import type { SyncedReservation } from "../src/lib/domain/yes-hotel/synced-reservation.ts";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const migration = (sufixo: string) => {
  const f = readdirSync(join(ROOT, "supabase/migrations")).filter((x) => x.endsWith(sufixo));
  assert.equal(f.length, 1, "esperava 1 migration " + sufixo);
  return read("supabase/migrations/" + f[0]!);
};

const INCLUIDO = "Café da Manhã";
const SEM = "Nenhum";

function fakeDb() {
  const reservas: Array<Record<string, unknown>> = [];
  const hospedes: Array<Record<string, unknown>> = [];
  const fichas: Array<Record<string, unknown>> = [];
  const writes: Array<{ table: string; op: string; payload?: unknown }> = [];
  let seq = 0;
  function query(table: string) {
    const rows =
      table === "operacional_reservas" ? reservas
        : table === "operacional_hospedes" ? hospedes
          : table === "fnrh_hospedes" ? fichas
            : null;
    if (!rows) throw new Error("tabela inesperada: " + table);
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Record<string, unknown> | null = null;
    let single = false;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; };
    q.is = (k: string, v: unknown) => { filters.push((r) => r[k] == v); return q; };
    q.in = (k: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[k])); return q; };
    q.or = () => { filters.push((r) => !r.removed_from_reservation); return q; };
    q.maybeSingle = () => { single = true; return q; };
    q.single = () => { single = true; return q; };
    q.insert = (p: Record<string, unknown>) => { mode = "insert"; payload = p; return q; };
    q.update = (p: Record<string, unknown>) => { mode = "update"; payload = p; return q; };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      let out: { data: unknown; error: unknown };
      if (mode === "insert") {
        const p = payload!;
        const row = { id: `uuid-${++seq}`, ...p };
        if (table === "operacional_reservas") {
          reservas.push({ pagamento_status: "pendente", reservation_balance_due: null, ...row });
          writes.push({ table, op: "insert", payload: p });
          out = { data: single ? { id: row.id } : [{ id: row.id }], error: null };
        } else if (table === "operacional_hospedes") {
          hospedes.push(row);
          writes.push({ table, op: "insert", payload: p });
          fichas.push({ id: `f-${seq}`, reserva_id: p.reserva_id, hospede_id: row.id, status: "pendente", fnrh_lifecycle_status: null });
          out = { data: null, error: null };
        } else {
          writes.push({ table, op: "insert", payload: p });
          out = { data: null, error: { code: "42501" } };
        }
      } else if (mode === "update") {
        const alvo = rows.filter((r) => filters.every((f) => f(r)));
        alvo.forEach((r) => Object.assign(r, payload));
        writes.push({ table, op: "update", payload });
        out = { data: alvo.map((r) => ({ id: r.id })), error: null };
      } else {
        const found = rows.filter((r) => filters.every((f) => f(r)));
        out = { data: single ? (found[0] ?? null) : found, error: null };
      }
      return Promise.resolve(out).then(res, rej);
    };
    return q;
  }
  const admin: SupabaseAdminLike = { from: (t: string) => query(t) };
  return { admin, reservas, hospedes, fichas, writes };
}

function synced(patch: Partial<SyncedReservation> = {}): SyncedReservation {
  return {
    provider: "hits",
    externalReservationId: "3407",
    sourceUpdatedAt: null,
    syncedAt: null,
    reservationStatus: "ativa",
    checkIn: "2026-09-24",
    checkOut: "2026-09-26",
    apartmentCode: "02",
    mainGuestName: "Anon",
    guests: [{ externalGuestId: "4272", name: "Anon", isPrincipal: true, isMinor: null, phone: null, email: null }],
    adults: null,
    minors: null,
    totalGuests: 2,
    mealPlanDesc: INCLUIDO,
    paymentStatus: "pago",
    phone: null,
    email: null,
    channelManager: null,
    salesChannel: null,
    billingEntity: null,
    reservationChannelId: null,
    reservationBalanceDue: 0,
    reservationTotalAmount: 100,
    classificacaoComissionamento: "nao_comissionada",
    rawSanitized: {},
    ...patch,
  } as SyncedReservation;
}

const card = (id: string, mealPlanDesc: string | null, guestCount: number, attendedQty: number) => ({
  reservationId: id,
  apartmentCode: id,
  mainGuestName: "Anon " + id,
  entitlement: resolveCafeBreakfastEntitlementFromHits({ guestCount, mealPlanDesc }),
  attendedQty,
});

async function main() {
  console.log("\n== 1–4. Homologação do mealPlanDesc (lista fechada) ==");
  {
    assert.equal(classifyMealPlanDesc(INCLUIDO), "incluido");
    assert.equal(classifyMealPlanDesc("CAFÉ DA MANHÃ"), "incluido", "caixa não importa");
    assert.equal(classifyMealPlanDesc("  cafe   da manha  "), "incluido", "acento e espaços não importam");
    ok("1. \"Café da Manhã\" (real no HITS) → incluido");

    assert.equal(classifyMealPlanDesc(SEM), "sem_cafe");
    assert.equal(classifyMealPlanDesc("nenhum"), "sem_cafe");
    ok("2. \"Nenhum\" (real no HITS) → sem_cafe");

    assert.equal(classifyMealPlanDesc(null), "nao_mapeado");
    assert.equal(classifyMealPlanDesc(undefined), "nao_mapeado");
    assert.equal(classifyMealPlanDesc(""), "nao_mapeado");
    assert.equal(classifyMealPlanDesc("   "), "nao_mapeado");
    ok("3. null / vazio → nao_mapeado (ausência NUNCA vira \"sem café\")");

    for (const desconhecido of ["Meia pensão", "Café + almoço", "Pensão completa", "cafe", "Breakfast", "Sem café"]) {
      assert.equal(classifyMealPlanDesc(desconhecido), "nao_mapeado", desconhecido);
    }
    assert.equal(CAFE_MEAL_PLAN_HOMOLOGADO.length, 2, "lista fechada: só os dois valores observados");
    ok("4. string desconhecida → nao_mapeado; sem heurística por substring (\"Café + almoço\" não entra)");

    assert.equal(normalizeMealPlanDesc("Café  da   Manhã "), "cafe da manha");
  }

  console.log("\n== 5–7. Direito = população declarada pelo HITS ==");
  {
    const inc2 = resolveCafeBreakfastEntitlementFromHits({ guestCount: 2, mealPlanDesc: INCLUIDO });
    assert.equal(inc2.kind, "incluido");
    assert.equal(inc2.entitledQty, 2);
    assert.equal(inc2.guestCount, 2);
    assert.equal(inc2.mealPlanDesc, INCLUIDO, "texto bruto preservado");
    ok("5. incluído com 2 hóspedes → previstos 2");

    const sem2 = resolveCafeBreakfastEntitlementFromHits({ guestCount: 2, mealPlanDesc: SEM });
    assert.equal(sem2.kind, "sem_cafe");
    assert.equal(sem2.entitledQty, 0);
    assert.equal(sem2.guestCount, 2, "população continua visível");
    ok("6. sem café com 2 hóspedes → previstos 0");

    const nm = resolveCafeBreakfastEntitlementFromHits({ guestCount: 2, mealPlanDesc: "Plano X" });
    assert.equal(nm.kind, "nao_mapeado");
    assert.equal(nm.entitledQty, 0);
    assert.ok(nm.mappingGapReason, "não identificado explica o porquê");
    ok("7. não identificado → previstos 0, com motivo");

    const avulso = resolveCafeBreakfastEntitlementFromHits({ guestCount: 2, mealPlanDesc: SEM, paidExtraQtyFromHits: 1 });
    assert.equal(avulso.kind, "avulso_pago");
    assert.equal(avulso.entitledQty, 1, "avulso só com quantidade oficial");
  }

  console.log("\n== 8–11. Cadeia: leitor → snapshot → materialização ==");
  {
    // Leitor carrega o texto bruto.
    const linha = toHitsSandboxRow(synced({ mealPlanDesc: INCLUIDO }), "hospedada");
    assert.equal(linha.meal_plan_desc, INCLUIDO);
    const [snapRow] = toSnapshotRows([linha]);
    assert.equal(snapRow!.meal_plan_desc, INCLUIDO, "allowlist do snapshot leva o plano");
    assert.equal(toSnapshotRows([toHitsSandboxRow(synced({ mealPlanDesc: null }))])[0]!.meal_plan_desc, null);
    ok("10. o plano percorre leitor → linha do snapshot (full e incremental usam o mesmo mapeamento)");

    // 8. Snapshot-only: a RPC do universo prefere o snapshot, então classifica
    //    mesmo sem materialização.
    const sqlCafe = migration("_cafe_meal_plan_hits.sql");
    assert.match(
      sqlCafe,
      /coalesce\(nullif\(btrim\(s\.meal_plan_desc\), ''\), r\.meal_plan_desc\) as meal_plan_desc/,
      "universo do café: snapshot primeiro, local como fallback",
    );
    assert.match(sqlCafe, /left join public\.operacional_reservas r/, "snapshot-only continua aparecendo");
    assert.match(sqlCafe, /s\.check_in < p_data_cafe\s*\n\s*and s\.check_out >= p_data_cafe/, "21. população do dia inalterada");
    ok("8. reserva só no snapshot é classificada (plano vem do snapshot; local é fallback)");

    // 11. Só o plano mudar já conta como alteração funcional.
    assert.ok(
      (HITS_SNAPSHOT_CAMPOS_FUNCIONAIS as readonly string[]).includes("meal_plan_desc"),
      "meal_plan_desc é campo funcional",
    );
    const cteChanged = sqlCafe.slice(sqlCafe.indexOf("changed as ("), sqlCafe.indexOf("ins as ("));
    assert.match(cteChanged, /s\.meal_plan_desc is distinct from d\.meal_plan_desc/);
    assert.equal((sqlCafe.match(/s\.meal_plan_desc is distinct from d\.meal_plan_desc/g) ?? []).length, 2, "nas duas RPCs");
    ok("11. alteração só do mealPlanDesc conta em changed_count (completa e incremental)");

    // 9. Materialização nova grava o plano e a população oficial.
    const db = fakeDb();
    const r = await materializarReservaSincronizada({ admin: db.admin, externalId: "3407", synced: synced() });
    assert.equal(r.ok, true);
    assert.equal(db.reservas[0]!.meal_plan_desc, INCLUIDO);
    assert.equal(db.reservas[0]!.total_hospedes_hits, 2);
    ok("9. reserva materializada nasce com meal_plan_desc e total_hospedes_hits do HITS");

    // Reconciliação: plano mudou no HITS depois da materialização.
    const db2 = fakeDb();
    db2.reservas.push({
      id: "res-1", origem_externa: "hits", external_reservation_id: "3407",
      meal_plan_desc: SEM, total_hospedes_hits: 2, pagamento_status: "pago", reservation_balance_due: 0,
    });
    const rec = await reconciliarPlanoRefeicaoDaReserva({ admin: db2.admin, externalId: "3407", synced: synced() });
    assert.equal(rec.atualizado, true);
    assert.equal(db2.reservas[0]!.meal_plan_desc, INCLUIDO);
    assert.equal(db2.reservas[0]!.pagamento_status, "pago", "20. financeiro intocado");
    const patch = db2.writes.find((w) => w.op === "update")!.payload as Record<string, unknown>;
    assert.deepEqual(Object.keys(patch).sort(), ["meal_plan_desc"], "só o plano mudou");
    // Idempotente: rodar de novo não escreve.
    const antes = db2.writes.length;
    const rec2 = await reconciliarPlanoRefeicaoDaReserva({ admin: db2.admin, externalId: "3407", synced: synced() });
    assert.equal(rec2.atualizado, false);
    assert.equal(db2.writes.length, antes, "22. nada reescrito; nenhuma duplicidade");
    assert.equal(db2.reservas.length, 1);
    assert.equal(db2.hospedes.length, 0, "reconciliação de plano não cria hóspede");
    ok("reconciliação traz o plano novo do HITS, só esse campo, e é idempotente");
  }

  console.log("\n== 12–14. Tela: filtros, totais e faltantes ==");
  {
    const cards = [
      card("01", INCLUIDO, 2, 1),
      card("02", INCLUIDO, 1, 0),
      card("03", SEM, 1, 0),
      card("04", null, 3, 2),
    ];
    const kpis = summarizeCafeKpis(cards);
    assert.equal(kpis.apartments, 4, "21. universo do dia = todos os apartamentos");
    assert.equal(kpis.expectedGuests, 3, "13. previstos = 2 + 1 (só incluído/avulso)");
    assert.equal(kpis.attendedGuests, 3, "atendidos contam mesmo sem direito (2 do não identificado)");
    assert.equal(kpis.missingGuests, 0, "14. faltantes nunca negativo");
    assert.equal(kpis.withBreakfast, 2);
    assert.equal(kpis.withoutBreakfast, 1);
    assert.equal(kpis.unknownPlan, 1);
    ok("13–14. totais do topo corretos; faltantes com piso 0; composição 2 com café · 1 sem · 1 não identificado");

    // 12. Filtros separados, na UI e no HTML.
    const js = read("ui/cafe-da-manha-mvp.js");
    assert.match(js, /activeFilter === "no_breakfast".*kind === "sem_cafe"/s);
    assert.match(js, /activeFilter === "unknown".*kind === "nao_mapeado"/s);
    assert.doesNotMatch(js, /activeFilter === "unpaid"/, "filtro combinado não existe mais");
    const html = read("ui/cafe-da-manha-mvp.html");
    assert.match(html, /data-filter="no_breakfast"[^>]*>Sem café</);
    assert.match(html, /data-filter="unknown"[^>]*>Não identificado</);
    assert.match(html, /data-filter="paid"[^>]*>Com café</);
    assert.doesNotMatch(html, /Sem café \/ não identificado/);
    // Contagem nos filtros e composição no card de apartamentos.
    assert.match(js, /com café · .*sem café · .*não identificados/);
    ok("12. filtros Com café / Sem café / Não identificado separados, com contagem");

    // Situação explícita por apartamento (badge).
    const policy = read("ui/yes-cafe-policy.js");
    for (const rotulo of ["Café incluso", "Sem café", "Não identificado"]) {
      assert.ok(policy.includes(rotulo), "badge de situação: " + rotulo);
    }
    ok("badge de situação explícito para incluso / sem café / não identificado");
  }

  console.log("\n== 15–22. Contador manual, escopo e segurança ==");
  {
    const sqlCafe = migration("_cafe_meal_plan_hits.sql");
    const sqlControle = migration("_cafe_controle_operacional.sql");
    // 15–16: o contador manual segue independente do direito.
    assert.match(sqlControle, /v_next := v_prev \+ 1;/, "15–16. increment sem teto pelo direito");
    assert.doesNotMatch(sqlCafe.replace(/^\s*--.*$/gm, ""), /quantidade_atendida <= quantidade_direito/, "teto não volta");
    assert.doesNotMatch(sqlCafe.replace(/^\s*--.*$/gm, ""), /operacional_cafe_set_atendimento/, "RPC de atendimento intocada");
    ok("15–16. contador manual continua independente do direito; o teto não volta");

    // 17. Marcar todos continua exigindo direito real.
    assert.match(sqlControle, /cafe_write_forbidden_no_entitlement/);
    const policy = read("ui/yes-cafe-policy.js");
    assert.match(policy, /function canMarkAllCafeAttendance/);
    ok("17. \"Marcar todos\" ignora sem_cafe/nao_mapeado (UI e RPC)");

    // 18. O atendimento continua vindo do banco na carga.
    assert.match(read("ui/cafe-da-manha-mvp.js"), /\.from\("operacional_cafe_atendimentos"\)/);
    ok("18. reload preserva atendimentos (carga lê do banco)");

    // 19–20. Nenhuma escrita HITS/FNRH/financeiro/senha/TAG na cadeia nova.
    const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const mealPlan = semComentarios(read("src/lib/domain/yes-hotel/cafe-meal-plan.ts"));
    for (const proibido of ["fetch(", "supabase", "fnrh", "senha", "pagarme"]) {
      assert.equal(mealPlan.toLowerCase().includes(proibido), false, "módulo puro não toca " + proibido);
    }
    const sqlCode = sqlCafe.replace(/^\s*--.*$/gm, "");
    assert.doesNotMatch(sqlCode, /fnrh|senha|pagarme|ttlock/i, "19–20. migration não toca FNRH/senha/pagamento");
    assert.doesNotMatch(sqlCode, /drop table|truncate|delete from public\.operacional/i, "nada é apagado");
    assert.match(sqlCode, /add column if not exists meal_plan_desc text/, "snapshot: coluna aditiva");
    // A RPC de listagem mexe em operacional_reservas só por LEITURA (left join).
    assert.doesNotMatch(sqlCode, /update public\.operacional_reservas|insert into public\.operacional_reservas/i);
    ok("19–20. zero escrita HITS, FNRH, financeiro, senha ou TAG na cadeia do plano");

    // Grants e RLS preservados.
    assert.match(sqlCafe, /grant execute on function public\.operacional_cafe_listar_hospedagens\(date\)\s*\n?\s*to authenticated;/);
    assert.match(sqlCafe, /revoke all on function public\.operacional_cafe_resolve_entitlement\(text, integer, integer\)/);
    assert.match(sqlCafe, /security definer/);
    assert.match(sqlCafe, /set search_path = ''/);
    ok("grants, security definer e search_path preservados");
  }

  console.log(`\nOK test-cafe-meal-plan-hits (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
