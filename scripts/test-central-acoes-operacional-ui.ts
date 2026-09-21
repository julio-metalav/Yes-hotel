/**
 * Central de ações do detalhe da reserva (ui/checkin-operacional-mvp.js).
 *
 * Painel carregado em node:vm, como em test-fnrh-cadastro-confirmado-painel.ts:
 * renderDetail é exercitado com linhas sintéticas e o HTML gerado é conferido.
 * Cobre os cenários FNRH pendente / enviada / concluída, senha não gerada /
 * gerada / enviada, contato ausente / preenchido e o layout mobile (CSS).
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
const cssSrc = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.css"), "utf8");
const htmlSrc = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.html"), "utf8");

type Row = Record<string, unknown>;
type Stub = Record<string, unknown> & {
  classList: { add(c: string): void; remove(...cs: string[]): void; toggle(): void; contains(c: string): boolean; has(c: string): boolean };
};

function stubEl(): Stub {
  const classes = new Set<string>();
  return {
    classList: {
      add: (c: string) => classes.add(c),
      remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
      toggle() {},
      contains: (c: string) => classes.has(c),
      has: (c: string) => classes.has(c),
    },
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
  };
}

/** Sandbox do painel; `#reservation-detail-body` é um HTMLElement do próprio realm. */
function loadPainel() {
  // escapeHtml do painel usa div.textContent → div.innerHTML: o stub precisa escapar.
  const escEl = (): Record<string, unknown> => {
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
  const detailBody = Object.assign(new HTMLElement(), stubEl()) as unknown as { innerHTML: string };
  const byId: Record<string, Stub> = {};
  const sandbox: Record<string, unknown> = {
    console,
    Intl,
    Date,
    document: {
      querySelector: (sel: string) => (sel === "#reservation-detail-body" ? detailBody : null),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => escEl(),
      getElementById: (id: string) => byId[id] || null,
      body: stubEl(),
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
  return { sandbox, detailBody, byId };
}

const RESERVA_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FNRH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function reservaRow(partial: Row = {}): Row {
  return {
    id: RESERVA_ID,
    apartamento: "12",
    hospede_principal: "Hospede Teste Central",
    external_reservation_id: "17999",
    check_in_previsto: "2026-09-20",
    check_out_previsto: "2026-09-23",
    status_reserva: "ativa",
    pagamento_status: "pago",
    fnrh_status_agregado: "fnrh_pendente",
    acesso_liberado: false,
    senha_enviada_em: null,
    ...partial,
  };
}

function hospedeRow(partial: Row = {}): Row {
  return {
    id: GUEST_ID,
    reserva_id: RESERVA_ID,
    nome: "Hospede Teste Central",
    principal: true,
    guest_role: "primary_adult",
    is_minor: false,
    email: "central@example.com",
    whatsapp: "5567999990000",
    status_operacional: "pronto_para_envio",
    ...partial,
  };
}

function fnrhConfirmadaRow(): Row {
  return {
    id: FNRH_ID,
    hospede_id: GUEST_ID,
    reserva_id: RESERVA_ID,
    status: "enviado_oficial",
    fnrh_lifecycle_status: "completed",
    link_token: "tok-teste",
    hospede_nome: "Hospede Teste Central",
    nome_social: "",
    data_nascimento: "1990-01-15",
    nacionalidade: "Brasileira",
    documento_tipo: "cpf",
    documento_numero: "52998224725",
    cidade: "Campo Grande",
    uf: "MS",
    pais: "Brasil",
    email: "central@example.com",
    telefone: "5567999990000",
    completed_at: "2026-09-16T18:05:00.000Z",
    preenchido_em: "2026-09-16T18:05:00.000Z",
    fnrh_sync_status: "enviado",
    fnrh_sync_enviado_em: "2026-09-16T18:05:03.000Z",
    fnrh_sync_erro: null,
  };
}

/** Recorta o bloco da Central (até o painel de contato / contexto / próxima seção). */
function centralDe(html: string): string {
  const start = html.indexOf('<div class="detail-central-acoes"');
  assert.ok(start > -1, "Central de ações presente no detalhe");
  const ends = [
    html.indexOf('<div class="detail-top-contato-panel', start),
    html.indexOf('<div class="detail-top-context', start),
    html.indexOf('<div class="reservation-detail-section reservation-detail-origem', start),
  ].filter((i) => i > start);
  const end = ends.length ? Math.min(...ends) : html.indexOf("</div>\n", start);
  return html.slice(start, end);
}

function itemDe(central: string, key: "fnrh" | "senha"): string {
  const start = central.indexOf(`<div class="detail-central-item detail-central-item--${key}`);
  assert.ok(start > -1, `item ${key} presente`);
  const other = key === "fnrh" ? central.indexOf('<div class="detail-central-item detail-central-item--senha') : central.length;
  return central.slice(start, other);
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function main() {
  const { sandbox, detailBody, byId } = loadPainel();
  const mapReserva = sandbox.mapDbReservaToInternal as (r: Row, h: Row[], e: Row[], f: Row[], s: Row[]) => Row;
  const renderDetail = sandbox.renderDetail as (r: Row) => void;
  const openTopContatoPanel = sandbox.openTopContatoPanel as (rid: string, modo: string) => void;
  assert.equal(typeof mapReserva, "function");
  assert.equal(typeof renderDetail, "function");
  assert.equal(typeof openTopContatoPanel, "function");

  function render(r: Row, hs: Row[], fnrh: Row[] = [], patch: (reserva: Row) => void = () => {}): string {
    const reserva = mapReserva(r, hs, [], fnrh, []);
    patch(reserva);
    // `let reservas` de topo: só acessível pelo escopo léxico do contexto.
    (sandbox as { __reservaTeste?: Row }).__reservaTeste = reserva;
    vm.runInContext("reservas = [globalThis.__reservaTeste];", sandbox as vm.Context);
    renderDetail(reserva);
    return detailBody.innerHTML;
  }

  console.log("\n== Estrutura: Central visível, sem 'Mais ações', ids únicos ==");
  {
    const html = render(reservaRow(), [hospedeRow()]);
    const central = centralDe(html);
    assert.match(central, /<p class="detail-acao-kicker">Central de ações<\/p>/);
    assert.ok(central.includes('<p class="detail-central-item-title">FNRH</p>'));
    assert.ok(central.includes('<p class="detail-central-item-title">Senha de acesso</p>'));
    ok("Central de ações com FNRH e Senha separadas");

    assert.equal(html.includes("Mais ações"), false);
    assert.equal(html.includes("detail-mais-acoes"), false);
    assert.equal(mvpSrc.includes("detail-mais-acoes-sum"), false, "nada mais gera o <details> Mais ações");
    ok("ações não dependem mais de abrir 'Mais ações'");

    assert.ok(html.indexOf('id="detail-central-acoes"') < html.indexOf("Hóspedes e contatos"), "Central antes do card de hóspedes");
    assert.ok(html.indexOf("reservation-detail-top-hero") > -1 && html.indexOf("reservation-detail-top-hero") < html.indexOf('id="detail-central-acoes"'), "Central dentro do card do topo");
    ok("Central em posição de destaque (topo do drawer)");

    for (const id of ["detail-enviar-links-btn", "detail-enviar-senha-btn", "detail-top-contato-panel", "detail-central-acoes"]) {
      assert.ok(count(html, `id="${id}"`) <= 1, `${id} no máximo uma vez`);
    }
    ok("ids não duplicados entre Próxima ação e Central");

    for (const jargao of ["HOMO", "homolog", "sandbox", "Sandbox"]) {
      assert.equal(central.includes(jargao), false, `sem "${jargao}" na Central`);
    }
    ok("sem linguagem de homologação na Central");
  }

  console.log("\n== 1. FNRH pendente ==");
  {
    const html = render(reservaRow(), [hospedeRow()]);
    const central = centralDe(html);
    const fnrh = itemDe(central, "fnrh");
    assert.match(fnrh, /<p class="detail-central-item-estado is-pending">Pendente<\/p>/);
    assert.ok(fnrh.includes('id="detail-enviar-links-btn"'), "botão de enviar link");
    assert.match(fnrh, /id="detail-enviar-links-btn"[^>]*>Enviar link FNRH<\/button>/);
    assert.equal(fnrh.includes("detail-reenviar-fnrh-topo-btn"), false);
    assert.ok(fnrh.includes("is-recomendada"), "FNRH é a ação recomendada");
    assert.match(fnrh, /class="primary-button detail-top-acao-btn detail-enviar-links-btn"/);
    assert.ok(fnrh.includes("Link ainda não enviado ao hóspede."));
    ok("FNRH pendente → 'Enviar link FNRH' em destaque");
  }

  console.log("\n== 2. FNRH enviada ==");
  {
    const html = render(reservaRow(), [hospedeRow({ status_operacional: "enviado" })]);
    const fnrh = itemDe(centralDe(html), "fnrh");
    assert.match(fnrh, /<p class="detail-central-item-estado is-pending">Pendente<\/p>/);
    assert.equal(fnrh.includes("detail-enviar-links-btn"), false);
    assert.match(fnrh, /id="detail-reenviar-fnrh-topo-btn"[^>]*>Reenviar link FNRH<\/button>/);
    assert.ok(fnrh.includes("Link enviado. Aguardando o hóspede preencher."));
    assert.ok(fnrh.includes("is-recomendada"));
    ok("FNRH enviada → 'Reenviar link FNRH'");
  }

  console.log("\n== 3. FNRH concluída ==");
  {
    const html = render(
      reservaRow({ fnrh_status_agregado: "fnrh_completo" }),
      [hospedeRow({ status_operacional: "confirmado" })],
      [fnrhConfirmadaRow()],
    );
    const fnrh = itemDe(centralDe(html), "fnrh");
    assert.match(fnrh, /<p class="detail-central-item-estado is-ok">Concluída<\/p>/);
    assert.equal(fnrh.includes("<button"), false, "sem botão de FNRH");
    assert.ok(fnrh.includes("Nenhuma ação necessária"));
    ok("FNRH concluída → sem ação, estado verde");

    assert.ok(html.includes("Ver cadastro confirmado"), "seção do cadastro confirmado continua");
    assert.ok(html.includes("<dt>Nome civil</dt><dd>Hospede Teste Central</dd>"));
    ok("'Ver cadastro confirmado' segue funcionando");
  }

  console.log("\n== 4. Senha não gerada ==");
  {
    // Com FNRH pendente: pendência listada, só o combinado 'Gerar e enviar senha'.
    const html = render(reservaRow(), [hospedeRow()]);
    const senha = itemDe(centralDe(html), "senha");
    assert.match(senha, /<p class="detail-central-item-estado is-pending">Não gerada<\/p>/);
    assert.ok(senha.includes("Aguardando FNRH."));
    assert.equal(senha.includes("detail-gerar-senha-btn"), false, "sem 'Gerar senha' enquanto há pendência");
    assert.match(senha, /id="detail-enviar-senha-btn"[^>]*data-acao-credencial="gerar_enviar"[^>]*>Gerar e enviar senha<\/button>/);
    assert.match(senha, /class="secondary-button detail-top-acao-btn detail-enviar-senha-btn"/);
    assert.equal(senha.includes("is-recomendada"), false);
    ok("não gerada com pendência → 'Gerar e enviar senha' secundário, sem destaque");

    // Pagamento e FNRH ok: 'Gerar senha' (liberar acesso) em destaque + combinado.
    const html2 = render(
      reservaRow({ fnrh_status_agregado: "fnrh_completo" }),
      [hospedeRow({ status_operacional: "confirmado" })],
    );
    const senha2 = itemDe(centralDe(html2), "senha");
    assert.match(senha2, /<p class="detail-central-item-estado is-pending">Não gerada<\/p>/);
    assert.ok(senha2.includes("Pagamento e FNRH em dia. Pode gerar a senha."));
    assert.match(senha2, /id="detail-gerar-senha-btn"[^>]*data-recomendacao-cta="liberar_acesso"[^>]*>Gerar senha<\/button>/);
    assert.match(senha2, /class="primary-button detail-top-acao-btn detail-recomendacao-cta-btn detail-gerar-senha-btn"/);
    assert.match(senha2, /id="detail-enviar-senha-btn"[^>]*>Gerar e enviar senha<\/button>/);
    assert.ok(senha2.includes("is-recomendada"));
    assert.equal(html2.includes('data-recomendacao-cta="liberar_acesso"'), true);
    assert.equal(count(html2, 'data-recomendacao-cta="liberar_acesso"'), 1, "liberar_acesso só na Central");
    ok("pronta → 'Gerar senha' (liberar acesso) em destaque, sem duplicar CTA");
  }

  console.log("\n== 5. Senha gerada e não enviada ==");
  {
    const html = render(
      reservaRow({ fnrh_status_agregado: "fnrh_completo", acesso_liberado: true }),
      [hospedeRow({ status_operacional: "confirmado" })],
    );
    const senha = itemDe(centralDe(html), "senha");
    assert.match(senha, /<p class="detail-central-item-estado is-pending">Gerada, não enviada<\/p>/);
    assert.equal(senha.includes("detail-gerar-senha-btn"), false);
    assert.match(senha, /id="detail-enviar-senha-btn"[^>]*data-acao-credencial="gerar_enviar"[^>]*>Enviar senha<\/button>/);
    assert.match(senha, /class="primary-button detail-top-acao-btn detail-enviar-senha-btn"/);
    assert.ok(senha.includes("is-recomendada"));
    assert.equal(senha.includes("detail-gerar-nova-senha-btn"), false);
    ok("gerada e não enviada → 'Enviar senha' em destaque");
  }

  console.log("\n== 6. Senha já enviada ==");
  {
    const html = render(
      reservaRow({ fnrh_status_agregado: "fnrh_completo", acesso_liberado: true, senha_enviada_em: "2026-09-19T15:30:00.000Z" }),
      [hospedeRow({ status_operacional: "confirmado" })],
      [],
      (reserva) => {
        reserva.ttlockPrincipalTodosProvisionados = true;
      },
    );
    const senha = itemDe(centralDe(html), "senha");
    assert.match(senha, /<p class="detail-central-item-estado is-ok">Enviada<\/p>/);
    assert.match(senha, /Enviada em [^<]+\./);
    assert.match(senha, /id="detail-enviar-senha-btn"[^>]*data-acao-credencial="reenviar"[^>]*>Reenviar senha<\/button>/);
    assert.match(senha, /id="detail-gerar-nova-senha-btn"[^>]*>Gerar nova senha<\/button>/);
    assert.equal(senha.includes("detail-gerar-senha-btn"), false);
    ok("enviada → 'Reenviar senha' + 'Gerar nova senha'");

    const htmlInconsistente = render(
      reservaRow({ fnrh_status_agregado: "fnrh_completo", acesso_liberado: true, senha_enviada_em: "2026-09-19T15:30:00.000Z" }),
      [hospedeRow({ status_operacional: "confirmado" })],
    );
    const senhaInc = itemDe(centralDe(htmlInconsistente), "senha");
    assert.match(senhaInc, /<p class="detail-central-item-estado is-error">Enviada<\/p>/);
    assert.ok(senhaInc.includes("Inconsistência"));
    ok("enviada sem provisionamento → estado em vermelho com o aviso já existente");
  }

  console.log("\n== 7. Contato ausente ==");
  {
    const html = render(reservaRow(), [hospedeRow({ email: "", whatsapp: "", status_operacional: "aguardando_contato" })]);
    const central = centralDe(html);
    const fnrh = itemDe(central, "fnrh");
    assert.equal(fnrh.includes("<button"), false, "sem botão de envio sem contato");
    assert.ok(fnrh.includes("Falta e-mail ou WhatsApp. Corrija o contato no cartão do hóspede."));
    assert.ok(html.includes("Corrigir contato"), "botão 'Corrigir contato' do cartão do hóspede continua");
    ok("sem contato → FNRH orienta a corrigir; envio indisponível");
  }

  console.log("\n== 8. Contato preenchido: painel de confirmação antes do envio ==");
  {
    const html = render(reservaRow(), [hospedeRow()]);
    assert.ok(html.includes('id="detail-top-contato-panel"'));
    assert.ok(html.includes('id="detail-top-contato-email"'));
    assert.ok(html.includes('id="detail-top-contato-whatsapp"'));
    assert.ok(html.includes('id="detail-top-contato-confirm"'));
    assert.ok(html.indexOf('id="detail-central-acoes"') < html.indexOf('id="detail-top-contato-panel"'), "painel logo após a Central");
    ok("painel de contato (e-mail / WhatsApp) presente junto da Central");

    // Handlers atuais: botões da Central abrem o painel de contato.
    const bind = mvpSrc.slice(mvpSrc.indexOf("function bindDetailListeners("), mvpSrc.indexOf("function humanizarMensagemModalEnviarSenha("));
    assert.match(bind, /#detail-enviar-links-btn[\s\S]{0,200}openTopContatoPanel\(rid, "fnrh"\)/);
    assert.match(bind, /#detail-reenviar-fnrh-topo-btn[\s\S]{0,200}openTopContatoPanel\(rid, "fnrh_reenviar"\)/);
    assert.match(bind, /#detail-enviar-senha-btn[\s\S]{0,900}openTopContatoPanel\(rid, acao === "reenviar" \? "senha_reenviar" : "senha"\)/);
    assert.match(bind, /#detail-gerar-nova-senha-btn[\s\S]{0,900}openTopContatoPanel\(rid, "senha_nova"\)/);
    assert.match(bind, /\.detail-recomendacao-cta-btn[\s\S]{0,200}executeRecomendacaoCta\(reserva\.id, kind\)/);
    ok("botões reutilizam os handlers existentes (painel de contato / CTA)");

    // openTopContatoPanel preenche com o contato atual e ajusta o título por modo.
    for (const id of ["detail-top-contato-panel", "detail-top-contato-email", "detail-top-contato-whatsapp", "detail-top-contato-title", "detail-top-contato-msg"]) {
      byId[id] = stubEl();
    }
    byId["detail-top-contato-panel"].classList.add("hidden");
    openTopContatoPanel(RESERVA_ID, "fnrh");
    assert.equal(byId["detail-top-contato-panel"].classList.has("hidden"), false, "painel visível");
    assert.equal(byId["detail-top-contato-email"].value, "central@example.com");
    assert.equal(byId["detail-top-contato-whatsapp"].value, "5567999990000");
    assert.equal(byId["detail-top-contato-title"].textContent, "Confirme o contato e envie o link FNRH");
    openTopContatoPanel(RESERVA_ID, "senha");
    assert.equal(byId["detail-top-contato-title"].textContent, "Confirme o contato e envie as credenciais");
    openTopContatoPanel(RESERVA_ID, "senha_reenviar");
    assert.equal(byId["detail-top-contato-title"].textContent, "Confirme o contato e reenvie as credenciais");
    ok("painel abre com telefone/e-mail atuais para conferir antes de enviar");

    // Regra de envio inalterada: exige e-mail ou WhatsApp.
    assert.ok(mvpSrc.includes('msgEl.textContent = "Informe pelo menos e-mail ou WhatsApp.";'));
    ok("envio continua exigindo pelo menos um contato");
  }

  console.log("\n== 9. Mobile / CSS ==");
  {
    assert.match(cssSrc, /\.op-detail__scroll \.detail-central-acoes-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    const mobile = cssSrc.slice(cssSrc.indexOf(".op-detail__scroll .detail-central-acoes {"));
    assert.match(mobile, /@media \(max-width: 767px\) \{\s*\.op-detail__scroll \.detail-central-acoes-grid \{\s*grid-template-columns: 1fr;/);
    assert.match(cssSrc, /\.op-detail__scroll \.detail-central-item-acoes \.secondary-button \{[^}]*width: 100%;/);
    ok("duas colunas no desktop, uma coluna até 767px, botões em largura total");

    assert.match(htmlSrc, /checkin-operacional-mvp\.css\?v=63/);
    assert.match(htmlSrc, /checkin-operacional-mvp\.js\?v=59/);
    ok("cache-buster do CSS/JS atualizado");
  }

  console.log("\n== Preservação: HITS, payload, Edge, banco ==");
  {
    assert.equal(mvpSrc.includes("labelAcaoCredenciaisPainel(reserva)"), true, "política de credenciais continua em uso na recomendação");
    assert.ok(mvpSrc.includes("function avaliarPoliticaCredenciaisReserva("));
    assert.ok(mvpSrc.includes("async function backendLiberarAcesso("));
    assert.ok(mvpSrc.includes("async function backendEnviarSenha("));
    assert.ok(mvpSrc.includes("async function backendEnviarLinks("));
    ok("handlers de backend existentes preservados");
  }

  console.log(`\nOK test-central-acoes-operacional-ui (${cases} casos)`);
}

main();
