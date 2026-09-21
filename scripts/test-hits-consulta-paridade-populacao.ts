/**
 * Paridade de população Recepção × HITS (perfil hits_consulta).
 *
 * Roda o JS REAL do painel (ui/checkin-operacional-mvp.js + módulos que a
 * página carrega) duas vezes sobre o MESMO conjunto de dados:
 *   - Recepção: lê as tabelas (motor de consulta em memória) + leitura HITS;
 *   - HITS: lê só a RPC operacional_hits_checkin_consulta() (projeção montada
 *     aqui com a mesma regra da migration 20260921120000) + a mesma leitura HITS.
 *
 * Critério principal: para o mesmo período/filtro,
 *   set(IDs Recepção) == set(IDs HITS) e totalRecepcao == totalHits.
 * Também confere estados por reserva, KPIs, chips (sem o financeiro), Chegadas,
 * ausência de dados financeiros/contatos e de comandos no perfil HITS.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const SCRIPTS = [
  "ui/yes-nav-policy.js",
  "ui/yes-reservation-financial.js",
  "ui/yes-pagarme-payment-ui.js",
  "ui/yes-pagamento-presencial-diferido-ui.js",
  "ui/yes-credential-release-policy.js",
  "ui/yes-access-tolerance-policy.js",
  "ui/yes-arrivals-policy.js",
  "ui/yes-checkin-panel-presentation.js",
  "ui/yes-hits-sandbox-preview.js",
  "ui/checkin-operacional-mvp.js",
];

// ---------------------------------------------------------------- DOM mínimo
class FakeClassList {
  s = new Set<string>();
  add(...c: string[]) { c.forEach((x) => this.s.add(x)); }
  remove(...c: string[]) { c.forEach((x) => this.s.delete(x)); }
  toggle(c: string, force?: boolean) {
    const on = force === undefined ? !this.s.has(c) : !!force;
    if (on) this.s.add(c); else this.s.delete(c);
    return on;
  }
  contains(c: string) { return this.s.has(c); }
}
class FakeEl {
  sel: string; attrs: Record<string, string> = {}; classList = new FakeClassList();
  style: Record<string, string> = {}; dataset: Record<string, string> = {};
  innerHTML = ""; textContent = ""; value = ""; hidden = false; disabled = false; checked = false;
  removed = false; options: any[] = [];
  constructor(sel: string, value = "") { this.sel = sel; this.value = value; }
  addEventListener() {} removeEventListener() {}
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  querySelector() { return null; } querySelectorAll() { return []; }
  closest() { return null; } remove() { this.removed = true; }
  appendChild() {} focus() {} blur() {} click() {} scrollIntoView() {}
  insertAdjacentHTML() {} contains() { return false; } toggleAttribute() {}
}

// ---------------------------------------------------------------- dados
type Row = Record<string, any>;
function datasetFor(today: string, addDays: (d: string, n: number) => string) {
  const d = (n: number) => addDays(today, n);
  const R = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const H = (n: number) => `20000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const res = (n: number, o: Row): Row => ({
    id: R(n), external_reservation_id: `EXT${n}`, apartamento: String(100 + n),
    hospede_principal: `Hóspede ${n}`, check_in_previsto: d(0), check_out_previsto: d(2),
    status_reserva: "ativa", fnrh_status_agregado: "fnrh_pendente", acesso_liberado: false,
    entrou_no_apto: false, pagamento_status: "pendente", created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`,
    reservation_balance_due: 350, reservation_total_amount: 900, ...o,
  });
  const operacional_reservas: Row[] = [
    res(1, {}), // chega hoje, FNRH 1/2, não paga
    res(2, { pagamento_status: "pago", fnrh_status_agregado: "fnrh_completo" }), // pronta, sem acesso
    res(3, { check_in_previsto: d(-1), check_out_previsto: d(2), pagamento_status: "pago", fnrh_status_agregado: "fnrh_completo", acesso_liberado: true, entrou_no_apto: true }), // em estadia
    res(4, { check_in_previsto: d(3), check_out_previsto: d(5) }), // futura
    res(5, { status_reserva: "cancelada" }), // cancelada
    res(6, { check_in_previsto: d(-3), check_out_previsto: d(-1), pagamento_status: "pago", fnrh_status_agregado: "fnrh_completo", acesso_liberado: true, entrou_no_apto: true }), // concluída e encerrada (oculta na lista padrão)
    res(7, { pagamento_status: "pago", fnrh_status_agregado: "fnrh_completo" }), // acesso efetivo pela credencial principal
    res(8, { external_reservation_id: null, apartamento: "", check_in_previsto: d(1), check_out_previsto: d(4) }), // sem ID externo e sem apto
    res(9, { check_in_previsto: d(-1), check_out_previsto: d(1), pagamento_status: "pago", fnrh_status_agregado: "fnrh_completo", acesso_liberado: true }), // acesso liberado, não entrou
    // Após o corte (check-in + 1 dia 11h), entrou, acesso e FNRH completa:
    res(10, { check_in_previsto: d(-3), check_out_previsto: d(2), fnrh_status_agregado: "fnrh_completo", acesso_liberado: true, entrou_no_apto: true }), // pendência interna (não paga) → fica na lista
    res(11, { check_in_previsto: d(-3), check_out_previsto: d(2), pagamento_status: "pago", fnrh_status_agregado: "fnrh_completo", acesso_liberado: true, entrou_no_apto: true }), // inverso: sem pendência → oculta
    res(12, { check_in_previsto: d(-3), check_out_previsto: d(2), classificacao_comissionamento: "comissionada", fnrh_status_agregado: "fnrh_completo", acesso_liberado: true, entrou_no_apto: true }), // comissionada: liberada → oculta
    res(13, { check_in_previsto: d(-3), check_out_previsto: d(2), fnrh_status_agregado: "fnrh_completo", acesso_liberado: true, entrou_no_apto: true }), // quitada via Pagar.me → oculta
  ];
  const hosp = (n: number, reserva: number, o: Row): Row => ({
    id: H(n), reserva_id: R(reserva), nome: `Hóspede ${reserva}`, principal: true, email: `h${n}@exemplo.com`,
    whatsapp: `6799900${n}`, status_operacional: "enviado", removed_from_reservation: false,
    created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`, ...o,
  });
  const operacional_hospedes: Row[] = [
    hosp(1, 1, {}), hosp(2, 1, { principal: false, nome: "Acompanhante", status_operacional: "nao_identificado" }),
    hosp(3, 2, { status_operacional: "confirmado" }),
    hosp(4, 3, {}), hosp(5, 3, { principal: false, removed_from_reservation: true }),
    hosp(6, 6, { status_operacional: "confirmado" }),
    hosp(7, 7, { status_operacional: "confirmado" }),
    hosp(9, 9, { status_operacional: "confirmado" }),
    hosp(10, 10, { status_operacional: "confirmado" }),
    hosp(11, 11, { status_operacional: "confirmado" }),
    hosp(12, 12, { status_operacional: "confirmado" }),
    hosp(13, 13, { status_operacional: "confirmado" }),
  ];
  const fnrh_hospedes: Row[] = [
    { id: "f1", hospede_id: H(1), reserva_id: R(1), status: "confirmado_hospede", fnrh_lifecycle_status: null, hospede_nome: "Nome Civil Um", nome_social: "Nome Social Um", documento_numero: "12345678900", email: "h1@exemplo.com", telefone: "67999" },
    { id: "f4", hospede_id: H(4), reserva_id: R(3), status: "pendente", fnrh_lifecycle_status: "completed", hospede_nome: "Civil Três", nome_social: "", documento_numero: "999", email: "", telefone: "" },
  ];
  const operacional_credenciais_acesso: Row[] = [
    { id: "c7", reserva_id: R(7), tipo_credencial: "principal", status: "provisionada" },
    { id: "c2", reserva_id: R(2), tipo_credencial: "principal", status: "parcial" },
  ];
  const operacional_credencial_itens: Row[] = [
    { credencial_id: "c7", status_provisionamento: "provisionado", remote_keyboard_pwd_id: 77 },
    { credencial_id: "c2", status_provisionamento: "provisionado", remote_keyboard_pwd_id: 78 },
    { credencial_id: "c2", status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
  ];
  const operacional_cobrancas_pagarme: Row[] = [
    { id: "cp10", reserva_id: R(10), status: "pending", valor_centavos: 35000 },
    { id: "cp13", reserva_id: R(13), status: "paid", valor_centavos: 35000 },
  ];
  // Leitura HITS (Edge hits-reservations-preview): EXT1 já está no banco; EXT20..22 não.
  const hitsRows: Row[] = [
    { external_reservation_id: "EXT1", apartamento: "101", hospede_principal: "Hóspede 1", check_in: d(0), check_out: d(3), status_reserva: "ativa", total_hospedes: 2, ciclo_hits: "confirmada" },
    { external_reservation_id: "EXT20", apartamento: "120", hospede_principal: "Só no HITS 20", check_in: d(0), check_out: d(2), status_reserva: "ativa", total_hospedes: 1, ciclo_hits: "confirmada" },
    { external_reservation_id: "EXT21", apartamento: "121", hospede_principal: "Só no HITS 21", check_in: d(2), check_out: d(4), status_reserva: "ativa", total_hospedes: 3, ciclo_hits: "confirmada" },
    { external_reservation_id: "EXT22", apartamento: "122", hospede_principal: "Só no HITS 22", check_in: d(0), check_out: d(1), status_reserva: "ativa", total_hospedes: 2, ciclo_hits: "hospedada" },
  ];
  return { operacional_reservas, operacional_hospedes, fnrh_hospedes, operacional_credenciais_acesso, operacional_credencial_itens, operacional_cobrancas_pagarme, hitsRows };
}

const FNRH_CONFIRMADA = new Set(["confirmado_hospede", "confirmado_hotel", "enviado_oficial", "erro_sincronizacao", "preenchido"]);
const fnrhConfirmada = (f: Row) =>
  FNRH_CONFIRMADA.has(String(f.status || "")) || ["completed", "manually_completed"].includes(String(f.fnrh_lifecycle_status || ""));

/** Mesma projeção da migration 20260921120000 (a SQL é validada à parte). */
function projecaoRpc(db: ReturnType<typeof datasetFor>): Row[] {
  return db.operacional_reservas.map((r) => {
    const hs = db.operacional_hospedes.filter((h) => h.reserva_id === r.id);
    const confirmados = hs.filter(
      (h) => h.status_operacional === "confirmado" || db.fnrh_hospedes.some((f) => f.hospede_id === h.id && fnrhConfirmada(f)),
    ).length;
    const principal = hs.filter((h) => h.principal).sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
    const f = principal && db.fnrh_hospedes.find((x) => x.hospede_id === principal.id && fnrhConfirmada(x));
    const exib = f ? (String(f.nome_social || "").trim() || String(f.hospede_nome || "").trim()) : "";
    const creds = db.operacional_credenciais_acesso.filter((c) => c.reserva_id === r.id && c.tipo_credencial === "principal" && c.status !== "revogada");
    const todos = creds.length > 0 && creds.every((c) => {
      const it = db.operacional_credencial_itens.filter((i) => i.credencial_id === c.id);
      return it.length > 0 && it.every((i) => i.status_provisionamento === "provisionado" && i.remote_keyboard_pwd_id != null);
    });
    // Bloco [permanencia] da migration: estado interno → só o booleano.
    const saldo = r.reservation_balance_due == null ? null : Number(r.reservation_balance_due);
    const quitado = db.operacional_cobrancas_pagarme
      .filter((c) => c.reserva_id === r.id && String(c.status).toLowerCase() === "paid" && c.valor_centavos > 0)
      .reduce((t, c) => t + c.valor_centavos, 0);
    const liberado =
      String(r.pagamento_status || "").trim().toLowerCase() === "pago" ||
      (saldo != null && saldo <= 0) ||
      (saldo != null && quitado > 0 && quitado >= Math.round(saldo * 100)) ||
      String(r.classificacao_comissionamento || "").trim().toLowerCase() === "comissionada";
    const total = hs.length;
    const acessoEfetivo = !!r.acesso_liberado || todos;
    return {
      reservation_id: r.id,
      external_reservation_id: String(r.external_reservation_id || "").trim() || null,
      apartment_code: r.apartamento,
      main_guest_name: r.hospede_principal,
      main_guest_display_name: exib || r.hospede_principal,
      check_in_previsto: r.check_in_previsto,
      check_out_previsto: r.check_out_previsto,
      status_reserva: r.status_reserva,
      fnrh_status_agregado: r.fnrh_status_agregado,
      fnrh_hospedes_total: hs.length,
      fnrh_hospedes_confirmados: confirmados,
      total_hospedes: hs.filter((h) => !h.removed_from_reservation).length,
      acesso_liberado: !!r.acesso_liberado,
      acesso_efetivo: !!r.acesso_liberado || todos,
      entrou_no_apto: !!r.entrou_no_apto,
      manter_na_lista_operacional: !liberado || total === 0 || confirmados < total || !acessoEfetivo || !r.entrou_no_apto,
    };
  });
}

// ---------------------------------------------------------------- supabase em memória
function makeQuery(table: string, source: () => Row[], log: string[]) {
  const preds: Array<(r: Row) => boolean> = [];
  let lim = Infinity;
  const q: any = {
    select() { return q; },
    gte(c: string, v: any) { preds.push((r) => r[c] != null && r[c] >= v); return q; },
    lte(c: string, v: any) { preds.push((r) => r[c] != null && r[c] <= v); return q; },
    gt(c: string, v: any) { preds.push((r) => r[c] != null && r[c] > v); return q; },
    eq(c: string, v: any) { preds.push((r) => r[c] === v); return q; },
    neq(c: string, v: any) { preds.push((r) => r[c] != null && r[c] !== v); return q; },
    in(c: string, vs: any[]) { preds.push((r) => vs.includes(r[c])); return q; },
    is(c: string, v: any) { preds.push((r) => (r[c] ?? null) === v); return q; },
    like(c: string, p: string) { const re = new RegExp("^" + p.replace(/%/g, ".*") + "$"); preds.push((r) => re.test(String(r[c] ?? ""))); return q; },
    order() { return q; }, limit(n: number) { lim = n; return q; },
    maybeSingle() { return q; }, single() { return q; },
    insert() { log.push(`WRITE insert ${table}`); return q; },
    update() { log.push(`WRITE update ${table}`); return q; },
    upsert() { log.push(`WRITE upsert ${table}`); return q; },
    delete() { log.push(`WRITE delete ${table}`); return q; },
    then(res: any, rej: any) {
      const rows = source().filter((r) => preds.every((p) => p(r))).slice(0, lim);
      return Promise.resolve({ data: rows, error: null }).then(res, rej);
    },
  };
  return q;
}

type Painel = { run: (code: string) => any; log: string[]; el: (sel: string) => FakeEl };

async function abrirPainel(role: "recepcao" | "hits_consulta", periodo: string): Promise<Painel> {
  const log: string[] = [];
  const els = new Map<string, FakeEl>();
  const el = (sel: string) => {
    if (!els.has(sel)) els.set(sel, new FakeEl(sel, sel === "#op-period" ? periodo : ""));
    return els.get(sel)!;
  };
  let ctxRef: any = null;
  let db: ReturnType<typeof datasetFor> | null = null;
  const dados = () => {
    if (!db) {
      const today = ctxRef.resolveOperationalTodayYmd(new Date());
      db = datasetFor(today, ctxRef.addDaysYmd);
    }
    return db;
  };
  const client = {
    supabaseUrl: "https://teste.supabase.co",
    from(table: string) {
      log.push(`from:${table}`);
      return makeQuery(table, () => ((dados() as any)[table] || []) as Row[], log);
    },
    rpc(fn: string) {
      log.push(`rpc:${fn}`);
      if (fn === "operacional_hits_checkin_consulta" && role === "hits_consulta") {
        return Promise.resolve({ data: projecaoRpc(dados()), error: null });
      }
      return Promise.resolve({ data: null, error: { message: "denied" } });
    },
    functions: { invoke: (n: string) => { log.push(`invoke:${n}`); return Promise.resolve({ data: null, error: { message: "x" } }); } },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  };
  const auth = {
    isConfigured: () => true,
    getConfigError: () => "",
    getCurrentUser: async () => ({ name: role, role }),
    isHitsConsultaRole: (u: any) => !!u && u.role === "hits_consulta",
    getRoleLabel: (r: string) => r,
    getSupabaseClient: () => client,
    getEdgeFunctionFetchHeaders: async () => ({}),
    getSession: async () => null,
    getUser: async () => null,
    logout: async () => {},
    invokeLifecycleAction: async () => { log.push("lifecycle"); return {}; },
  };
  const fetchStub = async (url: string, init?: any) => {
    const method = (init && init.method) || "GET";
    log.push(`fetch:${method}:${String(url).split("?")[0].split("/").pop()}${String(url).includes("ids=") ? "?ids" : ""}`);
    const rows = String(url).includes("ids=") ? [] : dados().hitsRows;
    return { ok: true, status: 200, json: async () => ({ ok: true, rows }) };
  };
  const document = {
    querySelector: (s: string) => el(s),
    querySelectorAll: () => [],
    getElementById: (id: string) => el("#" + id),
    createElement: (t: string) => new FakeEl(t),
    addEventListener() {},
    body: el("body"),
  };
  const window: any = {
    location: { search: "", hash: "", href: "" },
    addEventListener() {},
    innerWidth: 1366,
    YesHotelAuthApp: auth,
    YES_HOTEL_SUPABASE_CONFIG: { url: "https://teste.supabase.co", anonKey: "anon", pagarmeUiEnabled: true },
  };
  const ctx: any = createContext({
    window, document, console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchStub, Intl, Date, Promise,
    HTMLElement: FakeEl, HTMLInputElement: FakeEl, HTMLSelectElement: FakeEl, HTMLButtonElement: FakeEl,
    HTMLTextAreaElement: FakeEl, HTMLFormElement: FakeEl, Element: FakeEl, Node: FakeEl,
    navigator: {}, alert: () => { log.push("alert"); }, confirm: () => false, prompt: () => null,
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  window.fetch = fetchStub;
  window.document = document;
  Object.assign(ctx, { YesHotelAuthApp: auth, YES_HOTEL_SUPABASE_CONFIG: window.YES_HOTEL_SUPABASE_CONFIG });
  ctxRef = ctx;
  for (const rel of SCRIPTS) {
    runInContext(readFileSync(resolve(ROOT, rel), "utf8"), ctx, { filename: rel });
    // Módulos anexam a window.*; espelha no escopo global do contexto.
    for (const k of Object.keys(window)) if (/^Yes|^YES/.test(k)) ctx[k] = window[k];
  }
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 5));
  // Mesmo gatilho da tela ao trocar o período (applyPresetPeriodAndReload).
  if (periodo !== "hoje") {
    runInContext(`periodoAtivo = ${JSON.stringify(periodo)};`, ctx);
    await runInContext(`refreshFromSource()`, ctx);
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  }
  return { run: (code: string) => runInContext(code, ctx), log, el };
}

async function estado(p: Painel, filtro = "all", busca = "") {
  // Estado estável: base de Chegadas/hospedados já carregada (a tela a recarrega
  // de forma assíncrona depois de cada leitura; aqui esperamos por ela).
  await p.run(`ensureArrivalsDataset()`);
  p.run(`filtroAtivo = ${JSON.stringify(filtro)}; buscaLista = ${JSON.stringify(busca)}; refresh();`);
  await new Promise((r) => setTimeout(r, 5));
  return JSON.parse(
    p.run(`JSON.stringify({
      ids: listaParaExibicao().map((r) => r.id),
      linhas: listaParaExibicao().map((r) => ({
        id: r.id, apto: r.apartamento, nome: nomeReservaParaExibicao(r), ci: r.checkInPrevisto, co: r.checkOutPrevisto,
        noites: noitesEntre(r.checkInPrevisto, r.checkOutPrevisto), status: r.statusReserva,
        fnrhPendente: hasFnrhPendente(r), fnrhCompleta: isFnrhCompleta(r), fnrhLabel: formatFnrhSituacaoLabel(r),
        acesso: acessoLiberadoEfetivo(r), entrou: !!r.entrouNoApto, ext: r.externalReservationId || null,
      })),
      kpis: ["#op-kpi-arrivals", "#op-kpi-completed", "#op-kpi-fnrh", "#op-kpi-access", "#op-kpi-occupied-guests"].map((s) => document.querySelector(s).textContent),
      chips: OP_TAB_DEFS.filter(([k]) => k !== FILTER_PENDENTE_PAGAMENTO).map(([k]) => [k, filtrarReservas(listaBaseContagens(), k).length]),
      chipsHtml: document.querySelector("#op-status-tabs").innerHTML,
      tabela: document.querySelector("#op-table-body").innerHTML,
      cartoes: document.querySelector("#op-mobile-list").innerHTML,
    })`),
  );
}

async function chegadas(p: Painel, filtro: string) {
  p.run(`arrivalsFilter = ${JSON.stringify(filtro)}; arrivalsPage = 0;`);
  await p.run(`renderChegadasPanel()`);
  return JSON.parse(p.run(`JSON.stringify(YesHotelArrivalsPolicy.filterArrivals(arrivalsDatasetCache, ${JSON.stringify(filtro)}).map((r) => [r.id, r.apartamento, r.check_in, r.total_hospedes]))`));
}

async function main() {
  console.log("\n== Paridade de população Recepção × HITS ==");
  for (const periodo of ["hoje", "ontem", "7dias", "este_mes"]) {
    const rec = await abrirPainel("recepcao", periodo);
    const hits = await abrirPainel("hits_consulta", periodo);
    const a = await estado(rec);
    const b = await estado(hits);
    assert.ok(a.ids.length > 0 || periodo === "ontem", `${periodo}: dataset com reservas`);
    assert.deepEqual([...b.ids].sort(), [...a.ids].sort(), `${periodo}: mesmos IDs`);
    assert.equal(b.ids.length, a.ids.length, `${periodo}: mesmo total`);
    const porId = (x: any) => Object.fromEntries(x.linhas.map((l: any) => [l.id, l]));
    assert.deepEqual(porId(b), porId(a), `${periodo}: mesmos apto, nome, datas, noites, status, FNRH, acesso, entrada e ID HITS`);
    assert.deepEqual(b.kpis, a.kpis, `${periodo}: mesmos KPIs`);
    assert.deepEqual(b.chips, a.chips, `${periodo}: mesmos chips (exceto financeiro)`);
    for (const filtro of ["chegando_hoje", "pendente_fnrh", "acesso_liberado", "nao_entrou", "entrou"]) {
      const fa = await estado(rec, filtro);
      const fb = await estado(hits, filtro);
      assert.deepEqual([...fb.ids].sort(), [...fa.ids].sort(), `${periodo}/${filtro}: mesmos IDs`);
    }
    for (const busca of ["101", "Hóspede 2", "HITS 21"]) {
      const sa = await estado(rec, "all", busca);
      const sb = await estado(hits, "all", busca);
      assert.deepEqual([...sb.ids].sort(), [...sa.ids].sort(), `${periodo}/busca "${busca}": mesmos IDs`);
    }
    // "Só problemas" é filtro interno da Recepção: não existe no perfil HITS.
    for (const fc of ["hoje", "amanha", "proximos_7_dias", "todas_futuras"]) {
      const ca = await chegadas(rec, fc);
      const cb = await chegadas(hits, fc);
      assert.deepEqual(cb.map((r: any) => r[0]).sort(), ca.map((r: any) => r[0]).sort(), `${periodo}/Chegadas ${fc}: mesmas reservas`);
    }
    ok(`${periodo}: ${a.ids.length} reservas — mesmos IDs, estados, KPIs, chips, filtros, busca e Chegadas`);

    // HITS sem financeiro/contatos e sem comandos
    const html = b.tabela + b.cartoes;
    for (const proibido of ["op-btn-more", "data-ppd", "data-payment-badge", "op-next-action-btn", "data-cta-kind", "NÃO PAGO", "Pendente pagamento", "PAGO", "Comissionada", "Pagar.me", "@exemplo.com", "67999"]) {
      assert.ok(!html.includes(proibido), `${periodo}: HITS sem "${proibido}" na lista`);
    }
    assert.ok(!b.chipsHtml.includes("pendente_pagamento"), `${periodo}: sem chip financeiro no HITS`);
    assert.ok(a.chipsHtml.includes("pendente_pagamento"), `${periodo}: Recepção mantém o chip financeiro`);
    const verHits = (html.match(/op-btn-ver/g) || []).length;
    assert.equal(verHits, b.ids.length * 2, `${periodo}: HITS tem só "Ver" (tabela + cartão) por reserva`);
    if (a.ids.length) assert.ok(a.tabela.includes("op-btn-more"), `${periodo}: Recepção mantém ⋯`);
    const dadosHits = JSON.parse(hits.run(`JSON.stringify(reservas)`));
    for (const r of dadosHits) {
      assert.equal(r.pagamento, "", "sem pagamento");
      assert.equal(r.reservationBalanceDue, undefined, "sem saldo");
      for (const h of r.hospedes) assert.deepEqual(Object.keys(h).sort(), ["consultaSintetico", "statusOperacional"], "hóspede só com contagem");
    }
    // Fontes e escrita
    assert.ok(!hits.log.some((l) => l.startsWith("from:")), `${periodo}: HITS não consulta tabelas`);
    assert.ok(hits.log.includes("rpc:operacional_hits_checkin_consulta"), `${periodo}: HITS usa a RPC`);
    assert.ok(!hits.log.some((l) => l.startsWith("WRITE") || l.includes("?ids") || l === "lifecycle" || l.startsWith("invoke")), `${periodo}: HITS sem escrita, reconciliação ou lifecycle`);
    assert.ok(hits.log.filter((l) => l.startsWith("fetch:")).every((l) => l.startsWith("fetch:GET:hits-reservations-preview")), `${periodo}: HITS só lê a mesma prévia HITS da Recepção`);
    assert.ok(!rec.log.some((l) => l.startsWith("rpc:operacional_hits_checkin_consulta")), `${periodo}: Recepção não usa a RPC do HITS`);
    assert.ok(hits.el('[data-arrivals-filter="so_problemas"]').removed, `${periodo}: "Só problemas" removido do DOM no HITS`);
    assert.ok(!rec.el('[data-arrivals-filter="so_problemas"]').removed, `${periodo}: Recepção mantém "Só problemas"`);
    ok(`${periodo}: HITS sem financeiro, contatos, comandos ou escrita; Recepção inalterada`);
  }

  // Caso explícito: após o corte de check-in + 1 dia 11h, entrou, acesso e FNRH
  // completa. Permanência decidida por estado interno que o HITS não vê.
  {
    const R = (n: number) => `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
    for (const periodo of ["este_mes"]) {
      const rec = await abrirPainel("recepcao", periodo);
      const hits = await abrirPainel("hits_consulta", periodo);
      const a = await estado(rec);
      const b = await estado(hits);
      const pos = (x: any) => x.linhas.find((l: any) => l.id === R(10));
      assert.ok(a.ids.includes(R(10)), `${periodo}: Recepção mantém a reserva com pendência interna após o corte`);
      assert.ok(b.ids.includes(R(10)), `${periodo}: HITS também a vê após o corte`);
      assert.ok(pos(a).entrou && pos(a).acesso && pos(a).fnrhCompleta, `${periodo}: cenário entrou + acesso + FNRH completa`);
      for (const n of [11, 12, 13]) {
        assert.ok(!a.ids.includes(R(n)), `${periodo}: Recepção oculta R${n} (sem pendência) após o corte`);
        assert.ok(!b.ids.includes(R(n)), `${periodo}: HITS oculta R${n} após o corte`);
      }
      assert.deepEqual([...b.ids].sort(), [...a.ids].sort(), `${periodo}: população idêntica após o corte`);
      // Nada financeiro no objeto nem na tela do HITS
      const obj = JSON.parse(hits.run(`JSON.stringify(reservas.find((r) => r.id === ${JSON.stringify(R(10))}))`));
      assert.equal(obj.manterNaListaOperacional, true, "decisão neutra recebida");
      for (const k of ["pagamento_status", "pagamentoStatus", "reservationBalanceDue", "reservationTotalAmount", "classificacaoComissionamento", "motivo"]) {
        assert.ok(!(k in obj), `HITS sem ${k}`);
      }
      assert.equal(obj.pagamento, "", "HITS sem pagamento");
      assert.deepEqual(obj.cobrancasPagarme, [], "HITS sem cobranças");
      const rpcRow = projecaoRpc(datasetFor("2026-01-01", (d: string) => d))[0];
      assert.deepEqual(Object.keys(rpcRow).filter((k) => /pag|saldo|balance|valor|amount|cobr|comiss|motivo/i.test(k)), [], "payload da RPC sem campo financeiro");
      const telaHits = (b.tabela + b.cartoes).toLowerCase();
      for (const t of ["não pago", "nao pago", "pendente pagamento", "r$", "cobrança", "saldo", "comission"]) {
        assert.ok(!telaHits.includes(t), `${periodo}: tela HITS sem "${t}"`);
      }
      assert.ok(!hits.log.some((l) => l.startsWith("from:")), `${periodo}: HITS não lê tabelas`);
    }
    ok("após o corte: pendência interna visível em ambos, inverso oculto em ambos; HITS sem nenhum dado financeiro");
  }
  console.log(`\nOK test-hits-consulta-paridade-populacao (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
