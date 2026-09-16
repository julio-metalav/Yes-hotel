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

/**
 * Carrega o painel operacional num contexto isolado e devolve
 * `resolveHitsReadWindow`. A lógica de fuso fica onde já estava — o teste só
 * a exercita com relógio injetado.
 */
function loadPainelWindow(): (now: Date) => { from: string; to: string } {
  const sandbox = loadPainelSandbox();
  const fn = (sandbox as { resolveHitsReadWindow?: unknown }).resolveHitsReadWindow;
  assert.equal(typeof fn, "function", "resolveHitsReadWindow deve existir");
  return fn as (now: Date) => { from: string; to: string };
}

/** Sandbox do painel com as funções top-level acessíveis por nome. */
function loadPainelSandbox(): Record<string, unknown> {
  const src = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");
  const el = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
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
  });
  const sandbox: Record<string, unknown> = {
    console,
    Intl,
    // Date do host: sem isto, `now instanceof Date` falha entre realms e a
    // função cai no relógio real, mascarando os casos de virada.
    Date,
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => el(),
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
    HTMLElement: class {},
    HTMLInputElement: class {},
    HTMLSelectElement: class {},
    Response,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
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
  {
    // Sem isto a reserva sumia da grade no instante do check-in no HITS.
    const api = loadPreview();
    assert.equal(
      api.toReservaOperacional({ ...ROW, ciclo_hits: "hospedada" }).entrouNoApto,
      true,
    );
    assert.equal(
      api.toReservaOperacional({ ...ROW, ciclo_hits: "confirmada" }).entrouNoApto,
      false,
    );
    // Linha sem o campo não pode virar hospedada por acidente.
    assert.equal(api.toReservaOperacional(ROW).entrouNoApto, false);
    // Acesso é credencial do Yes/TTLock: o HITS não concede.
    assert.equal(
      api.toReservaOperacional({ ...ROW, ciclo_hits: "hospedada" }).acessoLiberado,
      false,
    );
    ok("ciclo_hits=hospedada vira entrouNoApto, sem liberar acesso");
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

  console.log("\n== Janela de leitura no dia operacional ==");
  {
    // Campo Grande é UTC-4. A Edge calcula o default em UTC; depois das 20h
    // locais o UTC já virou e a janela começava em "amanhã", zerando o Hoje.
    const janela = loadPainelWindow();

    const casos: Array<[string, string, string]> = [
      ["A) 15/09 19:59 CG", "2026-09-15T23:59:00Z", "2026-09-15"],
      ["B) 15/09 20:01 CG (UTC ja 16/09)", "2026-09-16T00:01:00Z", "2026-09-15"],
      ["C) 16/09 06:59 CG (antes do corte 7h)", "2026-09-16T10:59:00Z", "2026-09-15"],
      ["D) 16/09 07:00 CG (apos o corte)", "2026-09-16T11:00:00Z", "2026-09-16"],
    ];
    for (const [nome, utc, esperado] of casos) {
      const w = janela(new Date(utc));
      assert.equal(w.from, esperado, `${nome}: date_from`);
    }
    ok("A/B/C/D da virada: janela segue o dia operacional, não o UTC");

    const w = janela(new Date("2026-09-16T00:01:00Z"));
    assert.equal(w.from, "2026-09-15");
    assert.equal(w.to, "2026-10-15");
    ok("date_to = date_from + 30 dias");
  }

  console.log("\n== Reservas canceladas no HITS: reconciliação pelo detalhe ==");
  {
    type Resultado = "cancelada" | "ja_cancelada" | "falha";
    const sb = loadPainelSandbox() as {
      selecionarCandidatasCancelamentoHits: (b: unknown[], f: unknown[]) => string[];
      selecionarCanceladasConfirmadasHits: (b: unknown[], rows: unknown[]) => unknown[];
      persistirCancelamentoHits: (sup: unknown, id: string, now: string) => Promise<Resultado>;
      aplicarResultadoCancelamentoHits: (r: { statusReserva: string }, res: Resultado) => boolean;
      filtrarReservasOperacionaisAtivas: (l: unknown[]) => unknown[];
    };
    const mk = (ext: string | null, origem: string, status = "ativa") => ({
      id: "uuid-" + (ext || "manual"),
      externalReservationId: ext,
      origemExterna: origem,
      statusReserva: status,
      hospedes: [{ nome: "H" }],
      historico: [{ tipo: "x" }],
    });
    const a104 = mk("17820", "hits");            // cancelada no HITS, sumiu do feed
    const b105 = mk("17821", "hits");            // ativa, só fora da janela do feed
    const cMan = mk(null, "manual");             // manual: nunca candidata
    const dJa  = mk("17822", "hits", "cancelada"); // já cancelada no banco
    const e107 = mk("17823", "hits");            // presente no feed
    const base = [a104, b105, cMan, dJa, e107];
    const feed = [{ externalReservationId: "17823" }];

    // Arrays nascem no realm do vm: espalhar antes de comparar (mesmo caso já
    // tratado acima para hospedes/cobranças).
    const ids = [...sb.selecionarCandidatasCancelamentoHits(base, feed)];
    assert.deepEqual(ids, ["17820", "17821"]);
    ok("candidatas = banco+hits, ativas, fora do feed; manual e já cancelada ficam de fora");

    // Detalhe confirma: 17820 cancelada; 17821 ativa. Seleção é PURA: nada muda ainda.
    const confirmadas = [
      ...sb.selecionarCanceladasConfirmadasHits(base, [
        { external_reservation_id: "17820", status_reserva: "cancelada" },
        { external_reservation_id: "17821", status_reserva: "ativa" },
      ]),
    ];
    assert.deepEqual(confirmadas, [a104]);
    assert.equal(a104.statusReserva, "ativa", "seleção não muta: banco ainda não confirmou");
    assert.equal(b105.statusReserva, "ativa", "ativa no detalhe continua ativa");
    assert.equal(e107.statusReserva, "ativa", "presente no feed continua ativa");
    ok("detalhe confirma cancelada → selecionada, mas ainda ativa em memória");

    // Não devolvida pelo detalhe (falha/timeout) → NÃO infere cancelamento.
    const f = mk("17824", "hits");
    assert.deepEqual([...sb.selecionarCanceladasConfirmadasHits([f], [])], []);
    assert.equal(f.statusReserva, "ativa");
    ok("sumiu do feed mas o detalhe não confirmou → não é marcada cancelada");

    // Persistência com Supabase falso: só o banco autoriza mudar a memória.
    const fakeSupabase = (plano: { updateError?: boolean; updateRows?: number; statusAtual?: string; selectError?: boolean }) => {
      const eventos: unknown[] = [];
      const chain = (kind: "update" | "select" | "insert", payload?: unknown) => {
        const q: Record<string, unknown> = {};
        const self = () => q;
        q.eq = self; q.maybeSingle = () => {
          if (plano.selectError) return Promise.resolve({ data: null, error: { message: "x" } });
          return Promise.resolve({ data: { status_reserva: plano.statusAtual ?? "ativa" }, error: null });
        };
        q.select = () => Promise.resolve(
          plano.updateError
            ? { data: null, error: { message: "boom" } }
            : { data: Array.from({ length: plano.updateRows ?? 1 }, () => ({ id: "x" })), error: null },
        );
        if (kind === "insert") { eventos.push(payload); return Promise.resolve({ error: null }); }
        return q;
      };
      return {
        eventos,
        from: () => ({
          update: () => chain("update"),
          select: () => chain("select"),
          insert: (p: unknown) => chain("insert", p),
        }),
      };
    };

    // 1. UPDATE falha → "falha": continua ativa, sem evento.
    const rFalha = mk("17830", "hits");
    const resFalha = await sb.persistirCancelamentoHits(fakeSupabase({ updateError: true }), rFalha.id, "2026-09-16T00:00:00Z");
    assert.equal(resFalha, "falha");
    assert.equal(sb.aplicarResultadoCancelamentoHits(rFalha, resFalha), false, "sem evento");
    assert.equal(rFalha.statusReserva, "ativa", "falha no banco → continua ativa na grade");
    ok("UPDATE falhou → reserva segue ativa em memória e sem evento");

    // 2. UPDATE ok (1 linha) → "cancelada": some da grade + evento.
    const rOk = mk("17831", "hits");
    const resOk = await sb.persistirCancelamentoHits(fakeSupabase({ updateRows: 1 }), rOk.id, "2026-09-16T00:00:00Z");
    assert.equal(resOk, "cancelada");
    assert.equal(sb.aplicarResultadoCancelamentoHits(rOk, resOk), true, "evento devido");
    assert.equal(rOk.statusReserva, "cancelada");
    assert.deepEqual([...(sb.filtrarReservasOperacionaisAtivas([rOk]) as unknown[])], []);
    ok("UPDATE confirmou → some da grade e gera evento");

    // 3. UPDATE 0 linhas + banco já cancelada → "ja_cancelada": some, SEM evento duplicado.
    const rJa = mk("17832", "hits");
    const resJa = await sb.persistirCancelamentoHits(fakeSupabase({ updateRows: 0, statusAtual: "cancelada" }), rJa.id, "2026-09-16T00:00:00Z");
    assert.equal(resJa, "ja_cancelada");
    assert.equal(sb.aplicarResultadoCancelamentoHits(rJa, resJa), false, "outro processo já gravou: sem evento");
    assert.equal(rJa.statusReserva, "cancelada");
    ok("segunda execução / outro processo: reconciliada sem evento duplicado");

    // 4. UPDATE 0 linhas e banco ainda ativa (estado inesperado) → "falha": não esconde.
    const rIncerto = mk("17833", "hits");
    const resIncerto = await sb.persistirCancelamentoHits(fakeSupabase({ updateRows: 0, statusAtual: "ativa" }), rIncerto.id, "2026-09-16T00:00:00Z");
    assert.equal(resIncerto, "falha");
    assert.equal(rIncerto.statusReserva, "ativa");
    ok("0 linhas sem confirmação de cancelada → não esconde da grade");

    // Para os passos seguintes, a 17820 passa a cancelada como se o banco tivesse confirmado.
    a104.statusReserva = "cancelada";

    // Histórico e hóspedes do objeto seguem intactos; nada é apagado.
    assert.equal((a104.hospedes as unknown[]).length, 1);
    assert.equal((a104.historico as unknown[]).length, 1);
    ok("cancelar preserva hóspedes e histórico da reserva");

    const ativas = [...(sb.filtrarReservasOperacionaisAtivas(base) as Array<{ id: string }>)];
    assert.deepEqual(ativas.map((r) => r.id), ["uuid-17821", "uuid-manual", "uuid-17823"]);
    ok("lista ativa exclui a cancelada agora e a já cancelada; mantém as demais (sem duplicar)");

    // Reexecução: já cancelada não é candidata nem é marcada de novo.
    assert.deepEqual([...sb.selecionarCandidatasCancelamentoHits(base, feed)], ["17821"]);
    assert.deepEqual(
      [...sb.selecionarCanceladasConfirmadasHits(base, [{ external_reservation_id: "17820", status_reserva: "cancelada" }])],
      [],
    );
    ok("idempotente: segunda reconciliação não re-marca nem duplica");

    // `const` top-level não é exposto pelo vm; o teto é o documentado no painel.
    const muitas = Array.from({ length: 30 }, (_, i) => mk(String(30000 + i), "hits"));
    assert.equal(sb.selecionarCandidatasCancelamentoHits(muitas, []).length, 20);
    ok("teto de 20 ids por ciclo protege o rate limit do gateway");
  }
  {
    // Guardas estáticas do trecho que escreve no banco.
    const src = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");
    const bloco = src.slice(
      src.indexOf("function selecionarCanceladasConfirmadasHits"),
      src.indexOf("async function loadReservasSomenteLeituraHits"),
    );
    assert.match(bloco, /hits-reservations-preview\?ids=/, "confirma pelo detalhe, via Edge existente");
    assert.match(bloco, /\.update\(\{ status_reserva: "cancelada", updated_at: nowIso \}\)/);
    assert.match(bloco, /\.eq\("status_reserva", "ativa"\)/, "só marca quem ainda estava ativa");
    // Ordem: persistir → aplicar na memória → evento. Nunca o inverso.
    const iPersist = bloco.indexOf("await persistirCancelamentoHits(supabase, r.id, nowIso)");
    const iAplica = bloco.indexOf("aplicarResultadoCancelamentoHits(r, resultado)");
    const iEvento = bloco.indexOf('tipo: "hits_reserva_cancelada"');
    assert.ok(iPersist > -1 && iAplica > iPersist && iEvento > iAplica, "banco → memória → evento");
    assert.match(bloco, /if \(!aplicarResultadoCancelamentoHits\(r, resultado\)\) continue;/, "sem confirmação, pula sem evento");
    assert.equal(/\.delete\(/.test(bloco), false, "nada é apagado");
    assert.match(bloco, /tipo: "hits_reserva_cancelada"/, "evento já conhecido pela UI");
    assert.equal(/operacional_hospedes|fnrh_hospedes/.test(bloco), false, "hóspedes e FNRH intocados");
    ok("escrita restrita a status_reserva + evento; sem delete, sem tocar hóspedes/FNRH");
  }

  console.log("\n== Repasse da janela à Edge ==");
  {
    const calls: string[] = [];
    const api = loadPreview(async (url: string) => {
      calls.push(url);
      return jsonResponse({ ok: true, rows: [ROW] });
    });

    await api.fetchReservasOperacionais({ dateFrom: "2026-09-15", dateTo: "2026-10-15" });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /date_from=2026-09-15/);
    assert.match(calls[0]!, /date_to=2026-10-15/);
    ok("URL da Edge carrega date_from e date_to");

    // Mesma janela, sem force: reusa o ciclo.
    await api.fetchReservasOperacionais({ dateFrom: "2026-09-15", dateTo: "2026-10-15" });
    assert.equal(calls.length, 1, "mesma janela nao refaz leitura");

    // Botão do painel (sem janela) herda a última usada pela grade.
    await api.loadCycle();
    assert.equal(calls.length, 1, "painel reusa a janela da grade");
    ok("painel e grade compartilham a mesma leitura");

    // Virada do dia operacional: janela nova invalida o ciclo anterior.
    await api.fetchReservasOperacionais({ dateFrom: "2026-09-16", dateTo: "2026-10-16" });
    assert.equal(calls.length, 2, "janela diferente exige leitura nova");
    assert.match(calls[1]!, /date_from=2026-09-16/);
    ok("mudança de janela invalida o ciclo reaproveitado");
  }
  {
    // Sem janela, a Edge aplica o default dela (fallback preservado).
    const calls: string[] = [];
    const api = loadPreview(async (url: string) => {
      calls.push(url);
      return jsonResponse({ ok: true, rows: [ROW] });
    });
    await api.fetchReservasOperacionais();
    assert.doesNotMatch(calls[0]!, /date_from/);
    ok("sem janela: URL limpa, default da Edge preservado");
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
