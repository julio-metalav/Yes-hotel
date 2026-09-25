/**
 * Regressão: filtro por data específica no Check-in Operacional.
 *
 * Bug em PROD: o usuário escolhia "Período", digitava a data e clicava em
 * "Atualizar". A tela continuava mostrando hoje. Causa: `periodoCustomFrom/To`
 * só eram lidos dos campos no botão "Aplicar"; "Atualizar" reconsultava com o
 * estado anterior, que ao selecionar "Período" já havia sido gravado como hoje.
 *
 * Este teste executa o JS REAL do painel em node:vm, com listeners de verdade,
 * e observa a janela de datas que chega ao banco.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

const ROOT = process.cwd();
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

function ok(label: string) {
  console.log("  OK  " + label);
}

class FakeClassList {
  set = new Set<string>();
  add(...c: string[]) { c.forEach((x) => this.set.add(x)); }
  remove(...c: string[]) { c.forEach((x) => this.set.delete(x)); }
  toggle(c: string, force?: boolean) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
  }
  contains(c: string) { return this.set.has(c); }
}

/** Diferente do harness de paridade: aqui os listeners ficam guardados e podem ser disparados. */
class FakeEl {
  sel: string;
  attrs: Record<string, string> = {};
  classList = new FakeClassList();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  innerHTML = ""; textContent = ""; value = "";
  hidden = false; disabled = false; checked = false; removed = false;
  options: unknown[] = [];
  listeners = new Map<string, Array<(ev?: unknown) => unknown>>();
  constructor(sel: string, value = "") { this.sel = sel; this.value = value; }
  addEventListener(type: string, fn: (ev?: unknown) => unknown) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type)!.push(fn);
  }
  removeEventListener() {}
  dispatch(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this, preventDefault() {} });
  }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  remove() { this.removed = true; }
  appendChild() {} focus() {} blur() {} click() { this.dispatch("click"); }
  scrollIntoView() {} insertAdjacentHTML() {} contains() { return false; }
  toggleAttribute() {}
}

type Row = Record<string, unknown>;
type Consulta = { table: string; gte: Record<string, unknown>; lte: Record<string, unknown> };

function abrirPainel() {
  const els = new Map<string, FakeEl>();
  const el = (sel: string) => {
    if (!els.has(sel)) els.set(sel, new FakeEl(sel));
    return els.get(sel)!;
  };
  // A tela nasce com o select em "hoje", como no HTML.
  el("#op-period").value = "hoje";

  const consultas: Consulta[] = [];
  const makeQuery = (table: string) => {
    const c: Consulta = { table, gte: {}, lte: {} };
    const q: Record<string, unknown> = {};
    const self = () => q;
    q.select = self; q.order = self; q.limit = self; q.maybeSingle = self; q.single = self;
    q.eq = self; q.neq = self; q.in = self; q.is = self; q.like = self; q.gt = self;
    q.gte = (col: string, v: unknown) => { c.gte[col] = v; return q; };
    q.lte = (col: string, v: unknown) => { c.lte[col] = v; return q; };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      if (table === "operacional_reservas") consultas.push(c);
      return Promise.resolve({ data: [] as Row[], error: null }).then(res, rej);
    };
    return q;
  };

  const client = {
    supabaseUrl: "https://teste.supabase.co",
    from: (table: string) => makeQuery(table),
    rpc: () => Promise.resolve({ data: [], error: null }),
    functions: { invoke: () => Promise.resolve({ data: null, error: { message: "x" } }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  };
  const auth = {
    isConfigured: () => true,
    getConfigError: () => "",
    getCurrentUser: async () => ({ name: "recepcao", role: "recepcao" }),
    isHitsConsultaRole: () => false,
    getRoleLabel: (r: string) => r,
    getSupabaseClient: () => client,
    getEdgeFunctionFetchHeaders: async () => ({}),
    getSession: async () => null,
    getUser: async () => null,
    logout: async () => {},
    invokeLifecycleAction: async () => ({}),
    canAccessUserManagement: () => false,
  };
  const fetchStub = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rows: [] }) });

  const document = {
    querySelector: (s: string) => el(s),
    querySelectorAll: () => [],
    getElementById: (id: string) => el("#" + id),
    createElement: (t: string) => new FakeEl(t),
    addEventListener() {},
    body: el("body"),
  };
  const window: Record<string, unknown> = {
    location: { search: "", hash: "", href: "" },
    addEventListener() {},
    innerWidth: 1366,
    YesHotelAuthApp: auth,
    YES_HOTEL_SUPABASE_CONFIG: { url: "https://teste.supabase.co", anonKey: "anon" },
  };
  const ctx: Record<string, unknown> = createContext({
    window, document, console, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchStub, Intl, Date, Promise, JSON, Math, Number, String, Array, Object, Set, Map, RegExp, Error,
    HTMLElement: FakeEl, HTMLInputElement: FakeEl, HTMLSelectElement: FakeEl, HTMLButtonElement: FakeEl,
    HTMLTextAreaElement: FakeEl, HTMLFormElement: FakeEl, Element: FakeEl, Node: FakeEl,
    navigator: {}, alert: () => {}, confirm: () => false, prompt: () => null,
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  window.fetch = fetchStub;
  window.document = document;
  Object.assign(ctx, { YesHotelAuthApp: auth, YES_HOTEL_SUPABASE_CONFIG: window.YES_HOTEL_SUPABASE_CONFIG });

  for (const rel of SCRIPTS) {
    runInContext(readFileSync(resolve(ROOT, rel), "utf8"), ctx, { filename: rel });
    for (const k of Object.keys(window)) if (/^Yes|^YES/.test(k)) ctx[k] = window[k];
  }

  return {
    el,
    consultas,
    run: (code: string) => runInContext(code, ctx),
    /**
     * `loadReservasFromBackend` dispara duas consultas: a do periodo escolhido
     * e a de estadias em curso. So a primeira carrega a janela de check-in, e
     * e essa que interessa aqui.
     */
    janelaDoPeriodo() {
      const doPeriodo = consultas.filter((c) => c.gte["check_in_previsto"] != null);
      const c = doPeriodo[doPeriodo.length - 1];
      if (!c) return null;
      return {
        from: c.gte["check_in_previsto"] ?? null,
        to: c.lte["check_in_previsto"] ?? null,
      };
    },
    totalDoPeriodo() {
      return consultas.filter((c) => c.gte["check_in_previsto"] != null).length;
    },
  };
}

const esperar = async (voltas = 20) => {
  for (let i = 0; i < voltas; i++) await new Promise((r) => setTimeout(r, 5));
};

/** Reproduz o que o usuário faz: escolhe "Período" e digita a data nos campos. */
async function escolherPeriodoEDigitar(p: ReturnType<typeof abrirPainel>, from: string, to: string) {
  p.el("#op-period").value = "periodo";
  p.el("#op-period").dispatch("change");
  await esperar(6);
  p.el("#op-period-from").value = from;
  p.el("#op-period-to").value = to;
}

const DATA = "2026-09-26";

async function main() {
  console.log("\n== 1 a 6. Data específica + Atualizar ==");
  {
    const p = abrirPainel();
    await esperar();
    await escolherPeriodoEDigitar(p, DATA, DATA);

    // Antes da correção, este clique reconsultava com o estado antigo (hoje).
    p.el("#op-refresh-btn").dispatch("click");
    await esperar();

    const janela = p.janelaDoPeriodo();
    assert.ok(janela, "o clique em Atualizar precisa consultar o banco");
    assert.equal(janela!.from, DATA, "consulta recebeu a data escolhida como início");
    assert.equal(janela!.to, DATA, "consulta recebeu a data escolhida como fim");
    ok("1 a 3. Atualizar consulta exatamente a data digitada");

    const range = JSON.parse(
      p.run("JSON.stringify(resolvePeriodRangeYmd(periodoAtivo, { fromYmd: periodoCustomFrom, toYmd: periodoCustomTo }))") as string,
    );
    assert.deepEqual(range, { from: DATA, to: DATA }, "filtro de renderização usa a mesma data");
    ok("4. renderização e consulta usam a mesma data");

    assert.equal(p.run("periodoAtivo"), "periodo");
    assert.equal(p.el("#op-period").value, "periodo");
    assert.notEqual(p.run("periodoCustomFrom"), p.run("todayStr()"));
    ok("5. período permanece em 'periodo' e a data não regride para hoje");

    const antes = p.totalDoPeriodo();
    p.el("#op-refresh-btn").dispatch("click");
    await esperar();
    assert.ok(p.totalDoPeriodo() > antes, "segundo clique também consulta");
    assert.deepEqual(p.janelaDoPeriodo(), { from: DATA, to: DATA }, "segundo clique mantém a data");
    assert.equal(p.el("#op-period-from").value, DATA, "campo inicial preservado");
    assert.equal(p.el("#op-period-to").value, DATA, "campo final preservado");
    ok("6. segundo Atualizar repete o mesmo resultado");
  }

  console.log("\n== Data específica em um campo só ==");
  {
    const p = abrirPainel();
    await esperar();
    await escolherPeriodoEDigitar(p, DATA, "");
    p.el("#op-refresh-btn").dispatch("click");
    await esperar();

    assert.deepEqual(
      p.janelaDoPeriodo(),
      { from: DATA, to: DATA },
      "um campo só vira aquele dia, nao um intervalo esticado ate hoje",
    );
    assert.equal(p.el("#op-period-to").value, DATA, "o campo vazio e espelhado na tela");
    ok("preencher so uma data consulta exatamente aquele dia");
  }

  console.log("\n== O botão Aplicar continua funcionando ==");
  {
    const p = abrirPainel();
    await esperar();
    await escolherPeriodoEDigitar(p, "2026-09-26", "2026-09-28");
    p.el("#op-period-apply").dispatch("click");
    await esperar();
    assert.deepEqual(p.janelaDoPeriodo(), { from: "2026-09-26", to: "2026-09-28" });
    ok("Aplicar segue consultando o intervalo digitado");
  }

  console.log("\n== Presets continuam intactos ==");
  {
    const p = abrirPainel();
    await esperar();
    p.el("#op-period").value = "ontem";
    p.el("#op-period").dispatch("change");
    await esperar();
    const hoje = String(p.run("todayStr()"));
    const ontem = String(p.run("addDaysYmd(todayStr(), -1)"));
    assert.deepEqual(p.janelaDoPeriodo(), { from: ontem, to: ontem }, "preset 'ontem' inalterado");
    assert.notEqual(ontem, hoje);
    ok("trocar para um preset nao passa pela sincronizacao de data custom");
  }

  console.log("\n== 7. Não há refresh automático que apague a data ==");
  {
    const src = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");
    assert.doesNotMatch(src, /setInterval\(/, "sem polling que recarregue a listagem");
    assert.doesNotMatch(src, /postgres_changes/, "sem realtime que recarregue a listagem");
    ok("7. sem refresh automatico; a data selecionada nao e apagada sozinha");
  }

  console.log("\n== Contrato do código ==");
  {
    const src = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");
    assert.match(src, /function sincronizarPeriodoCustomDoDom\(\)/);
    assert.equal(
      (src.match(/sincronizarPeriodoCustomDoDom\(\);/g) || []).length,
      3,
      "chamada nos tres pontos: troca de periodo, Aplicar e Atualizar",
    );
    assert.match(
      src,
      /opRefreshBtn\?\.addEventListener\("click", \(\) => \{[\s\S]{0,200}sincronizarPeriodoCustomDoDom\(\);[\s\S]{0,80}refreshListagem\(\)/,
      "Atualizar sincroniza antes de consultar",
    );
    assert.doesNotMatch(src, /#op-period-from"\)\?\.addEventListener\("change"/);
    assert.doesNotMatch(src, /#op-period-to"\)\?\.addEventListener\("change"/);
    assert.match(src, /\.gte\("check_in_previsto", range\.from\)/);
    assert.match(src, /\.lte\("check_in_previsto", range\.to\)/);
    const html = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.html"), "utf8");
    assert.match(html, /checkin-operacional-mvp\.js\?v=63/, "cache-bust da correcao");
    ok("origem unica da data, sem listener nos campos, semantica do filtro intacta");
  }

  console.log("\nFiltro por data específica: todos os testes passaram.\n");
}

main().catch((erro) => {
  console.error(erro);
  process.exitCode = 1;
});
