/**
 * Ciclo 1 FNRH/HITS — painel operacional e texto do fluxo FNRH.
 *
 * Painel (`ui/checkin-operacional-mvp.js`) carregado em node:vm, como em
 * test-hits-sandbox-operacional-ui.ts: o mapper e o card são exercitados com
 * linhas sintéticas. Formulário (`ui/fnrh-checkin-v2.js`) conferido no texto.
 * Sem rede, sem browser, sem dado real.
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
const v2Src = readFileSync(resolve(ROOT, "ui/fnrh-checkin-v2.js"), "utf8");

type Row = Record<string, unknown>;

/** Sandbox do painel; `#reservation-detail-body` é um HTMLElement do próprio realm. */
function loadPainel(): { sandbox: Record<string, unknown>; detailBody: { innerHTML: string } } {
  const el = (): Record<string, unknown> => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    style: {},
    textContent: "",
    innerHTML: "",
    value: "",
    options: [],
    disabled: false,
    dataset: {},
  });
  // escapeHtml do painel usa div.textContent → div.innerHTML: o stub precisa escapar.
  const escEl = (): Record<string, unknown> => {
    const o = el();
    let text = "";
    Object.defineProperty(o, "textContent", { get: () => text, set: (v: unknown) => { text = String(v); } });
    Object.defineProperty(o, "innerHTML", {
      get: () => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      set() {},
    });
    return o;
  };
  class HTMLElement {}
  const detailBody = Object.assign(new HTMLElement(), el()) as unknown as { innerHTML: string };
  const sandbox: Record<string, unknown> = {
    console,
    Intl,
    Date,
    document: {
      querySelector: (sel: string) => (sel === "#reservation-detail-body" ? detailBody : null),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => escEl(),
      getElementById: () => null,
      body: el(),
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: "node" },
    location: { hostname: "localhost", search: "" },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => new Response("{}"),
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
  return { sandbox, detailBody };
}

const RESERVA_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FNRH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LINK_TOKEN = "tok-secreto-nao-exibir-9f8e7d";
const IP_FALSO = "203.0.113.77";
const UA_FALSO = "Mozilla/5.0 (UA-Teste)";
const HASH_FALSO = "sha256-hash-falso-0123456789abcdef";

const reservaRow: Row = {
  id: RESERVA_ID,
  apartamento: "07",
  hospede_principal: "Nome Da Reserva Hits",
  external_reservation_id: "17613",
  check_in_previsto: "2026-09-20",
  check_out_previsto: "2026-09-23",
  status_reserva: "ativa",
  pagamento_status: "pendente",
  fnrh_status_agregado: "fnrh_completo",
};

const hospedeRow: Row = {
  id: GUEST_ID,
  reserva_id: RESERVA_ID,
  nome: "Nome Operacional Antigo",
  principal: true,
  guest_role: "primary_adult",
  is_minor: false,
  email: "operacional@example.com",
  whatsapp: "5567988880000",
  data_nascimento: "1980-02-02",
  status_operacional: "confirmado",
};

function fnrhConfirmada(partial: Row = {}): Row {
  return {
    id: FNRH_ID,
    hospede_id: GUEST_ID,
    reserva_id: RESERVA_ID,
    status: "enviado_oficial",
    fnrh_lifecycle_status: "completed",
    link_token: LINK_TOKEN,
    hospede_nome: "Nome Civil Confirmado",
    nome_social: "Nome Social Confirmado",
    data_nascimento: "1990-01-15",
    nacionalidade: "Brasileira",
    documento_tipo: "cpf",
    documento_numero: "52998224725",
    endereco: "Rua Teste, 123, Centro, Campo Grande/MS, 79002-000, Brasil",
    cidade: "Campo Grande",
    uf: "MS",
    pais: "Brasil",
    email: "confirmado@example.com",
    telefone: "5567999990000",
    completed_at: "2026-09-16T18:05:00.000Z",
    preenchido_em: "2026-09-16T18:05:00.000Z",
    fnrh_sync_status: "enviado",
    fnrh_sync_enviado_em: "2026-09-16T18:05:03.000Z",
    fnrh_sync_erro: null,
    // Nunca deveriam ser selecionados; aqui só para provar que não vazam.
    confirmed_ip: IP_FALSO,
    confirmed_user_agent: UA_FALSO,
    snapshot_hash: HASH_FALSO,
    ...partial,
  };
}

function main() {
  const { sandbox, detailBody } = loadPainel();
  const mapHospede = sandbox.mapDbHospedeToInternal as (r: Row, f?: Row, res?: Row) => Row;
  const mapReserva = sandbox.mapDbReservaToInternal as (
    r: Row, h: Row[], e: Row[], f: Row[], s: Row[],
  ) => Row;
  const buildCadastro = sandbox.buildGuestCadastroConfirmadoHtml as (h: Row) => string;
  const renderDetail = sandbox.renderDetail as (r: Row) => void;
  // `const` de topo não vira propriedade do global: lê pelo escopo léxico do contexto.
  const select = vm.runInContext("FNRH_PAINEL_SELECT", sandbox as vm.Context) as string;
  assert.equal(typeof mapHospede, "function");
  assert.equal(typeof buildCadastro, "function");
  assert.equal(typeof renderDetail, "function");

  console.log("\n== Select de fnrh_hospedes ==");
  {
    assert.match(mvpSrc, /\.from\("fnrh_hospedes"\)[\s\S]{0,400}?\.select\(FNRH_PAINEL_SELECT\)/);
    assert.equal((mvpSrc.match(/\.from\("fnrh_hospedes"\)/g) || []).length, 1, "uma única consulta");
    ok("o select existente foi ampliado, sem segunda consulta");

    for (const c of ["id", "hospede_id", "status", "link_token", "reserva_id"]) {
      assert.ok(select.split(", ").includes(c), `${c} continua no select`);
    }
    for (const c of ["hospede_nome", "nome_social", "data_nascimento", "documento_tipo", "documento_numero", "fnrh_sync_status", "fnrh_sync_enviado_em", "fnrh_sync_erro", "completed_at"]) {
      assert.ok(select.split(", ").includes(c), `${c} entra no select`);
    }
    for (const c of ["confirmed_ip", "confirmed_user_agent", "snapshot_hash", "confirmation_snapshot", "assinatura_base64", "*"]) {
      assert.equal(select.split(", ").includes(c), false, `${c} não pode ser selecionado`);
    }
    ok("campos de exibição entram; IP, user-agent, hash, snapshot e assinatura ficam fora");
  }

  console.log("\n== Prioridade dos dados no mapper ==");
  {
    const h = mapHospede(hospedeRow, fnrhConfirmada(), reservaRow);
    assert.equal(h.nome, "Nome Civil Confirmado");
    assert.equal(h.nomeApresentacao, "Nome Social Confirmado");
    assert.equal(h.email, "confirmado@example.com");
    assert.equal(h.whatsapp, "5567999990000");
    assert.equal(h.dataNascimento, "1990-01-15");
    assert.equal(h.fnrhStatus, "enviado_oficial");
    ok("FNRH confirmada prevalece sobre operacional_hospedes");

    const rascunho = mapHospede(
      hospedeRow,
      fnrhConfirmada({ status: "rascunho", fnrh_lifecycle_status: "draft", hospede_nome: "Nome Em Rascunho" }),
      reservaRow,
    );
    assert.equal(rascunho.nome, "Nome Operacional Antigo");
    assert.equal(rascunho.nomeApresentacao, "Nome Operacional Antigo");
    assert.equal(rascunho.email, "operacional@example.com");
    assert.equal(rascunho.whatsapp, "5567988880000");
    assert.equal(rascunho.dataNascimento, "1980-02-02");
    assert.equal(rascunho.cadastroConfirmado, null);
    assert.ok(String(rascunho.fnrhLink).includes(LINK_TOKEN), "link de preenchimento continua montado");
    ok("FNRH em rascunho não substitui os dados operacionais");

    const pendente = mapHospede(
      hospedeRow,
      fnrhConfirmada({ status: "pendente", fnrh_lifecycle_status: null, hospede_nome: "Nome Prefill Hits" }),
      reservaRow,
    );
    assert.equal(pendente.nome, "Nome Operacional Antigo");
    assert.equal(pendente.cadastroConfirmado, null);
    ok("FNRH pendente (pré-preenchida) também não substitui");

    const semFnrh = mapHospede(hospedeRow, undefined, reservaRow);
    assert.equal(semFnrh.nome, "Nome Operacional Antigo");
    assert.equal(semFnrh.nomeApresentacao, "Nome Operacional Antigo");
    assert.equal(semFnrh.email, "operacional@example.com");
    assert.equal(semFnrh.cadastroConfirmado, null);
    assert.equal("fnrhLink" in semFnrh, false);
    ok("sem FNRH: operacional_hospedes");

    const soReserva = mapHospede({ ...hospedeRow, nome: "   ", email: "", whatsapp: null }, undefined, reservaRow);
    assert.equal(soReserva.nome, "Nome Da Reserva Hits");
    assert.equal(soReserva.nomeApresentacao, "Nome Da Reserva Hits");
    assert.equal(soReserva.email, "");
    ok("operacional vazio: dados básicos da reserva como último recurso");

    const acompanhante = mapHospede({ ...hospedeRow, principal: false, nome: "" }, undefined, reservaRow);
    assert.equal(acompanhante.nome, "", "acompanhante não herda o nome do titular da reserva");
    ok("fallback da reserva só vale para o hóspede principal");

    const semSocial = mapHospede(hospedeRow, fnrhConfirmada({ nome_social: "  " }), reservaRow);
    assert.equal(semSocial.nomeApresentacao, "Nome Civil Confirmado");
    assert.equal(semSocial.nome, "Nome Civil Confirmado");
    ok("sem nome social, apresentação = nome civil");

    const vazioNaFnrh = mapHospede(hospedeRow, fnrhConfirmada({ hospede_nome: "", email: " ", telefone: null, data_nascimento: null }), reservaRow);
    assert.equal(vazioNaFnrh.nome, "Nome Operacional Antigo");
    assert.equal(vazioNaFnrh.email, "operacional@example.com");
    assert.equal(vazioNaFnrh.whatsapp, "5567988880000");
    assert.equal(vazioNaFnrh.dataNascimento, "1980-02-02");
    ok("campo vazio na FNRH confirmada não apaga o valor operacional");

    const menor = mapHospede(
      { ...hospedeRow, principal: false, guest_role: "minor", is_minor: true, email: "responsavel@example.com", whatsapp: "5567977770000" },
      fnrhConfirmada({ hospede_nome: "Menor Confirmado", email: "confirmado@example.com" }),
      reservaRow,
    );
    assert.equal(menor.nome, "Menor Confirmado");
    assert.equal(menor.email, "responsavel@example.com");
    assert.equal(menor.whatsapp, "5567977770000");
    ok("menor: nome confirmado entra, contato segue o operacional (regra do fnrh-submit)");
  }

  console.log("\n== Snapshot exposto ao card ==");
  {
    const h = mapHospede(hospedeRow, fnrhConfirmada(), reservaRow);
    const c = h.cadastroConfirmado as Row;
    assert.equal(c.nomeCivil, "Nome Civil Confirmado");
    assert.equal(c.nomeSocial, "Nome Social Confirmado");
    assert.equal(c.dataNascimento, "1990-01-15");
    assert.equal(c.nacionalidade, "Brasileira");
    assert.equal(c.documentoTipo, "cpf");
    assert.equal(c.documentoNumero, "52998224725");
    assert.equal(c.cidade, "Campo Grande");
    assert.equal(c.uf, "MS");
    assert.equal(c.pais, "Brasil");
    assert.equal(c.syncStatus, "enviado");
    assert.equal(c.syncEnviadoEm, "2026-09-16T18:05:03.000Z");
    assert.equal(c.confirmadoEm, "2026-09-16T18:05:00.000Z");
    const texto = JSON.stringify(h);
    for (const secret of [LINK_TOKEN, IP_FALSO, UA_FALSO, HASH_FALSO]) {
      assert.equal(texto.replace(String(h.fnrhLink), "").includes(secret), false, `${secret} não pode estar no snapshot`);
    }
    ok("snapshot tem os campos da seção e nada de token, IP, user-agent ou hash");
  }

  console.log("\n== Seção \"Ver cadastro confirmado\" ==");
  {
    const h = mapHospede(hospedeRow, fnrhConfirmada(), reservaRow);
    const html = buildCadastro(h);
    assert.match(html, /<details class="detail-collapsible[^"]*">/);
    assert.match(html, /<summary class="detail-collapsible-summary">Ver cadastro confirmado<\/summary>/);
    assert.match(html, /guest-detail-readout/);
    ok("usa <details> + classes já existentes do painel");

    for (const [rotulo, valor] of [
      ["Nome civil", "Nome Civil Confirmado"],
      ["Nome social", "Nome Social Confirmado"],
      ["Data de nascimento", "15/01/1990"],
      ["Nacionalidade", "Brasileira"],
      ["Tipo de documento", "CPF"],
      ["Número do documento", "52998224725"],
      ["Endereço", "Rua Teste, 123, Centro, Campo Grande/MS, 79002-000, Brasil"],
      ["Cidade", "Campo Grande"],
      ["UF", "MS"],
      ["País", "Brasil"],
      ["Sincronização HITS", "Enviada"],
    ]) {
      assert.ok(html.includes(`<dt>${rotulo}</dt><dd>${valor}</dd>`), `${rotulo} = ${valor}`);
    }
    assert.match(html, /<dt>Confirmado em<\/dt><dd>[^<]+<\/dd>/);
    assert.match(html, /<dt>Enviado à HITS em<\/dt><dd>[^<]+<\/dd>/);
    assert.equal(html.includes("Erro de sincronização"), false, "sem erro, sem linha de erro");
    ok("mostra nome civil, social, nascimento, documento, endereço, confirmação e sync");

    const comErro = buildCadastro(mapHospede(hospedeRow, fnrhConfirmada({ status: "erro_sincronizacao", fnrh_sync_status: "erro", fnrh_sync_erro: "HTTP 502 gateway" }), reservaRow));
    assert.ok(comErro.includes("<dt>Sincronização HITS</dt><dd>Erro</dd>"));
    assert.ok(comErro.includes("<dt>Erro de sincronização</dt><dd>HTTP 502 gateway</dd>"));
    ok("erro de sincronização aparece resumido");

    for (const secret of [LINK_TOKEN, IP_FALSO, UA_FALSO, HASH_FALSO]) {
      assert.equal(html.includes(secret), false, `${secret} não pode aparecer`);
    }
    ok("token, IP, user-agent e snapshot_hash não aparecem");

    assert.equal(buildCadastro(mapHospede(hospedeRow, fnrhConfirmada({ status: "rascunho", fnrh_lifecycle_status: "draft" }), reservaRow)), "");
    assert.equal(buildCadastro(mapHospede(hospedeRow, undefined, reservaRow)), "");
    ok("seção só existe com FNRH confirmada");

    const escapado = buildCadastro(mapHospede(hospedeRow, fnrhConfirmada({ hospede_nome: "<img src=x onerror=1>" }), reservaRow));
    assert.equal(escapado.includes("<img"), false);
    ok("valores passam por escapeHtml");
  }

  console.log("\n== Card \"Hóspedes e contatos\" renderizado ==");
  {
    const reserva = mapReserva(reservaRow, [hospedeRow], [], [fnrhConfirmada()], []);
    renderDetail(reserva);
    const html = detailBody.innerHTML;
    assert.ok(html.includes("Hóspedes e contatos"), "card presente");
    const i = html.indexOf('<div class="guest-detail-card');
    assert.ok(i > -1, "card do hóspede renderizado");
    const card = html.slice(i, html.indexOf("</div>\n", html.indexOf("</details>", i)) + 6);

    assert.match(card, /<p class="guest-detail-nome">Nome Social Confirmado<\/p>/);
    ok("nome de apresentação = nome social confirmado");
    assert.match(card, /<p class="guest-detail-role">Principal · Adulto<\/p>/);
    ok("indicação Principal · Adulto mantida");
    assert.match(card, /<p class="guest-detail-fnrh-line">FNRH concluída<\/p>/);
    ok("status da FNRH mantido");
    assert.ok(card.includes("<dt>E-mail</dt><dd>confirmado@example.com</dd>"), "e-mail confirmado");
    assert.match(card, /<dt>Telefone<\/dt><dd>[^<]*9999[^<]*0000<\/dd>/);
    ok("telefone e e-mail visíveis, com prioridade da FNRH");
    assert.ok(card.includes("Ver cadastro confirmado"));
    assert.ok(card.includes("<dt>Nome civil</dt><dd>Nome Civil Confirmado</dd>"));
    ok("nome civil preservado nos detalhes");
    assert.ok(card.includes("guest-copiar-fnrh-btn"), "botão de copiar link continua");
    for (const secret of [IP_FALSO, UA_FALSO, HASH_FALSO]) {
      assert.equal(html.includes(secret), false, `${secret} não pode ir ao DOM`);
    }
    // O token só pode existir no atributo do botão de copiar link (já era assim).
    const semBotao = html.replace(/data-fnrh-link="[^"]*"/g, "");
    assert.equal(semBotao.includes(LINK_TOKEN), false, "token fora do botão de link");
    ok("IP, user-agent e hash não vão ao DOM; token só no link de preenchimento existente");

    const reservaRascunho = mapReserva(reservaRow, [hospedeRow], [], [fnrhConfirmada({ status: "rascunho", fnrh_lifecycle_status: "draft" })], []);
    renderDetail(reservaRascunho);
    assert.equal(detailBody.innerHTML.includes("Ver cadastro confirmado"), false);
    assert.match(detailBody.innerHTML, /<p class="guest-detail-nome">Nome Operacional Antigo<\/p>/);
    ok("com rascunho: sem seção, nome operacional");
  }

  console.log("\n== Texto do fluxo FNRH (ui/fnrh-checkin-v2.js) ==");
  {
    assert.equal(v2Src.includes("Check-in concluído"), false);
    assert.ok(v2Src.includes("<h2>Cadastro concluído com sucesso</h2>"));
    assert.ok(v2Src.includes("Os dados da sua FNRH foram atualizados com sucesso."));
    ok("título final neutro: cadastro concluído, sem afirmar check-in");
    assert.equal(v2Src.includes("Confirmar check-in"), false);
    assert.match(v2Src, /nextLabel = state\.confirmBusy \? "Confirmando…" : "Confirmar e enviar";/);
    ok("botão da etapa de aceite: Confirmar e enviar");
    assert.ok(v2Src.includes("<h1>Check-in digital</h1>"), "demais textos preservados");
    ok("outros textos do formulário intocados");
  }

  console.log(`\nOK test-fnrh-cadastro-confirmado-painel (${cases} casos)`);
}

main();
