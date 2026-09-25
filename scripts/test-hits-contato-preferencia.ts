/**
 * Contato do hóspede HITS → Yes pelo CELULAR OFICIAL.
 *
 * Contrato (Swagger https://api.hitspms.net/swagger/v1/swagger.json):
 * `ReservationDetailGuestDto` (detalhe da reserva) tem só contactPhone/
 * contactMail; `GuestRevenueDto` (GET /Datashare/RevenueManagement/Guests,
 * gateway `GET /v1/guests?EntityId=…`) tem contactCellPhone. O Yes usa o guest
 * master para o WhatsApp e cai no detalhe apenas como fallback.
 *
 * Cobre: contrato (1–5), reserva nova (6), reconciliação de existente (7–12),
 * enriquecimento direcionado/rate limit (13–16) e regressões (17–22).
 * Sem rede, sem banco: cliente Supabase falso e fetch falso.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aplicarContatoOficialNaReserva,
  classificarTelefoneBr,
  contatoOficialDoGuestRevenue,
  decidirEmailExistente,
  decidirWhatsappExistente,
  precisaGuestMaster,
  selecionarGuestRevenuePorEntityId,
} from "../src/lib/integrations/hits/hits-contato.ts";
import {
  executarCicloContatoEMaterializacao,
  planejarEnriquecimentoContato,
} from "../src/lib/integrations/hits/hits-contato-sync.ts";
import { normalizeHitsDetailToSynced } from "../src/lib/integrations/hits/normalize-hits-detail-to-synced.ts";
import { fetchHitsGuestRevenues } from "../src/lib/integrations/hits/hits-gateway-read.ts";
import type { SupabaseAdminLike } from "../src/lib/integrations/hits/hits-materializar.ts";
import type { SyncedReservation } from "../src/lib/domain/yes-hotel/synced-reservation.ts";
import type { HitsGuestRevenue } from "../src/lib/integrations/hits/types.ts";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}
const ROOT = process.cwd();
const lerFixture = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as Record<string, unknown>;
/** Comentários citam os envios proibidos de propósito; as guardas olham o CÓDIGO. */
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

const FIXO = "+55 (67) 3321-4567";
const CEL = "+55 (67) 99123-4567";
const CEL_OUTRO = "(67) 98888-0000";
const EMAIL = "hospede.exemplo@example.com";
const ID_ENTITY = "4272";
const EXTERNO = "3490";

/** Banco falso: só as tabelas que a materialização/reconciliação podem tocar. */
function fakeDb() {
  const reservas: Array<Record<string, unknown>> = [];
  const hospedes: Array<Record<string, unknown>> = [];
  const fichas: Array<Record<string, unknown>> = [];
  const writes: Array<{ table: string; op: string; payload?: unknown }> = [];
  let seq = 0;
  const uuid = () => `uuid-${++seq}`;

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
        if (table === "operacional_reservas") {
          const row = { id: uuid(), pagamento_status: "pendente", reservation_balance_due: null, ...p };
          reservas.push(row); writes.push({ table, op: "insert", payload: p });
          out = { data: single ? { id: row.id } : [{ id: row.id }], error: null };
        } else if (table === "operacional_hospedes") {
          const row = { id: uuid(), ...p };
          hospedes.push(row); writes.push({ table, op: "insert", payload: p });
          fichas.push({ id: uuid(), reserva_id: p.reserva_id, hospede_id: row.id, status: "pendente", fnrh_lifecycle_status: null, link_token: "tok-" + row.id });
          out = { data: null, error: null };
        } else {
          writes.push({ table, op: "insert", payload: p });
          out = { data: null, error: { code: "42501" } };
        }
      } else if (mode === "update") {
        if (table === "fnrh_hospedes") {
          writes.push({ table, op: "update", payload });
          return Promise.resolve({ data: null, error: { code: "42501" } }).then(res, rej);
        }
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

const guestRevenue = (patch: Partial<HitsGuestRevenue> = {}): HitsGuestRevenue => ({
  entityId: Number(ID_ENTITY),
  name: "Hóspede Exemplo",
  contactMail: EMAIL,
  contactPhone: FIXO,
  contactCellPhone: CEL,
  ...patch,
});

/** Detalhe real (fixture) já normalizado: PAX 4272 com FIXO e sem e-mail. */
function syncedDoDetalhe(): SyncedReservation {
  return normalizeHitsDetailToSynced(lerFixture("fixtures/hits-contato-fixo-celular-detail.json"), null);
}

async function main() {
  console.log("\n== 1–5. Contrato oficial: celular vem do GuestRevenueDto ==");
  {
    // 1. contactPhone fixo + contactCellPhone celular → celular.
    const c1 = contatoOficialDoGuestRevenue(guestRevenue());
    assert.equal(c1.phone, CEL, "celular oficial vence o telefone");
    assert.equal(c1.origem_telefone, "celular");
    ok("1. contactPhone=fixo + contactCellPhone=celular → Yes escolhe o celular");

    // 2. sem celular → fallback para contactPhone.
    const c2 = contatoOficialDoGuestRevenue(guestRevenue({ contactCellPhone: "" }));
    assert.equal(c2.phone, FIXO);
    assert.equal(c2.origem_telefone, "telefone", "fallback declarado (não autoriza trocar fixo local)");
    assert.equal(contatoOficialDoGuestRevenue(guestRevenue({ contactCellPhone: null, contactPhone: null })).phone, null);
    ok("2. contactCellPhone vazio + contactPhone presente → usa o telefone como fallback");

    // 3. celular + e-mail.
    const c3 = contatoOficialDoGuestRevenue(guestRevenue());
    assert.equal(c3.phone, CEL);
    assert.equal(c3.email, EMAIL);
    const s3 = aplicarContatoOficialNaReserva(syncedDoDetalhe(), new Map([[ID_ENTITY, guestRevenue()]]));
    assert.equal(s3.guests[0]!.phone, CEL, "whatsapp = celular");
    assert.equal(s3.guests[0]!.email, EMAIL, "email = contactMail");
    assert.equal(s3.guests[0]!.phoneSource, "cell");
    assert.equal(s3.phone, CEL, "contato da reserva acompanha o principal");
    ok("3. contactCellPhone + contactMail → whatsapp = celular e email = contactMail");

    // 4. sem guest master → fallback do detalhe, sem inventar nada.
    const s4 = aplicarContatoOficialNaReserva(syncedDoDetalhe(), new Map());
    assert.equal(s4.guests[0]!.phone, FIXO, "mantém contactPhone do ReservationDetailGuestDto");
    assert.equal(s4.guests[0]!.email, null);
    assert.equal(s4.guests[0]!.phoneSource, undefined, "sem procedência declarada");
    ok("4. ReservationDetailGuestDto sem guest master → fallback contactPhone/contactMail");

    // 5. entityId EXATO, mesmo com vários registros no retorno.
    const lista = (lerFixture("fixtures/hits-contato-guest-revenue.json").data ?? []) as HitsGuestRevenue[];
    assert.equal(lista.length, 2);
    const exato = selecionarGuestRevenuePorEntityId(lista, ID_ENTITY);
    assert.equal(String(exato?.entityId), ID_ENTITY);
    assert.equal(exato?.contactCellPhone, CEL);
    assert.equal(selecionarGuestRevenuePorEntityId(lista, "9999"), null, "id ausente → null, nunca 'o primeiro'");
    assert.equal(selecionarGuestRevenuePorEntityId(lista, ""), null);
    assert.equal(String(selecionarGuestRevenuePorEntityId(lista, "4273")?.entityId), "4273");
    ok("5. seleção por entityId EXATO: retorno com vários registros nunca escolhe outro");
  }

  console.log("\n== 6. Reserva nova nasce com o celular oficial ==");
  {
    const db = fakeDb();
    const chamadas: string[][] = [];
    const out = await executarCicloContatoEMaterializacao({
      admin: db.admin,
      rows: [{ external_reservation_id: EXTERNO, status_reserva: "ativa" }],
      detalhes: new Map([[EXTERNO, syncedDoDetalhe()]]),
      maxLookups: 10,
      buscarGuestRevenues: async (ids) => {
        chamadas.push(ids);
        return { porEntityId: new Map([[ID_ENTITY, guestRevenue()]]), lidos: 1, falhas: 0, ignorados_teto: 0, parou_por: "fim" };
      },
    });
    assert.equal(out.criadas, 1);
    assert.deepEqual(chamadas, [[ID_ENTITY]], "consulta só o PAX da reserva nova");
    assert.equal(out.enriquecimento.solicitados, 1);
    const hospede = db.hospedes[0]!;
    assert.equal(hospede.pms_external_guest_id, ID_ENTITY);
    assert.equal(hospede.whatsapp, CEL, "nasce com o CELULAR, não com o fixo");
    assert.equal(hospede.email, EMAIL);
    assert.equal(hospede.status_operacional, "pronto_para_envio");
    assert.equal(db.reservas.length, 1);
    ok("6. materialização de reserva nova grava o celular oficial e o e-mail do guest master");
  }

  console.log("\n== 7–12. Reserva já materializada: reconciliação de contato ==");
  {
    function dbCom(hospede: Record<string, unknown>, ficha: Record<string, unknown> = {}) {
      const db = fakeDb();
      db.reservas.push({ id: "res-3490", origem_externa: "hits", external_reservation_id: EXTERNO, reservation_balance_due: 0, pagamento_status: "pago" });
      db.hospedes.push({ id: "h-4272", reserva_id: "res-3490", nome: "Hóspede Exemplo", principal: true, status_operacional: "aguardando_contato", origem_cadastro: "existente_incompleto", pms_external_guest_id: ID_ENTITY, email: "", whatsapp: "", ...hospede });
      db.fichas.push({ id: "f-4272", reserva_id: "res-3490", hospede_id: "h-4272", status: "pendente", fnrh_lifecycle_status: null, link_token: "tok-4272", ...ficha });
      return db;
    }
    const rodar = async (db: ReturnType<typeof fakeDb>, master: HitsGuestRevenue | null) => {
      const chamadas: string[][] = [];
      const out = await executarCicloContatoEMaterializacao({
        admin: db.admin,
        rows: [{ external_reservation_id: EXTERNO, status_reserva: "ativa" }],
        detalhes: new Map([[EXTERNO, syncedDoDetalhe()]]),
        maxLookups: 10,
        buscarGuestRevenues: async (ids) => {
          chamadas.push(ids);
          return {
            porEntityId: master ? new Map([[ID_ENTITY, master]]) : new Map(),
            lidos: master ? 1 : 0, falhas: master ? 0 : 1, ignorados_teto: 0, parou_por: "fim",
          };
        },
      });
      return { out, chamadas };
    };
    const updatesHospede = (db: ReturnType<typeof fakeDb>) => db.writes.filter((w) => w.table === "operacional_hospedes" && w.op === "update");

    // 7. local vazio + celular oficial → preenche.
    {
      const db = dbCom({ whatsapp: "", email: "" });
      const { out } = await rodar(db, guestRevenue());
      assert.equal(out.criadas, 0, "reserva já existe: nada é criado");
      assert.equal(out.reconciliacao.contatos_atualizados, 1);
      assert.equal(db.hospedes[0]!.whatsapp, CEL);
      assert.equal(db.hospedes[0]!.email, EMAIL);
      assert.deepEqual(Object.keys(updatesHospede(db)[0]!.payload as object).sort(), ["email", "whatsapp"], "update só de contato");
      assert.equal(db.writes.filter((w) => w.op === "insert").length, 0);
      ok("7. WhatsApp local vazio + contactCellPhone → preenchido com o celular oficial");
    }
    // 8. local fixo + celular oficial → substitui (caso real).
    {
      const db = dbCom({ whatsapp: FIXO, email: "" });
      const { out } = await rodar(db, guestRevenue());
      assert.equal(out.reconciliacao.contatos_atualizados, 1);
      assert.equal(db.hospedes[0]!.whatsapp, CEL, "fixo dá lugar ao celular oficial");
      assert.equal(db.hospedes[0]!.email, EMAIL);
      assert.equal(db.hospedes[0]!.nome, "Hóspede Exemplo");
      assert.equal(db.hospedes[0]!.principal, true);
      assert.equal(db.hospedes[0]!.status_operacional, "aguardando_contato", "status não é tocado");
      ok("8. WhatsApp local fixo + contactCellPhone → substituído pelo celular (caso real)");
    }
    // 9. local celular + guest master só com fixo → não rebaixa.
    {
      const db = dbCom({ whatsapp: CEL_OUTRO, email: EMAIL });
      const { out } = await rodar(db, guestRevenue({ contactCellPhone: "" }));
      assert.equal(out.reconciliacao.contatos_atualizados, 0);
      assert.equal(db.hospedes[0]!.whatsapp, CEL_OUTRO);
      assert.equal(updatesHospede(db).length, 0);
      ok("9. WhatsApp local é celular e o HITS só tem fixo → não rebaixa (nenhum update)");
    }
    // 10. e-mail local vazio + contactMail → preenche.
    {
      const db = dbCom({ whatsapp: CEL, email: "" });
      const { out } = await rodar(db, guestRevenue());
      assert.equal(out.reconciliacao.contatos_atualizados, 1);
      assert.deepEqual(Object.keys(updatesHospede(db)[0]!.payload as object), ["email"], "mesmo número → só o e-mail muda");
      assert.equal(db.hospedes[0]!.email, EMAIL);
      ok("10. e-mail local vazio + contactMail → preenchido");
    }
    // 11. e-mail local preenchido → não sobrescreve.
    {
      const db = dbCom({ whatsapp: CEL, email: "outro@example.com" });
      const { out } = await rodar(db, guestRevenue());
      assert.equal(out.reconciliacao.contatos_atualizados, 0);
      assert.equal(db.hospedes[0]!.email, "outro@example.com");
      assert.equal(updatesHospede(db).length, 0);
      ok("11. e-mail local já preenchido → nunca sobrescrito automaticamente");
    }
    // 12. ficha FNRH tocada → nenhum update (e nem consulta ao guest master).
    for (const [motivo, patchFicha] of [
      ["rascunho", { status: "rascunho" }],
      ["confirmada", { status: "confirmado_hospede" }],
      ["lifecycle completed", { fnrh_lifecycle_status: "completed" }],
    ] as const) {
      const db = dbCom({ whatsapp: FIXO, email: "" }, patchFicha);
      const antes = JSON.stringify([db.hospedes[0], db.fichas[0]]);
      const { out, chamadas } = await rodar(db, guestRevenue());
      assert.equal(out.reconciliacao.contatos_atualizados, 0, motivo);
      assert.equal(JSON.stringify([db.hospedes[0], db.fichas[0]]), antes, motivo + ": linha e ficha intocadas");
      assert.deepEqual(chamadas, [], motivo + ": nem consulta o guest master");
      assert.equal(db.writes.filter((w) => w.table === "fnrh_hospedes").length, 0, motivo);
    }
    ok("12. ficha FNRH tocada (rascunho/confirmada/lifecycle) → nenhum update e nenhuma consulta");
  }

  console.log("\n== 13–16. Enriquecimento DIRECIONADO (sem N+1, com teto) ==");
  {
    // 13. quem já tem celular + e-mail não gera lookup.
    assert.equal(precisaGuestMaster({ whatsapp: CEL, email: EMAIL }), false);
    assert.equal(precisaGuestMaster({ whatsapp: "", email: EMAIL }), true, "sem whatsapp");
    assert.equal(precisaGuestMaster({ whatsapp: FIXO, email: EMAIL }), true, "whatsapp não é celular");
    assert.equal(precisaGuestMaster({ whatsapp: CEL, email: "" }), true, "sem e-mail");
    assert.equal(precisaGuestMaster({ whatsapp: "+1 415 555 0100", email: EMAIL }), true, "formato desconhecido pode melhorar");

    const db = fakeDb();
    db.reservas.push({ id: "res-ok", origem_externa: "hits", external_reservation_id: EXTERNO });
    db.hospedes.push({ id: "h-ok", reserva_id: "res-ok", pms_external_guest_id: ID_ENTITY, whatsapp: CEL, email: EMAIL });
    db.fichas.push({ id: "f-ok", reserva_id: "res-ok", hospede_id: "h-ok", status: "pendente", fnrh_lifecycle_status: null });
    const plano = await planejarEnriquecimentoContato({
      admin: db.admin,
      rows: [{ external_reservation_id: EXTERNO, status_reserva: "ativa" }],
      detalhes: new Map([[EXTERNO, syncedDoDetalhe()]]),
      maxLookups: 10,
    });
    assert.deepEqual(plano.entity_ids, [], "hóspede completo não gera consulta");
    assert.deepEqual(plano.novas, []);
    assert.deepEqual(plano.existentes, []);
    ok("13. hóspede que já tem celular + e-mail não gera lookup de guest master");

    // 14. EntityIds repetidos são deduplicados (mesmo PAX em 2 reservas do ciclo).
    const dbDup = fakeDb();
    const detalhes = new Map<string, SyncedReservation>();
    for (const ext of ["3490", "3491"]) {
      const s = syncedDoDetalhe();
      detalhes.set(ext, { ...s, externalReservationId: ext });
    }
    const planoDup = await planejarEnriquecimentoContato({
      admin: dbDup.admin,
      rows: [
        { external_reservation_id: "3490", status_reserva: "ativa" },
        { external_reservation_id: "3491", status_reserva: "ativa" },
      ],
      detalhes,
      maxLookups: 10,
    });
    assert.deepEqual(planoDup.novas, ["3490", "3491"]);
    assert.deepEqual(planoDup.entity_ids, [ID_ENTITY], "o mesmo idEntity em 2 reservas = 1 consulta");
    ok("14. EntityIds repetidos no ciclo são deduplicados antes das chamadas");

    // 15. teto de enrichment corta e reporta o que ficou de fora.
    const dbTeto = fakeDb();
    const muitos = new Map<string, SyncedReservation>();
    const rowsMuitos: Array<{ external_reservation_id: string; status_reserva: string }> = [];
    for (let i = 0; i < 25; i += 1) {
      const ext = String(4000 + i);
      const base = syncedDoDetalhe();
      muitos.set(ext, {
        ...base,
        externalReservationId: ext,
        guests: [{ ...base.guests[0]!, externalGuestId: String(5000 + i) }],
      });
      rowsMuitos.push({ external_reservation_id: ext, status_reserva: "ativa" });
    }
    const planoTeto = await planejarEnriquecimentoContato({
      admin: dbTeto.admin, rows: rowsMuitos, detalhes: muitos, maxLookups: 10,
    });
    assert.equal(planoTeto.entity_ids.length, 10, "teto por ciclo");
    assert.equal(planoTeto.entity_ids_ignorados, 15, "o que sobrou volta no próximo ciclo");
    ok("15. teto de enriquecimento corta a lista e reporta os ignorados");

    // 16. nenhuma consulta indiscriminada: 71 reservas locais e completas → 0 GETs.
    const dbUniverso = fakeDb();
    const universo = new Map<string, SyncedReservation>();
    const rowsUniverso: Array<{ external_reservation_id: string; status_reserva: string }> = [];
    for (let i = 0; i < 71; i += 1) {
      const ext = String(3000 + i);
      const idEnt = String(6000 + i);
      const base = syncedDoDetalhe();
      universo.set(ext, { ...base, externalReservationId: ext, guests: [{ ...base.guests[0]!, externalGuestId: idEnt }] });
      rowsUniverso.push({ external_reservation_id: ext, status_reserva: "ativa" });
      dbUniverso.reservas.push({ id: "r-" + ext, origem_externa: "hits", external_reservation_id: ext });
      dbUniverso.hospedes.push({ id: "h-" + ext, reserva_id: "r-" + ext, pms_external_guest_id: idEnt, whatsapp: CEL, email: EMAIL });
    }
    const chamadas: string[][] = [];
    const outUniverso = await executarCicloContatoEMaterializacao({
      admin: dbUniverso.admin, rows: rowsUniverso, detalhes: universo, maxLookups: 10,
      buscarGuestRevenues: async (ids) => {
        chamadas.push(ids);
        return { porEntityId: new Map(), lidos: 0, falhas: 0, ignorados_teto: 0, parou_por: "fim" };
      },
    });
    assert.deepEqual(chamadas, [], "71 reservas já completas → ZERO GET de guest master");
    assert.equal(outUniverso.enriquecimento.solicitados, 0);
    assert.equal(outUniverso.reconciliacao.reservas, 0);
    assert.equal(dbUniverso.writes.length, 0, "nenhuma escrita");
    ok("16. ciclo com 71 reservas já materializadas e completas não consulta guest master nenhuma vez");

    // Leitor: GET-only, sequencial, cadenciado, teto e id exato.
    const urls: string[] = [];
    let t = 0;
    const fetchImpl = async (url: string, init?: { method?: string }) => {
      urls.push(String(url));
      assert.ok(!init?.method || init.method === "GET", "guest master é somente GET");
      const id = new URL(String(url)).searchParams.get("EntityId");
      return new Response(JSON.stringify({ data: [guestRevenue({ entityId: Number(id) }), guestRevenue({ entityId: 9999 })] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };
    const r = await fetchHitsGuestRevenues({
      config: { baseUrl: "https://gw.test", token: "t".repeat(32), requestTimeoutMs: 5_000, enabled: true, prodReadEnabled: false },
      entityIds: ["4272", "4272", "4273", "4274"],
      fetchImpl: fetchImpl as never,
      sleepImpl: async (ms: number) => { t += ms; },
      nowMs: () => t,
      maxLookups: 2,
    });
    assert.deepEqual(urls, [
      "https://gw.test/v1/guests?EntityId=4272",
      "https://gw.test/v1/guests?EntityId=4273",
    ], "deduplica, respeita o teto e usa /v1/guests?EntityId");
    assert.equal(r.solicitados, 3, "4272 repetido conta uma vez");
    assert.equal(r.lidos, 2);
    assert.equal(r.ignorados_teto, 1);
    assert.equal(r.parou_por, "teto");
    assert.equal(String(r.porEntityId.get("4272")?.entityId), "4272", "nunca o registro de outro entityId");
    assert.ok(t >= 1_100, "cadência mínima entre as duas chamadas respeitada");
    ok("leitor de guest master: GET-only, deduplicado, cadenciado, com teto e seleção por entityId exato");
  }

  console.log("\n== 17–22. Regressões ==");
  {
    // 17. posição técnica segura continua sendo adotada, agora já com o celular.
    const db = fakeDb();
    db.reservas.push({ id: "res-p", origem_externa: "hits", external_reservation_id: EXTERNO, reservation_balance_due: 0 });
    db.hospedes.push({ id: "h-pos", reserva_id: "res-p", nome: "Novo hóspede", principal: false, status_operacional: "nao_identificado", origem_cadastro: "novo", email: "", whatsapp: "" });
    db.fichas.push({ id: "f-pos", reserva_id: "res-p", hospede_id: "h-pos", status: "pendente", fnrh_lifecycle_status: null, link_token: "tok-pos" });
    const { materializarReservaSincronizada } = await import("../src/lib/integrations/hits/hits-materializar.ts");
    const enriquecido = aplicarContatoOficialNaReserva(syncedDoDetalhe(), new Map([[ID_ENTITY, guestRevenue()]]));
    const r17 = await materializarReservaSincronizada({ admin: db.admin, externalId: EXTERNO, synced: enriquecido });
    assert.equal(r17.ok, true);
    if (r17.ok) assert.equal(r17.ocupacao.posicoes_adotadas, 1);
    assert.equal(db.hospedes.length, 1, "posição adotada, não duplicada");
    assert.equal(db.hospedes[0]!.pms_external_guest_id, ID_ENTITY);
    assert.equal(db.hospedes[0]!.whatsapp, CEL);
    ok("17. adoção de posição técnica segura continua funcionando (e já com o celular oficial)");

    // 18. ambiguidade continua bloqueando criação.
    const dbAmb = fakeDb();
    dbAmb.reservas.push({ id: "res-a", origem_externa: "hits", external_reservation_id: EXTERNO, reservation_balance_due: 0 });
    for (const id of ["h-p1", "h-p2"]) {
      dbAmb.hospedes.push({ id, reserva_id: "res-a", nome: "Novo hóspede", principal: false, status_operacional: "nao_identificado", origem_cadastro: "novo", email: "", whatsapp: "" });
    }
    const r18 = await materializarReservaSincronizada({ admin: dbAmb.admin, externalId: EXTERNO, synced: enriquecido });
    assert.equal(r18.ok, true);
    if (r18.ok) {
      assert.equal(r18.ocupacao.posicoes_ambiguas, 2);
      assert.equal(r18.intervencao_manual, true);
    }
    assert.equal(dbAmb.hospedes.length, 2, "nada inserido");
    assert.equal(dbAmb.writes.filter((w) => w.table === "operacional_hospedes").length, 0);
    ok("18. duas posições técnicas: ambiguidade continua bloqueando criação e adoção");

    // 19. financeiro inalterado pelo caminho de contato.
    const dbFin = fakeDb();
    dbFin.reservas.push({ id: "res-f", origem_externa: "hits", external_reservation_id: EXTERNO, reservation_balance_due: 0, pagamento_status: "pago" });
    dbFin.hospedes.push({ id: "h-f", reserva_id: "res-f", pms_external_guest_id: ID_ENTITY, whatsapp: FIXO, email: "" });
    dbFin.fichas.push({ id: "f-f", reserva_id: "res-f", hospede_id: "h-f", status: "pendente", fnrh_lifecycle_status: null });
    await executarCicloContatoEMaterializacao({
      admin: dbFin.admin,
      rows: [{ external_reservation_id: EXTERNO, status_reserva: "ativa" }],
      detalhes: new Map([[EXTERNO, syncedDoDetalhe()]]),
      maxLookups: 10,
      buscarGuestRevenues: async () => ({ porEntityId: new Map([[ID_ENTITY, guestRevenue()]]), lidos: 1, falhas: 0, ignorados_teto: 0, parou_por: "fim" }),
    });
    assert.equal(dbFin.writes.filter((w) => w.table === "operacional_reservas").length, 0, "reconciliação não toca a reserva");
    assert.equal(dbFin.reservas[0]!.pagamento_status, "pago");
    assert.equal(dbFin.hospedes[0]!.whatsapp, CEL);
    ok("19. reconciliação de contato não escreve em operacional_reservas (financeiro intocado)");

    // 20. snapshot/incremental/telemetria fora do caminho.
    const sync = read("src/lib/integrations/hits/hits-contato-sync.ts");
    const contato = read("src/lib/integrations/hits/hits-contato.ts");
    for (const src of [sync, contato]) {
      assert.doesNotMatch(src, /hits_reservas_snapshot|hits_snapshot_sync|last_rows_count|last_changed_count/, "telemetria/snapshot não são tocados");
    }
    const tabelas = [...new Set([...sync.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]))].sort();
    assert.deepEqual(tabelas, ["fnrh_hospedes", "operacional_hospedes", "operacional_reservas"]);
    assert.doesNotMatch(sync, /\.from\("fnrh_hospedes"\)\s*\.(insert|update|upsert|delete)/, "ficha só é lida");
    ok("20. snapshot, incremental e telemetria continuam fora deste caminho");

    // 21–22. nenhuma escrita no HITS, nenhum envio.
    const reader = read("src/lib/integrations/hits/hits-gateway-read.ts");
    const guestFn = reader.slice(reader.indexOf("export async function fetchHitsGuestRevenues"));
    assert.match(guestFn, /method: "GET"/);
    assert.doesNotMatch(guestFn, /method: "(POST|PUT|PATCH|DELETE)"/, "guest master é somente leitura");
    const edgePreview = read("supabase/functions/hits-reservations-preview/index.ts");
    const edgeMaterializar = read("supabase/functions/hits-reserva-materializar/index.ts");
    const materializar = read("src/lib/integrations/hits/hits-materializar.ts");
    for (const [nome, bruto] of [["sync", sync], ["contato", contato], ["materializar", materializar], ["preview", edgePreview], ["materializar-edge", edgeMaterializar]] as const) {
      const src = semComentarios(bruto);
      for (const proibido of ["send-fnrh-links", "send-senha", "send-whatsapp", "digisac", "resend", "notify-fnrh", "backendEnviarLinks"]) {
        assert.equal(src.toLowerCase().includes(proibido.toLowerCase()), false, `${nome} não pode conter ${proibido}`);
      }
      assert.doesNotMatch(src, /method: "(POST|PUT|PATCH|DELETE)"/, `${nome}: nenhuma escrita HTTP`);
      assert.doesNotMatch(src, /\/v1\/guests"[^)]*method/i, `${nome}: /v1/guests só por GET`);
    }
    assert.doesNotMatch(sync, /fetch\(/, "módulo de ciclo não faz rede: recebe o leitor injetado");
    assert.doesNotMatch(contato, /fetch\(/, "módulo de contato é puro");
    assert.doesNotMatch(materializar, /fetch\(/, "helper de banco continua sem rede");
    ok("21–22. HITS writes = 0 (só GET /v1/guests) e nenhum envio em nenhum dos módulos/Edges");
  }

  console.log("\n== Proteção do dado local (regras de substituição) ==");
  {
    assert.equal(decidirWhatsappExistente("", CEL, true), CEL);
    assert.equal(decidirWhatsappExistente(FIXO, CEL, true), CEL, "celular oficial substitui fixo");
    assert.equal(decidirWhatsappExistente(FIXO, FIXO, false), null, "mesmo número → no-op");
    assert.equal(decidirWhatsappExistente(FIXO, "(67) 3322-0000", false), null, "fixo → outro fixo: não mexe");
    assert.equal(decidirWhatsappExistente(CEL, FIXO, false), null, "celular nunca rebaixa");
    assert.equal(decidirWhatsappExistente(CEL, CEL_OUTRO, true), null, "celular local não é trocado por outro celular");
    assert.equal(decidirWhatsappExistente("+1 415 555 0100", CEL, true), null, "formato local desconhecido → conservador");
    assert.equal(decidirWhatsappExistente(FIXO, "+1 415 555 0100", false), null, "sem procedência de celular → não troca");
    assert.equal(decidirEmailExistente("", EMAIL), EMAIL);
    assert.equal(decidirEmailExistente(EMAIL, EMAIL), null);
    assert.equal(decidirEmailExistente("outro@example.com", EMAIL), null);
    assert.equal(decidirEmailExistente("", "nao-e-email"), null);
    assert.equal(classificarTelefoneBr(CEL), "celular");
    assert.equal(classificarTelefoneBr(FIXO), "fixo");
    assert.equal(classificarTelefoneBr("+1 415 555 0100"), "desconhecido", "sem heurística internacional");
    ok("proteção: heurística de formato só decide se um valor local antigo pode subir, nunca compete com contactCellPhone");
  }

  console.log(`\nOK test-hits-contato-preferencia (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
