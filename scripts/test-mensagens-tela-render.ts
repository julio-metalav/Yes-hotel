/**
 * Regressão: a tela Mensagens automáticas abria em branco em PROD.
 *
 * Causa: o casco da página nasce com `hidden` no HTML, como em todas as telas
 * operacionais, e quem o revela é o guard de acesso. Esta tela foi entregue
 * sem guard nenhum -- o `hidden` nunca saía. Nenhum erro no console, nenhuma
 * requisição falhando: a página inteira simplesmente ficava invisível.
 *
 * Nenhum teste pegava isso porque todos liam o JS como texto. Este executa o
 * arquivo de verdade em node:vm, com DOM falso, e observa o que fica visível.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

import { CATALOGO_MENSAGENS } from "../src/lib/domain/yes-hotel/mensagens-catalogo.ts";

const ROOT = process.cwd();
const SCRIPTS = [
  "ui/yes-nav-policy.js",
  "ui/yes-mensagens-policy.js",
  "ui/mensagens-automaticas.js",
];

function ok(label: string) {
  console.log("  OK  " + label);
}

class FakeClassList {
  set = new Set<string>();
  add(...c: string[]) { c.forEach((x) => x && this.set.add(x)); }
  remove(...c: string[]) { c.forEach((x) => this.set.delete(x)); }
  toggle(c: string, force?: boolean) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
  }
  contains(c: string) { return this.set.has(c); }
}

class FakeEl {
  tag: string;
  attrs: Record<string, string> = {};
  classList = new FakeClassList();
  children: FakeEl[] = [];
  listeners = new Map<string, Array<(ev?: unknown) => unknown>>();
  textContent = "";
  innerHTML = "";
  value = "";
  type = "";
  title = "";
  disabled = false;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;

  constructor(tag: string) { this.tag = tag; }

  get className() { return [...this.classList.set].join(" "); }
  set className(v: string) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  appendChild(c: FakeEl) { this.children.push(c); return c; }
  append(...cs: FakeEl[]) { cs.forEach((c) => this.children.push(c)); }
  replaceChildren(...cs: FakeEl[]) { this.children = [...cs]; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t: string, fn: (ev?: unknown) => unknown) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t)!.push(fn);
  }
  dispatch(t: string) {
    for (const fn of this.listeners.get(t) ?? []) fn({ target: this, preventDefault() {} });
  }
  focus() {}
  querySelector(sel: string): FakeEl | null { return buscar(this, sel); }
  querySelectorAll(sel: string): FakeEl[] { return buscarTodos(this, sel); }
}

/** Suporta os três seletores que a tela usa: tag, #id e [attr="valor"]. */
function casa(el: FakeEl, sel: string): boolean {
  if (sel.startsWith("#")) return el.attrs.id === sel.slice(1);
  if (sel.startsWith("[")) {
    const m = sel.match(/^\[([a-z-]+)="?([^"\]]*)"?\]$/);
    if (!m) return false;
    return el.getAttribute(m[1]!) === m[2];
  }
  return el.tag === sel;
}

function buscar(raiz: FakeEl, sel: string): FakeEl | null {
  for (const f of raiz.children) {
    if (casa(f, sel)) return f;
    const achado = buscar(f, sel);
    if (achado) return achado;
  }
  return null;
}

function buscarTodos(raiz: FakeEl, sel: string): FakeEl[] {
  const achados: FakeEl[] = [];
  for (const f of raiz.children) {
    if (casa(f, sel)) achados.push(f);
    achados.push(...buscarTodos(f, sel));
  }
  return achados;
}

type Cenario = {
  role?: string;
  rpc?: () => Promise<{ data?: unknown; error?: unknown }>;
  config?: () => Promise<{ data?: unknown; error?: unknown }>;
  semAuth?: boolean;
};

/** Monta a página, executa o JS real e devolve o que ficou na tela. */
function abrirTela(cenario: Cenario = {}) {
  const raiz = new FakeEl("body");
  const criar = (tag: string, id?: string, classe?: string) => {
    const el = new FakeEl(tag);
    if (id) el.setAttribute("id", id);
    if (classe) el.className = classe;
    raiz.appendChild(el);
    return el;
  };

  // Mesmo estado inicial do HTML: os dois cascos nascem escondidos.
  const accessEl = criar("div", "access-state", "op-access hidden");
  const panelEl = criar("div", "content-panel", "op-app hidden");
  const listaEl = criar("div", "msg-lista", "msg-lista");
  const erroEl = criar("p", "msg-erro-geral", "msg-status err");
  const sidebarNav = criar("nav");
  sidebarNav.setAttribute("aria-label", "Navegação principal");

  const rpcCalls: string[] = [];
  const client = {
    rpc: (nome: string) => {
      rpcCalls.push(nome);
      return cenario.rpc
        ? cenario.rpc()
        : Promise.resolve({
            data: CATALOGO_MENSAGENS.map((m) => ({
              chave: m.chave,
              corpo: m.corpo_padrao,
              atualizado_por_nome: null,
              updated_at: "2026-09-25T12:00:00Z",
            })),
            error: null,
          });
    },
    from: () => {
      const q: Record<string, unknown> = {};
      const self = () => q;
      q.select = self;
      q.eq = self;
      q.maybeSingle = () =>
        cenario.config
          ? cenario.config()
          : Promise.resolve({
              data: { checkout_horario: "11h", telefone_recepcao: "(67) 99668-8886" },
              error: null,
            });
      return q;
    },
  };

  const auth = cenario.semAuth
    ? null
    : {
        isConfigured: () => true,
        getConfigError: () => "",
        getCurrentUser: async () => ({ name: "Admin", role: cenario.role ?? "admin" }),
        getSupabaseClient: () => client,
      };

  const document = {
    querySelector: (sel: string) => {
      if (sel.includes("yes-sidebar")) return sidebarNav;
      return buscar(raiz, sel);
    },
    querySelectorAll: (sel: string) => buscarTodos(raiz, sel),
    getElementById: (id: string) => buscar(raiz, "#" + id),
    createElement: (t: string) => new FakeEl(t),
    addEventListener() {},
    body: raiz,
  };
  const window: Record<string, unknown> = {
    YesHotelAuthApp: auth,
    addEventListener() {},
    location: { hash: "", search: "", href: "" },
  };

  const ctx: Record<string, unknown> = createContext({
    window, document, console,
    setTimeout, clearTimeout, Promise, JSON, Math, Number, String, Array, Object,
    Set, Map, RegExp, Error, Date, Boolean,
  });
  ctx.globalThis = ctx;
  ctx.self = ctx;
  window.document = document;

  const erros: unknown[] = [];
  for (const rel of SCRIPTS) {
    try {
      runInContext(readFileSync(resolve(ROOT, rel), "utf8"), ctx, { filename: rel });
    } catch (e) {
      erros.push(e);
    }
    for (const k of Object.keys(window)) if (/^Yes/.test(k)) ctx[k] = window[k];
  }

  return { raiz, accessEl, panelEl, listaEl, erroEl, sidebarNav, erros, rpcCalls };
}

/** Deixa a fila de microtasks drenar: o boot da tela é assíncrono. */
const assentar = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  const html = readFileSync(resolve(ROOT, "ui/mensagens-automaticas.html"), "utf8");

  console.log("\n== O HTML traz o casco que a tela espera ==");
  {
    for (const id of ["access-state", "content-panel", "msg-lista", "msg-erro-geral"]) {
      assert.ok(html.includes('id="' + id + '"'), "falta o elemento " + id);
    }
    // O casco nasce escondido de propósito; é o guard que o revela.
    assert.match(html, /id="content-panel" class="op-app hidden"/);
    // E os scripts na ordem: espelho antes da tela.
    const iPolicy = html.indexOf("yes-mensagens-policy.js");
    const iNav = html.indexOf("yes-nav-policy.js");
    const iTela = html.indexOf("mensagens-automaticas.js");
    assert.ok(iNav > 0 && iNav < iTela, "yes-nav-policy precisa carregar antes da tela");
    assert.ok(iPolicy > 0 && iPolicy < iTela, "espelho precisa carregar antes da tela");
    ok("container principal, casco escondido e ordem de scripts");
  }

  console.log("\n== O JS inicializa sem excecao e revela a pagina ==");
  {
    const tela = abrirTela();
    assert.deepEqual(tela.erros, [], "o JS lancou excecao ao carregar");
    await assentar();
    assert.equal(
      tela.panelEl.classList.contains("hidden"),
      false,
      "a pagina continuou escondida: e exatamente o bug em branco",
    );
    assert.equal(tela.accessEl.classList.contains("hidden"), true);
    assert.ok(tela.sidebarNav.innerHTML.length > 0, "menu lateral nao foi renderizado");
    ok("sem excecao, casco revelado e menu lateral montado");
  }

  console.log("\n== A estrutura aparece antes dos dados ==");
  {
    // RPC que nunca resolve: prova que a lista nao depende do banco para
    // existir. Em branco por lentidao de rede e o mesmo sintoma do bug.
    let liberar: (v: { data: unknown; error: unknown }) => void = () => {};
    const pendente = new Promise<{ data: unknown; error: unknown }>((r) => {
      liberar = r;
    });
    const tela = abrirTela({ rpc: () => pendente });
    await assentar();

    assert.equal(tela.panelEl.classList.contains("hidden"), false);
    assert.equal(
      tela.listaEl.children.length,
      CATALOGO_MENSAGENS.length,
      "as mensagens deveriam estar na tela antes da resposta do banco",
    );
    liberar({ data: [], error: null });
    await assentar();
    ok("as oito mensagens aparecem sem esperar o banco");
  }

  console.log("\n== Banco indisponivel nao deixa a tela em branco ==");
  {
    const tela = abrirTela({
      rpc: async () => ({ data: null, error: { message: "relation does not exist" } }),
    });
    await assentar();
    assert.equal(tela.panelEl.classList.contains("hidden"), false);
    assert.equal(tela.listaEl.children.length, CATALOGO_MENSAGENS.length);
    assert.ok(tela.erroEl.textContent.length > 0, "o erro precisa aparecer para o usuario");
    ok("erro do banco vira mensagem visivel, nao tela branca");
  }

  console.log("\n== O guard e guard de verdade ==");
  {
    // Perfil sem a rota: a pagina NAO pode simplesmente aparecer.
    const semRota = abrirTela({ role: "cafe" });
    await assentar();
    assert.equal(semRota.panelEl.classList.contains("hidden"), true);
    assert.equal(semRota.accessEl.classList.contains("hidden"), false);
    assert.ok(semRota.accessEl.children.length > 0, "faltou o aviso de acesso negado");

    // Sem sessao: mesma coisa, com outro aviso.
    const semLogin = abrirTela({ semAuth: true });
    await assentar();
    assert.equal(semLogin.panelEl.classList.contains("hidden"), true);
    assert.equal(semLogin.accessEl.classList.contains("hidden"), false);

    // Admin e recepcao passam; cafe e hits_consulta nao.
    const navPolicy = (() => {
      const w: Record<string, unknown> = {};
      const ctx = createContext({ window: w, console });
      (ctx as Record<string, unknown>).globalThis = ctx;
      runInContext(readFileSync(resolve(ROOT, "ui/yes-nav-policy.js"), "utf8"), ctx);
      return w.YesHotelNavPolicy as { isRouteAuthorized: (r: string, k: string) => boolean };
    })();
    assert.equal(navPolicy.isRouteAuthorized("admin", "mensagens"), true);
    assert.equal(navPolicy.isRouteAuthorized("recepcao", "mensagens"), true);
    assert.equal(navPolicy.isRouteAuthorized("cafe", "mensagens"), false);
    assert.equal(navPolicy.isRouteAuthorized("hits_consulta", "mensagens"), false);
    ok("sem perfil ou sem sessao a tela nao abre, e a matriz decide quem entra");
  }

  console.log("\nTela de mensagens automaticas: renderizacao verificada.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
