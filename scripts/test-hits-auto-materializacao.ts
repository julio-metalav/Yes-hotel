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

/**
 * Banco falso: as duas tabelas que a materialização pode escrever e a
 * fnrh_hospedes (só lida). Um "trigger" falso reproduz
 * operacional_hospedes_criar_fnrh: todo hóspede inserido ganha ficha
 * 'pendente' com link_token.
 */
function fakeDb() {
  const reservas: Array<Record<string, unknown>> = [];
  const hospedes: Array<Record<string, unknown>> = [];
  const fichas: Array<Record<string, unknown>> = [];
  const writes: Array<{ table: string; op: string; payload?: unknown }> = [];
  let seq = 0;
  const uuid = () => `uuid-${++seq}`;

  function query(table: string) {
    const rows = table === "operacional_reservas" ? reservas : table === "operacional_hospedes" ? hospedes : table === "fnrh_hospedes" ? fichas : null;
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
          if (table !== "operacional_hospedes") { out = { data: null, error: { code: "42501" } }; writes.push({ table, op: "insert", payload: p }); }
          else {
            const row = { id: uuid(), ...p }; hospedes.push(row); writes.push({ table, op: "insert", payload: p });
            fichas.push({ id: uuid(), reserva_id: p.reserva_id, hospede_id: row.id, status: "pendente", fnrh_lifecycle_status: null, link_token: "tok-" + row.id });
            out = { data: null, error: null };
          }
        }
      } else if (mode === "update") {
        if (table === "fnrh_hospedes") { writes.push({ table, op: "update", payload }); out = { data: null, error: { code: "42501" } }; return Promise.resolve(out).then(res, rej); }
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
    assert.doesNotMatch(helper, /\.from\("fnrh_hospedes"\)\s*\.(insert|update|upsert|delete)/, "ficha é do trigger: nunca escrita aqui");
    const tabelas = [...new Set([...helper.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(tabelas, ["fnrh_hospedes", "operacional_hospedes", "operacional_reservas"]);
    const escritas = [...new Set([...helper.matchAll(/\.from\("([a-z_]+)"\)\s*\.(insert|update|upsert|delete)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(escritas, ["operacional_hospedes", "operacional_reservas"], "escrita só nas duas tabelas operacionais");
    assert.doesNotMatch(helper, /\.delete\(/, "nada é apagado");
    ok("helper: sem rede, sem envio, sem HITS; escreve só operacional_reservas/operacional_hospedes; fnrh_hospedes só lida");

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

  console.log("\n== C. 3407: PAX HITS adota a posição técnica (ocupação não dobra) ==");
  {
    const guest4244 = { externalGuestId: "4244", name: "Hóspede 3407", isPrincipal: true, isMinor: null, phone: "", email: "" };
    const s3407 = (guests: SyncedReservation["guests"]) =>
      synced({ externalReservationId: "3407", apartmentCode: "12", mainGuestName: "", totalGuests: 1, guests, reservationBalanceDue: 0 });
    const ativos = (db: ReturnType<typeof fakeDb>) => db.hospedes.filter((h) => !h.removed_from_reservation);
    const insertsHospede = (db: ReturnType<typeof fakeDb>, desde = 0) =>
      db.writes.slice(desde).filter((w) => w.table === "operacional_hospedes" && w.op === "insert").length;
    const escritasFicha = (db: ReturnType<typeof fakeDb>) => db.writes.filter((w) => w.table === "fnrh_hospedes").length;

    // Rodada 1 — como aconteceu em PROD: detalhe HITS ainda sem entidade de
    // hóspede (guests=[]) e pax=1 → o passo 4 cria 1 posição técnica.
    const db = fakeDb();
    const r1 = await materializarReservaSincronizada({ admin: db.admin, externalId: "3407", synced: s3407([]) });
    assert.equal(r1.ok, true);
    if (r1.ok) {
      assert.equal(r1.hospedes_total, 0);
      assert.deepEqual(r1.ocupacao, { declarada_hits: 1, hospedes_ativos: 0, posicoes_criadas: 1, posicoes_adotadas: 0, posicoes_ambiguas: 0 });
    }
    assert.equal(ativos(db).length, 1);
    const posicao = db.hospedes[0]!;
    assert.equal(posicao.nome, "Novo hóspede");
    assert.equal(posicao.pms_external_guest_id, undefined);
    const fichaAntes = { ...db.fichas.find((f) => f.hospede_id === posicao.id)! };
    assert.equal(fichaAntes.status, "pendente");
    ok("3407 rodada 1 (HITS sem PAX): 1 posição técnica 'Novo hóspede' + ficha 'pendente' do trigger");

    // Rodada 2 — HITS passou a ter o PAX 4244 (principal, pax=1).
    // ANTES da correção: lookup só por pms_external_guest_id → 2ª linha
    // inserida → 2 ativos, "FNRH 0/2". DEPOIS: a posição técnica é adotada.
    const w1 = db.writes.length;
    const r2 = await materializarReservaSincronizada({ admin: db.admin, externalId: "3407", synced: s3407([guest4244]) });
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.deepEqual(r2.hospedes, [{ id_entity: "4244", criado: false, posicao_adotada: true }]);
      assert.deepEqual(r2.ocupacao, { declarada_hits: 1, hospedes_ativos: 1, posicoes_criadas: 0, posicoes_adotadas: 1, posicoes_ambiguas: 0 });
      assert.equal(r2.reserva_criada, false);
    }
    assert.equal(ativos(db).length, 1, "INVARIANTE: totalGuests=1 + 1 PAX HITS → exatamente 1 hóspede ativo");
    assert.equal(db.hospedes.length, 1, "nenhuma segunda linha");
    const adotado = ativos(db)[0]!;
    assert.equal(adotado.id, posicao.id, "é a MESMA linha (mesmo id → mesma ficha/link_token)");
    assert.equal(adotado.pms_external_guest_id, "4244");
    assert.equal(adotado.nome, "Hóspede 3407");
    assert.equal(adotado.principal, true);
    assert.equal(adotado.status_operacional, "aguardando_contato", "sem contato no HITS → aguardando_contato (nada 'pronto_para_envio' inventado)");
    assert.equal(adotado.origem_cadastro, "existente_incompleto");
    assert.equal(adotado.modo_coleta_fnrh, "preenchimento_completo", "campo da posição preservado");
    assert.equal(insertsHospede(db, w1), 0, "rodada 2 não insere hóspede");
    assert.deepEqual(db.fichas.find((f) => f.hospede_id === posicao.id), fichaAntes, "fnrh_hospedes/link_token intocados");
    assert.equal(escritasFicha(db), 0, "zero escritas em fnrh_hospedes");
    assert.equal(db.fichas.length, 1, "nenhuma ficha nova");
    const upd = db.writes.filter((w) => w.table === "operacional_hospedes" && w.op === "update");
    assert.equal(upd.length, 1);
    assert.deepEqual(Object.keys(upd[0]!.payload as object).sort(), ["email", "nome", "origem_cadastro", "pms_external_guest_id", "principal", "status_operacional", "whatsapp"], "só identificação: nada de lifecycle/auditoria/ficha");
    ok("3407 rodada 2 (PAX 4244 apareceu): posição adotada → 1 ativo com pms_external_guest_id=4244, ficha e link_token preservados, zero insert");

    // Rodada 3 — inerte.
    const w2 = db.writes.length;
    const r3 = await materializarReservaSincronizada({ admin: db.admin, externalId: "3407", synced: s3407([guest4244]) });
    if (r3.ok) assert.deepEqual(r3.hospedes, [{ id_entity: "4244", criado: false, posicao_adotada: false }]);
    assert.equal(db.writes.slice(w2).filter((w) => w.table === "operacional_hospedes").length, 0);
    assert.equal(ativos(db).length, 1);
    ok("3407 rodada 3: repetição é inerte (hóspede 4244 reusado, nada escrito)");

    // Estado que PROD tem HOJE (posição + linha 4244 já criada pela versão
    // anterior): a correção NÃO reconcilia retroativamente — não apaga, não
    // funde. Corrigir 3407 em PROD é ação explícita do operador.
    const dbProd = fakeDb();
    dbProd.reservas.push({ id: "res-3407", origem_externa: "hits", external_reservation_id: "3407", reservation_balance_due: 0, pagamento_status: "pago" });
    dbProd.hospedes.push({ id: "h-pos", reserva_id: "res-3407", nome: "Novo hóspede", principal: false, status_operacional: "nao_identificado", origem_cadastro: "novo", email: "", whatsapp: "" });
    dbProd.hospedes.push({ id: "h-4244", reserva_id: "res-3407", nome: "Hóspede 3407", principal: true, status_operacional: "aguardando_contato", origem_cadastro: "existente_incompleto", pms_external_guest_id: "4244", email: "", whatsapp: "" });
    const rp = await materializarReservaSincronizada({ admin: dbProd.admin, externalId: "3407", synced: s3407([guest4244]) });
    assert.equal(rp.ok, true);
    assert.equal(dbProd.writes.filter((w) => w.table === "operacional_hospedes").length, 0);
    assert.equal(ativos(dbProd).length, 2);
    ok("estado atual de PROD (posição + 4244 já inserida) não é alterado automaticamente: sem apagar, sem fundir");

    // Pessoa real sem idEntity (nome preenchido) NUNCA é fundida com o PAX.
    const dbReal = fakeDb();
    dbReal.reservas.push({ id: "res-a", origem_externa: "hits", external_reservation_id: "3407", reservation_balance_due: 0 });
    dbReal.hospedes.push({ id: "h-maria", reserva_id: "res-a", nome: "Maria Silva", principal: false, status_operacional: "nao_identificado", origem_cadastro: "novo", email: "", whatsapp: "" });
    const rr = await materializarReservaSincronizada({ admin: dbReal.admin, externalId: "3407", synced: s3407([guest4244]) });
    if (rr.ok) assert.deepEqual(rr.hospedes, [{ id_entity: "4244", criado: true, posicao_adotada: false }]);
    assert.equal(dbReal.hospedes.find((h) => h.id === "h-maria")!.nome, "Maria Silva");
    assert.equal(dbReal.hospedes.find((h) => h.id === "h-maria")!.pms_external_guest_id, undefined);
    assert.equal(dbReal.hospedes.length, 2);
    ok("hóspede real sem idEntity (nome preenchido) não é fundido: PAX HITS é inserido à parte");

    // Posição com contato preenchido, ficha tocada (rascunho / lifecycle), ou removida: não é adotada.
    const desqualificadas: Array<[string, Record<string, unknown>, Partial<Record<string, unknown>>]> = [
      ["contato preenchido", { whatsapp: "+55 67 9" }, {}],
      ["principal=true", { principal: true }, {}],
      ["origem != novo", { origem_cadastro: "existente_incompleto" }, {}],
      ["removida da reserva", { removed_from_reservation: true }, {}],
      ["ficha em rascunho", {}, { status: "rascunho" }],
      ["ficha confirmada", {}, { status: "confirmado_hospede" }],
      ["lifecycle completed", {}, { fnrh_lifecycle_status: "completed" }],
      ["lifecycle draft", {}, { fnrh_lifecycle_status: "draft" }],
      ["lifecycle waived", {}, { fnrh_lifecycle_status: "waived" }],
    ];
    for (const [motivo, patchHospede, patchFicha] of desqualificadas) {
      const d = fakeDb();
      d.reservas.push({ id: "res-b", origem_externa: "hits", external_reservation_id: "3407", reservation_balance_due: 0 });
      d.hospedes.push({ id: "h-pos", reserva_id: "res-b", nome: "Novo hóspede", principal: false, status_operacional: "nao_identificado", origem_cadastro: "novo", email: "", whatsapp: "", ...patchHospede });
      d.fichas.push({ id: "f-pos", reserva_id: "res-b", hospede_id: "h-pos", status: "pendente", fnrh_lifecycle_status: null, link_token: "tok-pos", ...patchFicha });
      const antes = JSON.stringify([d.hospedes[0], d.fichas[0]]);
      const rd = await materializarReservaSincronizada({ admin: d.admin, externalId: "3407", synced: s3407([guest4244]) });
      assert.equal(rd.ok, true, motivo);
      if (rd.ok) assert.equal(rd.hospedes[0]!.posicao_adotada, false, motivo);
      assert.equal(JSON.stringify([d.hospedes[0], d.fichas[0]]), antes, motivo + ": linha e ficha intocadas");
      assert.equal(d.hospedes.filter((h) => h.pms_external_guest_id === "4244").length, 1, motivo + ": PAX inserido à parte");
      assert.equal(escritasFicha(d), 0, motivo);
    }
    ok("posição desqualificada (contato, principal, origem, removida, ficha rascunho/confirmada/lifecycle) nunca é adotada");

    // Duas posições técnicas → ambíguo: nenhuma é escolhida.
    const dbAmb = fakeDb();
    dbAmb.reservas.push({ id: "res-c", origem_externa: "hits", external_reservation_id: "3407", reservation_balance_due: 0 });
    for (const id of ["h-p1", "h-p2"]) {
      dbAmb.hospedes.push({ id, reserva_id: "res-c", nome: "Novo hóspede", principal: false, status_operacional: "nao_identificado", origem_cadastro: "novo", email: "", whatsapp: "" });
    }
    const ra = await materializarReservaSincronizada({ admin: dbAmb.admin, externalId: "3407", synced: s3407([guest4244]) });
    assert.equal(ra.ok, true);
    if (ra.ok) {
      assert.deepEqual(ra.hospedes, [{ id_entity: "4244", criado: true, posicao_adotada: false }]);
      assert.equal(ra.ocupacao.posicoes_ambiguas, 2);
      assert.equal(ra.ocupacao.posicoes_adotadas, 0);
    }
    assert.equal(dbAmb.hospedes.filter((h) => h.nome === "Novo hóspede" && h.pms_external_guest_id === undefined).length, 2, "as duas posições continuam como estavam");
    assert.equal(dbAmb.writes.filter((w) => w.table === "operacional_hospedes" && w.op === "update").length, 0);
    ok("duas posições técnicas = ambíguo: nenhuma adotada, PAX inserido, diagnóstico posicoes_ambiguas=2");

    // 2 PAX HITS chegando sobre 1 posição: o 1º adota, o 2º é inserido → 2 ativos (não 3).
    const dbDois = fakeDb();
    const rA = await materializarReservaSincronizada({ admin: dbDois.admin, externalId: "3407", synced: s3407([guest4244]) });
    assert.equal(rA.ok, true);
    // simula pax=2 desde o início com 1 PAX → 1 posição técnica
    const dbP = fakeDb();
    await materializarReservaSincronizada({ admin: dbP.admin, externalId: "3407", synced: synced({ externalReservationId: "3407", totalGuests: 2, guests: [guest4244] }) });
    assert.equal(ativos(dbP).length, 2, "PAX 4244 + 1 posição");
    const rB = await materializarReservaSincronizada({ admin: dbP.admin, externalId: "3407", synced: synced({ externalReservationId: "3407", totalGuests: 2, guests: [guest4244, { externalGuestId: "4245", name: "Acompanhante", isPrincipal: false, isMinor: null, phone: "", email: "" }] }) });
    if (rB.ok) assert.deepEqual(rB.hospedes.map((h) => [h.id_entity, h.posicao_adotada]), [["4244", false], ["4245", true]]);
    assert.equal(ativos(dbP).length, 2, "2 PAX + posição adotada = 2 ativos, não 3");
    assert.equal(dbP.hospedes.filter((h) => h.pms_external_guest_id === "4245")[0]!.principal, false);
    ok("2º PAX que aparece depois adota a única posição restante: ocupação fecha em 2, não 3");
  }

  console.log("\n== D. FNRH concluída: nenhum sinal HITS inventado ==");
  {
    // Não existe no contrato HITS disponível campo que afirme "FNRH concluída".
    // Prova negativa: nenhum dos três pontos de escrita deriva confirmação de
    // FNRH de status da reserva (3 = check-in), de rooms[].status ou de
    // qualquer outro campo HITS. status_operacional/lifecycle "confirmado"
    // continuam sendo exclusivos do fnrh-submit.
    const fontes = {
      helper: stripComments(read("src/lib/integrations/hits/hits-materializar.ts")),
      edgeMaterializar: stripComments(read("supabase/functions/hits-reserva-materializar/index.ts")),
      edgePreview: stripComments(read("supabase/functions/hits-reservations-preview/index.ts")),
    };
    for (const [nome, src] of Object.entries(fontes)) {
      assert.doesNotMatch(src, /status\s*===?\s*3\b/, nome + ": sem 'status === 3'");
      assert.doesNotMatch(src, /"confirmado(_hospede|_hotel)?"/, nome + ": não grava 'confirmado'");
      assert.doesNotMatch(src, /(manually_)?completed"/, nome + ": não grava lifecycle completed");
      assert.doesNotMatch(src, /fnrh_lifecycle_status\s*:/, nome + ": não escreve lifecycle");
      assert.doesNotMatch(src, /fnrh_status_agregado\s*:/, nome + ": não escreve agregado");
      assert.doesNotMatch(src, /check_?in_?realizado|checkInRealizado|webCheckIn|fnrhConcluida|fnrh_concluida/i, nome + ": sem atalho 'check-in realizado'");
    }
    const contrato = read("docs/YES_HOTEL_CONTRATO_TECNICO_HITS_V1.md");
    assert.match(contrato, /o papel exato da API HITS no processo equivalente a FNRH ainda esta em aberto/);
    ok("nenhum dos pontos de escrita infere FNRH concluída de status HITS (3), rooms[].status ou 'check-in realizado'; contrato §11.3 confirma o vazio");
  }

  console.log("\n== B. UI (Check-in Operacional) ==");
  {
    const src = read("ui/checkin-operacional-mvp.js");
    // Sem feature flag na UI: só-snapshot é SEMPRE estado transitório.
    assert.doesNotMatch(src, /HITS_MATERIALIZACAO_AUTOMATICA_ATIVA/);
    assert.match(src, /if \(isReservaSomenteLeituraHits\(reserva\)\) \{\s*return \{ texto: "Sincronizando com o HITS", destaque: false, cta: null \};/);
    assert.match(src, /if \(isConsultaSomenteNoHits\(reserva\)\) return "Sincronizando com o HITS";/);
    assert.doesNotMatch(src, /cta: \{ kind: "preparar_fnrh"/, "'Preparar FNRH' não é mais CTA da linha");
    // 9: reserva materializada = linha local normal → "Ver" abre (openDetail não é bloqueado para local).
    const openDetail = src.slice(src.indexOf("function openDetail("), src.indexOf("function openDetail(") + 600);
    assert.match(openDetail, /isReservaSomenteLeituraHits/, "só a só-HITS é bloqueada no detalhe");
    // 10–11: com o automático ativo, a só-HITS vira estado transitório sem CTA — sem quebrar (texto neutro).
    assert.match(src, /async function acaoPrepararFnrhHits/, "contingência manual permanece no código");
    assert.doesNotMatch(src, /backendEnviarLinks\([^)]*\)\s*;?\s*\/\/\s*auto/i, "nenhum envio automático introduzido");
    ok("UI: só-snapshot é transitório ('Sincronizando com o HITS', sem CTA); contingência manual só interna; 'Ver' segue para a materializada");
  }

  console.log(`\nOK test-hits-auto-materializacao (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
