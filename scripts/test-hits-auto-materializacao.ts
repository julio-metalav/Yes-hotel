/**
 * Testes: materialização automática de reservas HITS (helper compartilhado +
 * gancho na Edge hits-reservations-preview + UI). Sem rede, sem banco: cliente
 * Supabase falso em memória. Prova: cria uma vez, não duplica reserva nem
 * hóspede, não toca FNRH, não envia nada, não escreve no HITS.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  materializarReservaSincronizada,
  type SupabaseAdminLike,
} from "../src/lib/integrations/hits/hits-materializar";
import type { SyncedReservation } from "../src/lib/domain/yes-hotel/synced-reservation";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Banco falso: só as duas tabelas que a materialização pode tocar. */
function fakeDb() {
  const reservas: Array<Record<string, unknown>> = [];
  const hospedes: Array<Record<string, unknown>> = [];
  const writes: Array<{ table: string; op: string; payload?: unknown }> = [];
  let seq = 0;
  const uuid = () => `uuid-${++seq}`;

  function query(table: string) {
    const rows = table === "operacional_reservas" ? reservas : table === "operacional_hospedes" ? hospedes : null;
    if (!rows) throw new Error("tabela inesperada: " + table);
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Record<string, unknown> | null = null;
    let single = false;
    const q: Record<string, unknown> = {};
    const self = () => q;
    q.select = () => { if (mode === "select") mode = "select"; return q; };
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
        if (table === "operacional_reservas") {
          const dup = reservas.find((r) => r.origem_externa === p.origem_externa && r.external_reservation_id === p.external_reservation_id);
          if (dup) { out = { data: null, error: { code: "23505" } }; writes.push({ table, op: "insert_dup" }); }
          else { const row = { id: uuid(), pagamento_status: "pendente", reservation_balance_due: null, ...p }; reservas.push(row); writes.push({ table, op: "insert", payload: p }); out = { data: single ? { id: row.id } : [{ id: row.id }], error: null }; }
        } else {
          const row = { id: uuid(), ...p }; hospedes.push(row); writes.push({ table, op: "insert", payload: p }); out = { data: null, error: null };
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
  return { admin, reservas, hospedes, writes };
}

function synced(patch: Partial<SyncedReservation> = {}): SyncedReservation {
  return {
    provider: "hits",
    externalReservationId: "3489",
    sourceUpdatedAt: null,
    syncedAt: null,
    reservationStatus: "ativa",
    checkIn: "2026-09-24",
    checkOut: "2026-09-25",
    apartmentCode: "09",
    mainGuestName: "Wemerson",
    guests: [
      { externalGuestId: "G1", name: "Wemerson", isPrincipal: true, isMinor: null, phone: "+55 67 9", email: "" },
      { externalGuestId: "G2", name: "Vitória", isPrincipal: false, isMinor: null, phone: "", email: "" },
    ],
    adults: null,
    minors: null,
    totalGuests: 2,
    mealPlanDesc: "Café da Manhã",
    paymentStatus: "pago",
    phone: "+55 67 9",
    email: null,
    channelManager: null,
    salesChannel: null,
    billingEntity: null,
    reservationChannelId: null,
    reservationBalanceDue: 0,
    reservationTotalAmount: 500,
    classificacaoComissionamento: "nao_comissionada",
    rawSanitized: {},
    ...patch,
  } as SyncedReservation;
}

async function main() {
  console.log("\n== A. Materialização (helper compartilhado) ==");
  {
    // 1–3: snapshot tem 3489, banco não tem → cria exatamente uma reserva.
    const db = fakeDb();
    const r1 = await materializarReservaSincronizada({ admin: db.admin, externalId: "3489", synced: synced() });
    assert.equal(r1.ok, true);
    if (r1.ok) {
      assert.equal(r1.reserva_criada, true);
      assert.equal(r1.hospedes_total, 2);
      assert.equal(r1.ocupacao.posicoes_criadas, 0, "2 PAX com idEntity cobrem a ocupação declarada 2");
      assert.equal(r1.financeiro.pagamento_status, "pago");
    }
    assert.equal(db.reservas.length, 1);
    assert.equal(db.reservas[0]!.external_reservation_id, "3489");
    assert.equal(db.reservas[0]!.origem_externa, "hits");
    assert.equal(db.reservas[0]!.apartamento, "09");
    assert.equal(db.reservas[0]!.pagamento_status, "pago", "saldo 0 → pago (regra do domínio)");
    assert.equal(db.reservas[0]!.reservation_balance_due, 0);
    assert.equal(db.hospedes.length, 2);
    ok("reserva nova no snapshot e ausente no banco → exatamente 1 reserva + hóspedes do HITS");

    // 4–5: nova execução não duplica reserva nem hóspedes.
    const antesW = db.writes.length;
    const r2 = await materializarReservaSincronizada({ admin: db.admin, externalId: "3489", synced: synced() });
    assert.equal(r2.ok && r2.reserva_criada, false);
    assert.equal(db.reservas.length, 1);
    assert.equal(db.hospedes.length, 2);
    assert.equal(db.writes.slice(antesW).filter((w) => w.op === "insert").length, 0, "segunda execução não insere nada");
    ok("execução repetida é inerte: reserva e hóspedes não duplicam");

    // 6: FNRH/cadastro existente intocados — nenhum update em hóspedes; o único update
    // possível é o backfill financeiro, e só quando reservation_balance_due é null.
    assert.equal(db.writes.filter((w) => w.table === "operacional_hospedes" && w.op === "update").length, 0);
    const upd = db.writes.filter((w) => w.table === "operacional_reservas" && w.op === "update");
    assert.equal(upd.length, 1, "1 tentativa de backfill (guardada por saldo nulo)");
    assert.deepEqual(Object.keys(upd[0]!.payload as object).sort(), [
      "classificacao_comissionamento", "classificacao_comissionamento_origem",
      "pagamento_status", "reservation_balance_due", "reservation_total_amount",
    ]);
    assert.equal(db.reservas[0]!.hospede_principal, "Wemerson", "cadastro não sobrescrito");
    ok("FNRH/hóspedes existentes não são sobrescritos; update só financeiro e guardado");

    // Corrida: reserva criada por outro processo entre find e insert → reusa (23505).
    const db2 = fakeDb();
    db2.reservas.push({ id: "uuid-x", origem_externa: "hits", external_reservation_id: "3485", reservation_balance_due: null, pagamento_status: "pendente" });
    const r3 = await materializarReservaSincronizada({ admin: db2.admin, externalId: "3485", synced: synced({ externalReservationId: "3485", apartmentCode: "07" }) });
    assert.equal(r3.ok && r3.reserva_criada, false);
    assert.equal(db2.reservas.length, 1);
    if (r3.ok) assert.equal(r3.financeiro.backfilled, true, "materializada antes do financeiro → backfill único");
    assert.equal(db2.reservas[0]!.pagamento_status, "pago");
    ok("reserva já existente é reusada e recebe backfill financeiro uma vez (3485: saldo 0 → pago)");

    // Sem datas no HITS: recusa, não chuta.
    const r4 = await materializarReservaSincronizada({ admin: fakeDb().admin, externalId: "9", synced: synced({ checkIn: "", checkOut: "" }) });
    assert.equal(r4.ok, false);
    if (!r4.ok) assert.equal(r4.error, "reserva_sem_datas_no_hits");
    ok("sem datas no HITS a materialização falha em vez de inventar data");
  }

  console.log("\n== 7–8. Nenhum envio, nenhum write HITS ==");
  {
    const helper = stripComments(read("src/lib/integrations/hits/hits-materializar.ts"));
    for (const proibido of ["fetch(", "send-fnrh-links", "send-senha", "send-whatsapp", "digisac", "resend", "backendEnviarLinks", "notify-fnrh", "functions/v1", "/v1/guests", "method: \"POST\"", "method: \"PUT\"", "method: \"PATCH\"", "method: \"DELETE\""]) {
      assert.equal(helper.toLowerCase().includes(proibido.toLowerCase()), false, `helper não pode conter ${proibido}`);
    }
    assert.doesNotMatch(helper, /\.from\("fnrh_hospedes"\)/, "ficha é do trigger");
    const tabelas = [...new Set([...helper.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(tabelas, ["operacional_hospedes", "operacional_reservas"]);
    ok("helper: sem rede, sem envio, sem HITS; só operacional_reservas/operacional_hospedes");

    const edge = stripComments(read("supabase/functions/hits-reservations-preview/index.ts"));
    assert.match(edge, /HITS_AUTO_MATERIALIZAR_ENABLED/);
    assert.match(edge, /HITS_AUTO_MATERIALIZAR_MAX_POR_CICLO = 20/);
    assert.match(edge, /if \(autoMaterializarEnabled && run\.snapshot\.persisted\)/, "só após snapshot gravado e só com a trava");
    assert.match(edge, /materializarNovasDoCiclo\(admin\.admin, result\.rows, detalhes\)/);
    assert.match(edge, /\.filter\(\(r\) => r\.status_reserva !== "cancelada"\)/, "só ativas");
    assert.match(edge, /\.from\("operacional_reservas"\)\s*\.select\("external_reservation_id"\)/, "existência por SELECT");
    assert.doesNotMatch(edge, /\.from\("operacional_reservas"\)\s*\.(insert|update|delete|upsert)\(/, "Edge não escreve direto");
    assert.match(edge, /onDetail/);
    assert.doesNotMatch(edge, /send-fnrh-links|send-senha|digisac|resend|notify-fnrh/i);
    const fetches = edge.match(/await fetch\(/g) ?? [];
    assert.equal(fetches.length, 0, "a Edge de preview não faz fetch direto (a leitura é o leitor cadenciado)");
    ok("Edge preview: gancho só com trava, só ativas, detalhe reaproveitado (zero GET extra), sem envio");

    const leitor = stripComments(read("src/lib/integrations/hits/hits-gateway-read.ts"));
    assert.match(leitor, /input\.onDetail\(id, synced\)/);
    assert.match(leitor, /onDetail\?: \(externalId: string, synced: SyncedReservation\) => void/);
    ok("leitor expõe onDetail sem mudar resultado, cadência ou orçamento");
  }

  console.log("\n== B. UI (Check-in Operacional) ==");
  {
    const src = read("ui/checkin-operacional-mvp.js");
    assert.match(src, /const HITS_MATERIALIZACAO_AUTOMATICA_ATIVA = (true|false);/);
    assert.match(src, /if \(HITS_MATERIALIZACAO_AUTOMATICA_ATIVA\) \{\s*return \{ texto: "Sincronizando com o HITS", destaque: false, cta: null \};/);
    assert.match(src, /HITS_MATERIALIZACAO_AUTOMATICA_ATIVA \? "Sincronizando com o HITS" : "Preparar FNRH"/);
    // 9: reserva materializada = linha local normal → "Ver" abre (openDetail não é bloqueado para local).
    const openDetail = src.slice(src.indexOf("function openDetail("), src.indexOf("function openDetail(") + 600);
    assert.match(openDetail, /isReservaSomenteLeituraHits/, "só a só-HITS é bloqueada no detalhe");
    // 10–11: com o automático ativo, a só-HITS vira estado transitório sem CTA — sem quebrar (texto neutro).
    assert.match(src, /async function acaoPrepararFnrhHits/, "contingência manual permanece no código");
    assert.doesNotMatch(src, /backendEnviarLinks\([^)]*\)\s*;?\s*\/\/\s*auto/i, "nenhum envio automático introduzido");
    ok("UI: com o automático ativo, 'Preparar FNRH' deixa de ser o caminho normal; 'Ver' segue para a materializada");
  }

  console.log(`\nOK test-hits-auto-materializacao (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
