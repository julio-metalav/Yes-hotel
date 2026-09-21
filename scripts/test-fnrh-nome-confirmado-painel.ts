/**
 * Nome confirmado e estado da FNRH na tela operacional
 * (ui/checkin-operacional-mvp.js).
 *
 * Painel carregado em node:vm, como em test-fnrh-cadastro-confirmado-painel.ts
 * e test-central-acoes-operacional-ui.ts: mapper, lista (linha desktop e
 * cartão mobile), cabeçalho do detalhe e card do hóspede são exercitados com
 * linhas sintéticas. Sem rede, sem browser, sem dado real.
 *
 * Cenários:
 *   1. reserva sem FNRH confirmada → nome original e estado pendente;
 *   2. FNRH confirmada → nome informado pelo hóspede na linha e no cabeçalho;
 *   3. estado divergente (caso da reserva 17829): fnrh_hospedes confirmada e
 *      reserva fnrh_completo, mas operacional_hospedes.status_operacional
 *      ainda "enviado" → painel reconhece a FNRH concluída;
 *   4. nenhuma liberação indevida de senha ou acesso por causa do rótulo.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const ROOT = resolve(process.cwd());
const mvpSrc = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");

type Row = Record<string, unknown>;
type Stub = Record<string, unknown>;

function stubEl(): Stub {
  const classes = new Set<string>();
  return {
    classList: {
      add: (c: string) => classes.add(c),
      remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
      toggle() {},
      contains: (c: string) => classes.has(c),
    },
    addEventListener() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    style: {},
    textContent: "",
    innerHTML: "",
    value: "",
    options: [],
    disabled: false,
    dataset: {},
  };
}

const DOM_IDS = [
  "#reservation-detail-body",
  "#reservation-detail-title",
  "#reservation-detail-subtitle",
  "#op-table-body",
  "#op-mobile-list",
  "#op-table-count",
  "#op-empty",
  "#op-detail-empty",
  "#op-detail-filled",
  "#op-detail-apto",
  "#op-detail-badge-wrap",
];

type Painel = {
  sandbox: Record<string, unknown>;
  el: Record<string, Stub>;
  fetchCalls: number;
  chamadasProibidas: string[];
};

/** Sandbox do painel; elementos usados pela lista e pelo detalhe são HTMLElement do próprio realm. */
function loadPainel(): Painel {
  // escapeHtml do painel usa div.textContent → div.innerHTML: o stub precisa escapar.
  const escEl = (): Stub => {
    const o = stubEl();
    let text = "";
    Object.defineProperty(o, "textContent", { get: () => text, set: (v: unknown) => { text = String(v); } });
    Object.defineProperty(o, "innerHTML", {
      get: () => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      set() {},
    });
    return o;
  };
  class HTMLElement {}
  const el: Record<string, Stub> = {};
  for (const id of DOM_IDS) el[id] = Object.assign(new HTMLElement(), stubEl());
  const painel: Painel = { sandbox: {}, el, fetchCalls: 0, chamadasProibidas: [] };
  const sandbox: Record<string, unknown> = {
    console,
    Intl,
    Date,
    document: {
      querySelector: (sel: string) => el[sel] || null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => escEl(),
      getElementById: () => null,
      body: stubEl(),
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: "node" },
    location: { hostname: "localhost", search: "" },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      painel.fetchCalls += 1;
      return new Response("{}");
    },
    HTMLElement,
    HTMLInputElement: class {},
    HTMLSelectElement: class {},
    Response,
    URL,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mvpSrc, sandbox);
  // Qualquer caminho que libere acesso ou envie senha a partir da renderização é falha.
  for (const fn of ["acaoLiberarAcesso", "backendLiberarAcesso", "backendEnviarSenha", "backendRegistrarFnrh"]) {
    if (typeof sandbox[fn] === "function") {
      sandbox[fn] = async () => {
        painel.chamadasProibidas.push(fn);
        return { ok: false, error: "chamada proibida no teste" };
      };
    }
  }
  painel.sandbox = sandbox;
  return painel;
}

const RESERVA_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FNRH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOME_ORIGINAL_HITS = "Nome Original Da Hits";
const NOME_FNRH = "Nome Informado Na Fnrh";

function reservaRow(hoje: string, partial: Row = {}): Row {
  return {
    id: RESERVA_ID,
    apartamento: "103",
    hospede_principal: NOME_ORIGINAL_HITS,
    external_reservation_id: "17829",
    origem_externa: "hits",
    check_in_previsto: hoje,
    check_out_previsto: hoje,
    status_reserva: "ativa",
    pagamento_status: "pendente",
    fnrh_status_agregado: "fnrh_pendente",
    acesso_liberado: false,
    entrou_no_apto: false,
    senha_enviada_em: null,
    ...partial,
  };
}

function hospedeRow(partial: Row = {}): Row {
  return {
    id: GUEST_ID,
    reserva_id: RESERVA_ID,
    nome: NOME_ORIGINAL_HITS,
    principal: true,
    guest_role: "primary_adult",
    is_minor: false,
    email: "hospede@example.com",
    whatsapp: "5567999990000",
    status_operacional: "enviado",
    pms_external_guest_id: "555001",
    ...partial,
  };
}

function fnrhPendenteRow(partial: Row = {}): Row {
  return {
    id: FNRH_ID,
    hospede_id: GUEST_ID,
    reserva_id: RESERVA_ID,
    status: "pendente",
    fnrh_lifecycle_status: null,
    link_token: "tok-teste",
    hospede_nome: NOME_ORIGINAL_HITS,
    ...partial,
  };
}

/** Linha persistida após o hóspede confirmar (status/lifecycle como grava o fnrh-submit v2). */
function fnrhConfirmadaRow(partial: Row = {}): Row {
  return {
    id: FNRH_ID,
    hospede_id: GUEST_ID,
    reserva_id: RESERVA_ID,
    status: "confirmado_hospede",
    fnrh_lifecycle_status: "completed",
    link_token: "tok-teste",
    hospede_nome: NOME_FNRH,
    nome_social: "",
    data_nascimento: "1990-01-15",
    nacionalidade: "Brasileira",
    documento_tipo: "cpf",
    documento_numero: "52998224725",
    cidade: "Campo Grande",
    uf: "MS",
    pais: "Brasil",
    email: "hospede@example.com",
    telefone: "5567999990000",
    completed_at: "2026-09-17T18:05:00.000Z",
    preenchido_em: "2026-09-17T18:05:00.000Z",
    fnrh_sync_status: "enviado",
    fnrh_sync_enviado_em: "2026-09-17T18:05:03.000Z",
    fnrh_sync_erro: null,
    ...partial,
  };
}

function main() {
  const painel = loadPainel();
  const { sandbox, el } = painel;
  const S = sandbox as Record<string, (...args: unknown[]) => unknown>;
  const mapReserva = S.mapDbReservaToInternal as (r: Row, h: Row[], e: Row[], f: Row[], s: Row[]) => Row;
  const setReservas = vm.runInContext("(function (lista) { reservas = lista; })", sandbox as vm.Context) as (l: Row[]) => void;
  for (const fn of [
    "mapDbReservaToInternal", "renderOperacionalLista", "syncDetailPanelChrome", "renderDetail",
    "getFnrhConfirmadas", "isFnrhCompleta", "formatFnrhSituacaoLabel", "isProntaParaLiberarAcesso",
    "acessoLiberadoEfetivo", "senhaOperacionalPendenteLista", "listaProximaAcaoOperacional",
    "buildArrivalsInputFromInternal", "todayStr", "nomeReservaParaExibicao",
  ]) {
    assert.equal(typeof S[fn], "function", `${fn} disponível no painel`);
  }
  const hoje = String(S.todayStr());

  function montar(reserva: Row, hospedes: Row[], fnrh: Row[]): Row {
    return mapReserva(reserva, hospedes, [], fnrh, []);
  }
  function renderTudo(reserva: Row): { linha: string; mobile: string; titulo: string; detalhe: string } {
    setReservas([reserva]);
    S.renderOperacionalLista();
    S.syncDetailPanelChrome(reserva);
    S.renderDetail(reserva);
    return {
      linha: String(el["#op-table-body"].innerHTML),
      mobile: String(el["#op-mobile-list"].innerHTML),
      titulo: String(el["#reservation-detail-title"].textContent),
      detalhe: String(el["#reservation-detail-body"].innerHTML),
    };
  }
  function cardHospede(html: string): string {
    const i = html.indexOf('<div class="guest-detail-card');
    assert.ok(i > -1, "card do hóspede renderizado");
    return html.slice(i, html.indexOf("</details>", i) > -1 ? html.indexOf("</details>", i) + 10 : html.length);
  }

  console.log("\n== 1. Reserva sem FNRH confirmada ==");
  {
    const reserva = montar(reservaRow(hoje), [hospedeRow()], [fnrhPendenteRow()]);
    assert.equal(reserva.hospedePrincipal, NOME_ORIGINAL_HITS);
    assert.equal(reserva.hospedePrincipalExibicao, NOME_ORIGINAL_HITS);
    const h = (reserva.hospedes as Row[])[0]!;
    assert.equal(h.statusOperacional, "enviado");
    assert.equal(h.statusOperacionalPersistido, "enviado");
    assert.equal(h.cadastroConfirmado, null);
    assert.equal(S.getFnrhConfirmadas(reserva), 0);
    assert.equal(S.isFnrhCompleta(reserva), false);
    assert.equal(S.formatFnrhSituacaoLabel(reserva), "Pendente");
    ok("mapper: nome original, status enviado, FNRH pendente");

    const out = renderTudo(reserva);
    assert.ok(out.linha.includes(`<span class="op-guest-name" title="${NOME_ORIGINAL_HITS}">${NOME_ORIGINAL_HITS}</span>`), "linha desktop com nome original");
    assert.ok(out.linha.includes("FNRH 0/1"), "linha desktop com FNRH 0/1");
    assert.ok(out.mobile.includes(`<div class="op-mcard__name" title="${NOME_ORIGINAL_HITS}">${NOME_ORIGINAL_HITS}</div>`), "cartão mobile com nome original");
    assert.ok(out.mobile.includes("FNRH 0/1"), "cartão mobile com FNRH 0/1");
    assert.equal(out.titulo, NOME_ORIGINAL_HITS);
    ok("linha, cartão mobile e cabeçalho mostram o nome original da reserva");

    const card = cardHospede(out.detalhe);
    assert.match(card, /<p class="guest-detail-fnrh-line">FNRH pendente<\/p>/);
    assert.equal(out.detalhe.includes("Ver cadastro confirmado"), false);
    assert.ok(out.detalhe.includes("detail-reenviar-fnrh-topo-btn"), "link enviado: reenvio continua oferecido");
    ok("card: FNRH pendente, sem cadastro confirmado, reenvio disponível");

    const semFnrh = montar(reservaRow(hoje), [hospedeRow({ status_operacional: "pronto_para_envio" })], []);
    assert.equal(semFnrh.hospedePrincipalExibicao, NOME_ORIGINAL_HITS);
    assert.equal(S.formatFnrhSituacaoLabel(semFnrh), "Pendente");
    ok("sem linha em fnrh_hospedes: nome original e pendente");
  }

  console.log("\n== 2. FNRH confirmada (status operacional já confirmado) ==");
  {
    const reserva = montar(
      reservaRow(hoje, { fnrh_status_agregado: "fnrh_completo" }),
      [hospedeRow({ status_operacional: "confirmado" })],
      [fnrhConfirmadaRow()],
    );
    assert.equal(reserva.hospedePrincipal, NOME_ORIGINAL_HITS, "nome original preservado no objeto");
    assert.equal(reserva.hospedePrincipalExibicao, NOME_FNRH);
    assert.equal(S.getFnrhConfirmadas(reserva), 1);
    assert.equal(S.formatFnrhSituacaoLabel(reserva), "Concluída");
    ok("mapper: nome de exibição = nome informado na FNRH; original intacto");

    const out = renderTudo(reserva);
    assert.ok(out.linha.includes(`<span class="op-guest-name" title="${NOME_FNRH}">${NOME_FNRH}</span>`), "linha desktop com nome da FNRH");
    assert.equal(out.linha.includes(NOME_ORIGINAL_HITS), false, "linha não mostra mais o nome original");
    assert.ok(out.linha.includes("FNRH 1/1"));
    assert.ok(out.mobile.includes(`<div class="op-mcard__name" title="${NOME_FNRH}">${NOME_FNRH}</div>`), "cartão mobile com nome da FNRH");
    assert.equal(out.titulo, NOME_FNRH);
    ok("linha, cartão mobile e cabeçalho mostram o nome informado pelo hóspede");

    const card = cardHospede(out.detalhe);
    assert.match(card, /<p class="guest-detail-fnrh-line">FNRH concluída<\/p>/);
    assert.ok(out.detalhe.includes("Ver cadastro confirmado"));
    assert.ok(out.detalhe.includes(`<dt>Nome civil</dt><dd>${NOME_FNRH}</dd>`));
    ok("'Ver cadastro confirmado' segue funcionando com os dados confirmados");

    const social = montar(
      reservaRow(hoje, { fnrh_status_agregado: "fnrh_completo" }),
      [hospedeRow({ status_operacional: "confirmado" })],
      [fnrhConfirmadaRow({ nome_social: "Nome Social Da Fnrh" })],
    );
    assert.equal(social.hospedePrincipalExibicao, "Nome Social Da Fnrh");
    assert.equal(S.nomeReservaParaExibicao(social), "Nome Social Da Fnrh");
    ok("nome social confirmado tem a mesma prioridade do card");

    const socialSemCivil = montar(
      reservaRow(hoje, { fnrh_status_agregado: "fnrh_completo" }),
      [hospedeRow({ status_operacional: "confirmado" })],
      [fnrhConfirmadaRow({ hospede_nome: "   ", nome_social: "Social Sem Civil" })],
    );
    assert.equal(socialSemCivil.hospedePrincipalExibicao, "Social Sem Civil");
    assert.equal(S.getFnrhConfirmadas(socialSemCivil), 1, "FNRH continua contada como concluída");
    ok("FNRH confirmada com civil vazio e social preenchido: exibe o nome social");

    const semNome = montar(
      reservaRow(hoje, { fnrh_status_agregado: "fnrh_completo" }),
      [hospedeRow({ status_operacional: "confirmado" })],
      [fnrhConfirmadaRow({ hospede_nome: "   ", nome_social: "" })],
    );
    assert.equal(semNome.hospedePrincipalExibicao, NOME_ORIGINAL_HITS);
    assert.equal(S.getFnrhConfirmadas(semNome), 1, "FNRH continua contada como concluída");
    ok("FNRH confirmada sem nome civil nem social: mantém o nome original da reserva");

    const acompanhante = montar(
      reservaRow(hoje),
      [hospedeRow(), hospedeRow({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", principal: false, guest_role: "adult_companion", status_operacional: "confirmado" })],
      [fnrhConfirmadaRow({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", hospede_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", hospede_nome: "Acompanhante Confirmado" })],
    );
    assert.equal(acompanhante.hospedePrincipalExibicao, NOME_ORIGINAL_HITS);
    ok("FNRH confirmada só do acompanhante não troca o nome da reserva");

    const semExibicao = S.nomeReservaParaExibicao({ hospedePrincipal: NOME_ORIGINAL_HITS });
    assert.equal(semExibicao, NOME_ORIGINAL_HITS);
    assert.equal(S.nomeReservaParaExibicao({ hospedePrincipal: "" }), "—");
    ok("reservas sem campo de exibição (origens locais) continuam com o nome original");
  }

  console.log("\n== 3. Estado divergente da reserva 17829: FNRH completa, status operacional 'enviado' ==");
  {
    const reserva = montar(
      reservaRow(hoje, { fnrh_status_agregado: "fnrh_completo", fnrh_completo_em: "2026-09-17T18:05:00.000Z" }),
      [hospedeRow({ status_operacional: "enviado" })],
      [fnrhConfirmadaRow()],
    );
    const h = (reserva.hospedes as Row[])[0]!;
    assert.equal(h.statusOperacionalPersistido, "enviado", "valor bruto do banco preservado");
    assert.equal(h.statusOperacional, "confirmado", "estado efetivo vem da FNRH persistida");
    assert.ok(h.cadastroConfirmado, "snapshot confirmado presente");
    assert.equal(S.getFnrhConfirmadas(reserva), 1);
    assert.equal(S.isFnrhCompleta(reserva), true);
    assert.equal(S.formatFnrhSituacaoLabel(reserva), "Concluída");
    assert.equal(reserva.hospedePrincipal, NOME_ORIGINAL_HITS);
    assert.equal(reserva.hospedePrincipalExibicao, NOME_FNRH);
    ok("mapper: FNRH reconhecida como concluída apesar do status divergente");

    const out = renderTudo(reserva);
    assert.ok(out.linha.includes("FNRH 1/1"), "linha desktop deixa de mostrar FNRH 0/1");
    assert.equal(out.linha.includes("FNRH 0/1"), false);
    assert.ok(out.linha.includes(`<span class="op-guest-name" title="${NOME_FNRH}">${NOME_FNRH}</span>`));
    assert.ok(out.mobile.includes("FNRH 1/1"));
    assert.ok(out.mobile.includes(`<div class="op-mcard__name" title="${NOME_FNRH}">${NOME_FNRH}</div>`));
    assert.equal(out.titulo, NOME_FNRH);
    ok("linha, cartão mobile e cabeçalho: FNRH 1/1 e nome informado pelo hóspede");

    const card = cardHospede(out.detalhe);
    assert.match(card, /<p class="guest-detail-fnrh-line">FNRH concluída<\/p>/);
    assert.ok(out.detalhe.includes("Ver cadastro confirmado"));
    assert.ok(out.detalhe.includes(`<dt>Nome civil</dt><dd>${NOME_FNRH}</dd>`));
    assert.ok(out.detalhe.includes('class="detail-central-item-estado is-ok">Concluída<'), "Central de ações: FNRH concluída");
    assert.equal(out.detalhe.includes("detail-reenviar-fnrh-topo-btn"), false, "sem reenvio de link para FNRH já confirmada");
    assert.equal(out.detalhe.includes("detail-enviar-links-btn"), false, "sem envio de link para FNRH já confirmada");
    const prox = S.listaProximaAcaoOperacional(reserva) as { cta?: { kind?: string } | null };
    assert.notEqual(prox.cta && prox.cta.kind, "reenviar_fnrh", "próxima ação não é reenviar FNRH");
    ok("detalhe: card e Central de ações tratam a FNRH como concluída");

    // Contra-prova: linha confirmada em fnrh_hospedes é o que decide — sem ela,
    // o mesmo status 'enviado' segue pendente (cenário 1).
    const soStatus = montar(reservaRow(hoje, { fnrh_status_agregado: "fnrh_completo" }), [hospedeRow({ status_operacional: "enviado" })], [fnrhPendenteRow()]);
    assert.equal(S.isFnrhCompleta(soStatus), false);
    assert.equal(soStatus.hospedePrincipalExibicao, NOME_ORIGINAL_HITS);
    ok("agregado fnrh_completo sozinho não basta: a fonte é a linha confirmada em fnrh_hospedes");

    const rascunho = montar(reservaRow(hoje), [hospedeRow({ status_operacional: "enviado" })], [fnrhConfirmadaRow({ status: "rascunho", fnrh_lifecycle_status: "draft" })]);
    assert.equal(((rascunho.hospedes as Row[])[0]!).statusOperacional, "enviado");
    assert.equal(S.isFnrhCompleta(rascunho), false);
    assert.equal(rascunho.hospedePrincipalExibicao, NOME_ORIGINAL_HITS);
    ok("rascunho não é confirmação: status e nome originais");
  }

  console.log("\n== 4. Nenhuma liberação indevida de senha ou acesso ==");
  {
    painel.fetchCalls = 0;
    painel.chamadasProibidas.length = 0;

    // Pagamento pendente: FNRH reconhecida, mas nada de acesso/senha.
    const pendente = montar(
      reservaRow(hoje, { fnrh_status_agregado: "fnrh_completo", pagamento_status: "pendente" }),
      [hospedeRow({ status_operacional: "enviado" })],
      [fnrhConfirmadaRow()],
    );
    const outP = renderTudo(pendente);
    assert.equal(pendente.acessoLiberado, false);
    assert.equal(S.acessoLiberadoEfetivo(pendente), false);
    assert.equal(S.isProntaParaLiberarAcesso(pendente), false);
    assert.equal(S.senhaOperacionalPendenteLista(pendente), false);
    assert.equal(outP.detalhe.includes("detail-gerar-senha-btn"), false, "sem 'Gerar senha' com pagamento pendente");
    const proxP = S.listaProximaAcaoOperacional(pendente) as { cta?: { kind?: string } | null };
    assert.notEqual(proxP.cta && proxP.cta.kind, "liberar_acesso");
    assert.notEqual(proxP.cta && proxP.cta.kind, "gerar_senha");
    ok("pagamento pendente: acesso não liberado, senha não recomendada");

    // Pagamento ok: a única mudança é a recomendação ao operador; nada executa.
    const pago = montar(
      reservaRow(hoje, { fnrh_status_agregado: "fnrh_completo", pagamento_status: "pago" }),
      [hospedeRow({ status_operacional: "enviado" })],
      [fnrhConfirmadaRow()],
    );
    const outOk = renderTudo(pago);
    assert.equal(pago.acessoLiberado, false, "renderizar não libera acesso");
    assert.equal(S.acessoLiberadoEfetivo(pago), false);
    assert.equal(pago.senhaEnviadaEm, null);
    assert.equal(S.senhaOperacionalPendenteLista(pago), false, "senha só entra em pendência com acesso liberado");
    assert.equal(outOk.detalhe.includes('data-acao-credencial="reenviar"'), false, "sem reenvio de senha inexistente");
    ok("pagamento ok: acesso continua fechado e nenhuma senha consta como enviada");

    assert.equal(painel.fetchCalls, 0, "nenhuma chamada de rede ao renderizar");
    assert.deepEqual(painel.chamadasProibidas, [], "liberar acesso / enviar senha / registrar FNRH não foram chamados");
    ok("sem chamada de rede, TTLock, senha ou cobrança disparada pela mudança de rótulo");

    // O que sai do painel para outros fluxos mantém o nome original da HITS.
    const arrivals = S.buildArrivalsInputFromInternal(pago) as Row;
    assert.equal(arrivals.hospede_principal, NOME_ORIGINAL_HITS);
    ok("nome original da HITS segue sendo o que o painel repassa (nada é gravado de volta)");
  }

  console.log("\n== Estático: o painel não grava o status derivado ==");
  {
    const i0 = mvpSrc.indexOf("function mapDbHospedeToInternal(");
    const i1 = mvpSrc.indexOf("function mapDbComunicacaoEnviosToInternal(");
    const mapper = mvpSrc.slice(i0, i1);
    assert.match(mapper, /statusOperacionalPersistido: row\.status_operacional \|\| GUEST_STATUS\.NAO_IDENTIFICADO,/);
    assert.match(mapper, /statusOperacional: cadastroConfirmado\s*\?\s*GUEST_STATUS\.CONFIRMADO\s*:\s*row\.status_operacional \|\| GUEST_STATUS\.NAO_IDENTIFICADO,/);
    assert.equal(mapper.includes(".from("), false, "mapper não consulta nem grava no banco");
    ok("estado efetivo derivado no mapper, sem escrita em operacional_hospedes");

    const iR = mvpSrc.indexOf("function mapDbReservaToInternal(");
    const reservaMapper = mvpSrc.slice(iR, mvpSrc.indexOf("\n}\n", iR));
    assert.match(reservaMapper, /hospedePrincipal: hospedePrincipalOriginal,/);
    assert.match(reservaMapper, /hospedePrincipalExibicao: resolveNomeExibicaoReserva\(hospedePrincipalOriginal, hospedes\),/);
    assert.equal((mvpSrc.match(/= nomeReservaParaExibicao\(reserva\);/g) || []).length, 3, "linha desktop, cartão mobile e cabeçalho");
    assert.equal(mvpSrc.includes("hospede_principal: r.hospedePrincipalExibicao"), false, "nome de exibição nunca vai para hospede_principal");
    ok("nome de exibição só na linha, no cartão mobile e no cabeçalho");
  }

  console.log(`\nOK test-fnrh-nome-confirmado-painel (${cases} casos)`);
}

main();
