/**
 * Feedback visual do painel de contato ao gerar/enviar senha
 * (submitDetailTopContatoPanel em ui/checkin-operacional-mvp.js).
 *
 * Caso real (apto 07, 26/09/2026): o operador clicou em "Confirmar envio", a
 * senha FOI criada, o acesso FOI liberado e as comunicações guest_access_ready
 * saíram por WhatsApp e e-mail. O defeito foi só de retorno visual: durante a
 * operação o botão apenas ficava cinza, e a confirmação de sucesso era destruída
 * pelo renderDetail() disparado dentro de refreshFromSource() antes de o
 * operador conseguir lê-la — dava a impressão de que nada havia acontecido.
 *
 * Painel carregado em node:vm, como em test-central-acoes-operacional-ui.ts.
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

type Row = Record<string, unknown>;
type Stub = Record<string, unknown> & {
  classList: { add(c: string): void; remove(...cs: string[]): void; has(c: string): boolean };
  dataset: Record<string, string>;
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
  } as Stub;
}

const RESERVA_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function reservaRow(): Row {
  return {
    id: RESERVA_ID,
    apartamento: "07",
    hospede_principal: "Julio Cesar Lopes de Oliveira",
    external_reservation_id: "18077",
    check_in_previsto: "2026-09-26",
    check_out_previsto: "2026-09-27",
    status_reserva: "ativa",
    pagamento_status: "pendente",
    fnrh_status_agregado: "fnrh_completa",
    acesso_liberado: false,
    senha_enviada_em: null,
  };
}

function hospedeRow(): Row {
  return {
    id: GUEST_ID,
    reserva_id: RESERVA_ID,
    nome: "Julio Cesar Lopes de Oliveira",
    principal: true,
    guest_role: "primary_adult",
    is_minor: false,
    email: "hospede@example.com",
    whatsapp: "5567999990000",
    status_operacional: "confirmado",
  };
}

/** Passo registrado na linha do tempo, com o estado da UI naquele instante. */
type Passo = {
  nome: string;
  em: number;
  botao: string;
  botaoDesabilitado: boolean;
  mensagem: string;
  painelVisivel: boolean;
};

interface Harness {
  byId: Record<string, Stub>;
  passos: Passo[];
  abrirPainel(modo: string): void;
  submeter(): Promise<void>;
  painelVisivel(): boolean;
  mensagem(): string;
  botao(): Stub;
}

function loadPainel(opts: { enviarOk?: boolean } = {}): Harness {
  const escEl = (): Record<string, unknown> => {
    const o = stubEl();
    let text = "";
    Object.defineProperty(o, "textContent", {
      get: () => text,
      set: (v: unknown) => {
        text = String(v);
      },
    });
    Object.defineProperty(o, "innerHTML", { get: () => text, set() {} });
    return o;
  };
  class HTMLElement {}
  const detailBody = Object.assign(new HTMLElement(), stubEl());
  const byId: Record<string, Stub> = {};
  for (const id of [
    "detail-top-contato-panel",
    "detail-top-contato-email",
    "detail-top-contato-whatsapp",
    "detail-top-contato-title",
    "detail-top-contato-msg",
    "detail-top-contato-confirm",
  ]) {
    byId[id] = stubEl();
  }
  byId["detail-top-contato-panel"].classList.add("hidden");
  byId["detail-top-contato-confirm"].textContent = "Confirmar envio";

  const sandbox: Record<string, unknown> = {
    console,
    Intl,
    Date,
    document: {
      querySelector: (s: string) => (s === "#reservation-detail-body" ? detailBody : null),
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

  const mapReserva = sandbox.mapDbReservaToInternal as (
    r: Row,
    h: Row[],
    e: Row[],
    f: Row[],
    s: Row[],
  ) => Row;
  const reserva = mapReserva(reservaRow(), [hospedeRow()], [], [], []);
  (sandbox as { __reservaTeste?: Row }).__reservaTeste = reserva;
  vm.runInContext("reservas = [globalThis.__reservaTeste];", sandbox as vm.Context);

  const passos: Passo[] = [];
  const inicio = Date.now();
  function marcar(nome: string) {
    passos.push({
      nome,
      em: Date.now() - inicio,
      botao: String(byId["detail-top-contato-confirm"].textContent),
      botaoDesabilitado: !!byId["detail-top-contato-confirm"].disabled,
      mensagem: String(byId["detail-top-contato-msg"].textContent),
      painelVisivel: !byId["detail-top-contato-panel"].classList.has("hidden"),
    });
  }

  sandbox.persistirContatoPrincipalSemRefresh = async () => {
    marcar("persistirContato");
    return true;
  };
  sandbox.backendLiberarAcesso = async () => {
    marcar("backendLiberarAcesso");
    return { ok: true };
  };
  sandbox.backendEnviarSenha = async () => {
    marcar("backendEnviarSenha");
    return opts.enviarOk === false
      ? { ok: false, error: "Acesso TTLock não confirmado nos locks obrigatórios." }
      : { ok: true, data: { mensagem: "Senha gerada e enviada ao hóspede." }, skipped: false };
  };
  sandbox.refreshFromSource = async () => {
    marcar("refreshFromSource");
  };
  sandbox.executarEnvioLinksFnrhReserva = async () => {
    marcar("enviarLinksFnrh");
  };
  sandbox.refresh = () => {};

  const abrir = sandbox.openTopContatoPanel as (rid: string, modo: string) => void;
  const submit = sandbox.submitDetailTopContatoPanel as () => Promise<void>;
  assert.equal(typeof abrir, "function");
  assert.equal(typeof submit, "function");

  return {
    byId,
    passos,
    abrirPainel(modo: string) {
      abrir(RESERVA_ID, modo);
      byId["detail-top-contato-email"].value = "hospede@example.com";
      byId["detail-top-contato-whatsapp"].value = "5567999990000";
    },
    async submeter() {
      await submit();
      marcar("fim");
    },
    painelVisivel() {
      return !byId["detail-top-contato-panel"].classList.has("hidden");
    },
    mensagem() {
      return String(byId["detail-top-contato-msg"].textContent);
    },
    botao() {
      return byId["detail-top-contato-confirm"];
    },
  };
}

function passo(h: Harness, nome: string): Passo {
  const p = h.passos.find((x) => x.nome === nome);
  assert.ok(p, `passo ${nome} ocorreu`);
  return p as Passo;
}

async function main() {
  console.log("\n== 1. Progresso visível enquanto a operação corre ==");
  {
    const h = loadPainel();
    h.abrirPainel("senha");
    assert.equal(h.botao().textContent, "Confirmar envio");
    await h.submeter();
    for (const etapa of ["persistirContato", "backendLiberarAcesso", "backendEnviarSenha"]) {
      const p = passo(h, etapa);
      assert.equal(p.botao, "Gerando e enviando…", `rótulo de progresso durante ${etapa}`);
      assert.equal(p.botaoDesabilitado, true, `botão travado durante ${etapa}`);
    }
    ok("durante geração/envio o botão diz 'Gerando e enviando…' e fica travado");
  }

  console.log("\n== 2. Sucesso visível antes do re-render que destrói o painel ==");
  {
    const h = loadPainel();
    h.abrirPainel("senha");
    await h.submeter();
    const refresh = passo(h, "refreshFromSource");
    assert.equal(
      refresh.mensagem,
      "Senha gerada e enviada ao hóspede.",
      "confirmação já na tela quando o refresh começa",
    );
    assert.equal(refresh.painelVisivel, true, "painel ainda aberto exibindo o sucesso");
    const envio = passo(h, "backendEnviarSenha");
    assert.ok(
      refresh.em - envio.em >= 1000,
      `confirmação fica legível antes do re-render (observado ${refresh.em - envio.em}ms)`,
    );
    ok("sucesso é exibido e permanece legível até o refresh");
  }

  console.log("\n== 3. Depois do sucesso a tela é atualizada e o painel fecha ==");
  {
    const h = loadPainel();
    h.abrirPainel("senha");
    await h.submeter();
    const nomes = h.passos.map((p) => p.nome);
    assert.deepEqual(nomes, [
      "persistirContato",
      "backendLiberarAcesso",
      "backendEnviarSenha",
      "refreshFromSource",
      "fim",
    ]);
    assert.equal(h.painelVisivel(), false, "painel fecha ao final");
    assert.equal(h.botao().textContent, "Confirmar envio", "rótulo restaurado");
    assert.equal(h.botao().disabled, false, "botão reabilitado");
    ok("reserva relida do banco, painel fechado e botão restaurado");
  }

  console.log("\n== 4. Falha continua com erro real, sem refresh e sem fechar ==");
  {
    const h = loadPainel({ enviarOk: false });
    h.abrirPainel("senha");
    await h.submeter();
    assert.match(h.mensagem(), /TTLock|não confirmado/i, "erro real na tela");
    assert.equal(
      h.passos.some((p) => p.nome === "refreshFromSource"),
      false,
      "nada a reler quando o envio falhou",
    );
    assert.equal(h.painelVisivel(), true, "painel segue aberto para nova tentativa");
    assert.equal(h.botao().textContent, "Confirmar envio");
    assert.equal(h.botao().disabled, false);
    ok("falha não é confundida com sucesso e o operador pode repetir");
  }

  console.log("\n== 5. Envio de link FNRH mantém o rótulo próprio ==");
  {
    const h = loadPainel();
    h.abrirPainel("fnrh");
    await h.submeter();
    assert.equal(passo(h, "enviarLinksFnrh").botao, "Enviando…");
    assert.equal(h.painelVisivel(), false);
    assert.equal(h.botao().textContent, "Confirmar envio");
    ok("fluxo FNRH inalterado, com progresso próprio");
  }

  console.log(`\nOK test-senha-feedback-pos-envio (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
