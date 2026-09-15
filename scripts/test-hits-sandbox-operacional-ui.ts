/**
 * Testes: reservas HITS Sandbox alimentando a listagem operacional.
 * Somente leitura — nenhuma ação operacional pode ser oferecida.
 * Determinísticos, sem rede (fetch stub) e sem browser (node:vm).
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

type PreviewApi = {
  toReservaOperacional: (row: Record<string, unknown>) => Record<string, unknown>;
  isReadOnlyId: (id: string) => boolean;
  fetchReservasOperacionais: (options?: {
    force?: boolean;
  }) => Promise<Array<Record<string, unknown>>>;
  onCycle: (fn: (result: { ok: boolean; rows: unknown[] }) => void) => void;
  loadCycle: (options?: { force?: boolean }) => Promise<{
    ok: boolean;
    raw: unknown[];
    rows: unknown[];
  }>;
  READ_ONLY_ID_PREFIX: string;
};

/** Carrega o módulo de UI num contexto isolado, com document/auth stubados. */
function loadPreview(fetchImpl?: unknown): PreviewApi {
  const src = readFileSync(resolve(ROOT, "ui/yes-hits-sandbox-preview.js"), "utf8");
  const sandbox: Record<string, unknown> = {
    console,
    // querySelector devolve null para o painel → o módulo não faz binding de DOM,
    // mas ainda expõe a API. Um elemento basta para passar do early return.
    document: {
      querySelector: (sel: string) =>
        sel === "#op-hits-sandbox-panel" ? { classList: { toggle() {} } } : null,
      createElement: () => ({ appendChild() {}, classList: { toggle() {} } }),
    },
    YES_HOTEL_SUPABASE_CONFIG: { url: "https://homo.example.supabase.co" },
    YesHotelAuthApp: {
      getEdgeFunctionFetchHeaders: async () => ({ Authorization: "Bearer jwt-do-usuario" }),
    },
    fetch: fetchImpl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return (sandbox as { YesHotelHitsSandboxPreview: PreviewApi }).YesHotelHitsSandboxPreview;
}

const ROW = {
  external_reservation_id: "17613",
  apartamento: "07",
  hospede_principal: "Hospede Sintetico",
  check_in: "2026-09-20",
  check_out: "2026-09-23",
  status_reserva: "ativa",
  total_hospedes: 2,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function main() {
  console.log("\n== Mapeamento HITS → listagem operacional ==");
  {
    const api = loadPreview();
    const r = api.toReservaOperacional(ROW);
    assert.equal(r.externalReservationId, "17613");
    assert.equal(r.apartamento, "07");
    assert.equal(r.hospedePrincipal, "Hospede Sintetico");
    assert.equal(r.checkInPrevisto, "2026-09-20");
    assert.equal(r.checkOutPrevisto, "2026-09-23");
    assert.equal(r.statusReserva, "ativa");
    assert.equal(r.totalHospedesHits, 2);
    ok("os 7 campos pedidos chegam à listagem");

    assert.equal(r.somenteLeituraHits, true);
    assert.equal(r.origemExterna, "hits_preview");
    assert.equal(api.isReadOnlyId(String(r.id)), true);
    assert.match(String(r.id), /17613$/);
    ok("marcada como somente leitura, id sintético carrega o idReservation");
  }
  {
    const api = loadPreview();
    const semApto = api.toReservaOperacional({ ...ROW, apartamento: "" });
    assert.equal(semApto.apartamento, "");
    const semPax = api.toReservaOperacional({ ...ROW, total_hospedes: 0 });
    assert.equal(semPax.totalHospedesHits, 1);
    const cancelada = api.toReservaOperacional({ ...ROW, status_reserva: "cancelada" });
    assert.equal(cancelada.statusReserva, "cancelada");
    ok("apartamento ausente fica vazio (a tela mostra —), sem inventar valor");
  }
  {
    const api = loadPreview();
    const r = api.toReservaOperacional(ROW);
    // Campos que disparariam ação operacional precisam vir neutros.
    assert.equal(r.acessoLiberado, false);
    assert.equal(r.entrouNoApto, false);
    assert.equal(r.pagamentoPresencialDiferidoAutorizado, false);
    // Arrays nascem no realm do vm: comparar tamanho, não identidade de protótipo.
    assert.equal((r.hospedes as unknown[]).length, 0);
    assert.equal((r.cobrancasPagarme as unknown[]).length, 0);
    assert.equal((r.pagamentosPagarme as unknown[]).length, 0);
    assert.equal(r.fnrhStatusAgregado, null);
    ok("estado operacional neutro — nada a executar");
  }

  console.log("\n== Busca da Edge ==");
  {
    const calls: Array<{ url: string; method: string }> = [];
    const api = loadPreview(async (url: string, init: { method: string }) => {
      calls.push({ url, method: init.method });
      return jsonResponse({ ok: true, rows: [ROW, { ...ROW, external_reservation_id: "17614" }] });
    });
    const out = await api.fetchReservasOperacionais();
    assert.equal(out.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "GET");
    assert.match(calls[0]!.url, /\/functions\/v1\/hits-reservations-preview$/);
    ok("GET único na Edge, linhas já no formato da listagem");
  }
  {
    // Painel + grade + KPIs consomem o mesmo ciclo: uma leitura, não duas.
    let calls = 0;
    const api = loadPreview(async () => {
      calls += 1;
      return jsonResponse({ ok: true, rows: [ROW] });
    });
    const [a, b] = await Promise.all([
      api.fetchReservasOperacionais(),
      api.fetchReservasOperacionais(),
    ]);
    assert.equal(calls, 1, "chamadas concorrentes compartilham a promise");
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);

    await api.fetchReservasOperacionais();
    assert.equal(calls, 1, "sem force, reusa o resultado do ciclo");

    await api.fetchReservasOperacionais({ force: true });
    assert.equal(calls, 2, "force inicia um ciclo novo");
    ok("uma única leitura HITS por ciclo, compartilhada");
  }
  {
    // Regressão: o ciclo passou a entregar só o shape transformado e o painel
    // técnico, que lê o shape da Edge, esvaziou idReservation/nome/datas.
    let calls = 0;
    const api = loadPreview(async () => {
      calls += 1;
      return jsonResponse({ ok: true, rows: [ROW] });
    });
    const cycle = await api.loadCycle();
    assert.equal(calls, 1, "uma leitura só");

    // raw = shape da Edge, para o painel técnico
    const raw = cycle.raw as Array<Record<string, unknown>>;
    assert.equal(raw.length, 1);
    assert.equal(raw[0]!.external_reservation_id, "17613");
    assert.equal(raw[0]!.hospede_principal, "Hospede Sintetico");
    assert.equal(raw[0]!.check_in, "2026-09-20");
    assert.equal(raw[0]!.check_out, "2026-09-23");
    assert.equal(raw[0]!.status_reserva, "ativa");
    assert.equal(raw[0]!.total_hospedes, 2);

    // rows = shape da listagem operacional, para a grade
    const rows = cycle.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.externalReservationId, "17613");
    assert.equal(rows[0]!.checkInPrevisto, "2026-09-20");
    assert.equal(rows[0]!.somenteLeituraHits, true);

    // Os dois shapes são distintos: trocar um pelo outro quebra a tela.
    assert.equal(raw[0]!.externalReservationId, undefined);
    assert.equal(rows[0]!.external_reservation_id, undefined);
    ok("um ciclo entrega raw (painel) e rows (grade), sem segunda chamada");
  }
  {
    const js = readFileSync(resolve(ROOT, "ui/yes-hits-sandbox-preview.js"), "utf8");
    assert.match(js, /renderRows\(result\.raw/, "painel precisa renderizar o raw");
    assert.doesNotMatch(
      js,
      /renderRows\(result\.rows\)/,
      "renderRows não pode receber o shape transformado",
    );
    ok("renderCycle alimenta o painel com o shape correto");
  }
  {
    const api = loadPreview(async () => jsonResponse({ ok: false, error: "x" }, 502));
    assert.equal((await api.fetchReservasOperacionais()).length, 0);
    ok("Edge com erro → lista vazia, a tela operacional não quebra");
  }
  {
    const api = loadPreview(async () => {
      throw new Error("rede caiu");
    });
    assert.equal((await api.fetchReservasOperacionais()).length, 0);
    ok("falha de rede → lista vazia, sem exceção");
  }
  {
    const api = loadPreview(async () =>
      jsonResponse({ ok: true, rows: [{ ...ROW, external_reservation_id: "" }] }),
    );
    assert.equal((await api.fetchReservasOperacionais()).length, 0);
    ok("linha sem idReservation é descartada");
  }

  console.log("\n== Guards na tela operacional ==");
  {
    const src = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");

    assert.match(src, /function isReservaSomenteLeituraHits/);
    ok("guard existe");

    // Cada ponto que oferece ação precisa consultar o guard.
    for (const fn of [
      "canShowPresencialDiferidoBtn",
      "listaProximaAcaoOperacional",
      "derivarStatusOperacional",
      "linhaFluxoResumo",
      "openDetail",
      "getFilaOperacionalRank",
      "derivarExcecaoOperacionalReserva",
      "reservaOcultaDaListaPadraoOperacional",
    ]) {
      const body = src.slice(src.indexOf(`function ${fn}(`));
      const head = body.slice(0, 500);
      assert.match(head, /isReservaSomenteLeituraHits/, `${fn} não consulta o guard`);
    }
    ok("PPD, CTA, badge, fluxo, detalhe, fila e exceções respeitam o guard");

    assert.match(src, /loadReservasSomenteLeituraHits/);
    assert.match(src, /jaNoBanco/);
    ok("merge em memória com dedupe por external_reservation_id");

    // Regressão: o init travava no await da leitura HITS e nunca chegava a
    // registrar os listeners — grade vazia e botão Atualizar inerte.
    const initLoad = src.indexOf("reservas = (await loadReservasOperacionaisFromProvider()) || []");
    assert.ok(initLoad > -1, "init deve carregar o banco sem esperar o HITS");
    const depoisDoInit = src.slice(initLoad, initLoad + 400);
    assert.match(
      depoisDoInit,
      /aplicarLeituraHitsQuandoPronta\(\)/,
      "init precisa disparar a leitura HITS sem bloquear",
    );
    ok("boot carrega o banco e aplica HITS sem bloquear o init");

    assert.match(src, /async function refreshFromSource[\s\S]{0,200}force: true/);
    ok("Atualizar força um ciclo novo de leitura HITS");

    // Nenhuma escrita a partir das reservas HITS.
    assert.doesNotMatch(src, /somenteLeituraHits[\s\S]{0,200}\.insert\(/);
    assert.doesNotMatch(src, /somenteLeituraHits[\s\S]{0,200}\.update\(/);
    ok("nenhum insert/update no caminho somente leitura");
  }
  {
    const html = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.html"), "utf8");
    const iPreview = html.indexOf("yes-hits-sandbox-preview.js");
    const iPanel = html.indexOf("checkin-operacional-mvp.js");
    assert.ok(iPreview > -1 && iPanel > -1);
    assert.ok(iPreview < iPanel, "preview precisa ser avaliado antes do painel");
    ok("ordem dos scripts garante a API disponível no init");
  }

  console.log("\n== Painel compacto ==");
  {
    const html = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.html"), "utf8");

    // Barra compacta com tudo que o estado recolhido precisa mostrar.
    for (const id of [
      "op-hits-sandbox-badge",
      "op-hits-sandbox-count",
      "op-hits-sandbox-updated",
      "op-hits-sandbox-refresh",
      "op-hits-sandbox-toggle",
      "op-hits-sandbox-details",
    ]) {
      assert.ok(html.includes(`id="${id}"`), `faltou ${id}`);
    }
    assert.match(html, /Leitura direta via API HITS — somente leitura/);
    assert.match(html, />\s*Atualizar HITS\s*</);
    ok("barra compacta traz badge, contagem, hora, hint e ações");

    const details = html.slice(html.indexOf('id="op-hits-sandbox-details"'));
    assert.match(
      details.slice(0, 120),
      /class="op-hits-details hidden"/,
      "diagnóstico deve nascer recolhido",
    );
    const toggle = html.slice(html.indexOf('id="op-hits-sandbox-toggle"'));
    assert.match(toggle.slice(0, 200), /aria-expanded="false"/);
    assert.match(toggle.slice(0, 200), /aria-controls="op-hits-sandbox-details"/);
    ok("tabela técnica recolhida por padrão, com aria correto");

    // A tabela técnica continua existindo, só que dentro do bloco recolhido.
    for (const col of ["idReservation", "Apto", "Hóspede", "Entrada", "Saída", "Status"]) {
      assert.ok(details.includes(col), `coluna ${col} sumiu do diagnóstico`);
    }
    ok("colunas técnicas preservadas dentro do diagnóstico");

    const js = readFileSync(resolve(ROOT, "ui/yes-hits-sandbox-preview.js"), "utf8");
    assert.match(js, /function setDetailsOpen/);
    assert.match(js, /setDetailsOpen\(!isDetailsOpen\(\)\)/, "toggle abre e fecha");
    assert.match(js, /setDetailsOpen\(false\)/, "estado inicial recolhido");
    assert.match(js, /function renderResumo/);
    ok("toggle alterna e o resumo alimenta a barra");
  }

  console.log(`\nOK test-hits-sandbox-operacional-ui (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
