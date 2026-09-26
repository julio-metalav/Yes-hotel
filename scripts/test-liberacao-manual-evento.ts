/**
 * O evento liberacao_manual_com_pendencias só existe depois do envio concluído.
 * Confirmação do operador, abandono e falha de provisionamento não gravam.
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
const policySrc = readFileSync(resolve(ROOT, "ui/yes-credential-release-policy.js"), "utf8");

const RESERVA_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const GUEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function stubEl(): Record<string, unknown> {
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

type Harness = {
  reserva: { historicoOperacional?: Array<{ tipo?: string }> };
  abrir(modo: string): void;
  submeter(): Promise<void>;
  confirmar(decisao: unknown): boolean;
  avaliar(overrides?: Record<string, unknown>): { pendenciasAtuais?: string[]; exigeConfirmacaoManual?: boolean } | null;
};

function load(opts: {
  pagamento?: string;
  liberarOk?: boolean;
  enviarOk?: boolean;
  skipped?: boolean;
}): Harness {
  class HTMLElement {}
  const byId: Record<string, ReturnType<typeof stubEl>> = {};
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
  const sandbox: Record<string, unknown> = {
    console,
    Intl,
    Date,
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => stubEl(),
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
    confirm: () => true,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(policySrc, sandbox);
  vm.runInContext(mvpSrc, sandbox);

  const mapReserva = sandbox.mapDbReservaToInternal as (
    r: Record<string, unknown>,
    h: Record<string, unknown>[],
    e: unknown[],
    f: unknown[],
    s: unknown[],
  ) => Harness["reserva"];
  const reserva = mapReserva(
    {
      id: RESERVA_ID,
      apartamento: "07",
      hospede_principal: "Hospede Teste",
      external_reservation_id: "9001",
      check_in_previsto: "2026-09-26",
      check_out_previsto: "2026-09-27",
      status_reserva: "ativa",
      pagamento_status: opts.pagamento ?? "pendente",
      fnrh_status_agregado: "fnrh_completa",
      acesso_liberado: false,
      senha_enviada_em: null,
    },
    [
      {
        id: GUEST_ID,
        reserva_id: RESERVA_ID,
        nome: "Hospede Teste",
        principal: true,
        guest_role: "primary_adult",
        is_minor: false,
        email: "hospede@example.com",
        whatsapp: "5500000000000",
        status_operacional: "confirmado",
      },
    ],
    [],
    [],
    [],
  );
  (sandbox as { __reservaTeste?: Harness["reserva"] }).__reservaTeste = reserva;
  vm.runInContext("reservas = [globalThis.__reservaTeste];", sandbox as vm.Context);

  sandbox.persistirContatoPrincipalSemRefresh = async () => true;
  sandbox.backendLiberarAcesso = async () =>
    opts.liberarOk === false
      ? { ok: false, error: "Falha de provisionamento" }
      : { ok: true };
  sandbox.backendEnviarSenha = async () =>
    opts.enviarOk === false
      ? { ok: false, error: "Falha ao enviar credenciais" }
      : { ok: true, skipped: !!opts.skipped, data: { mensagem: "Operação concluída." } };
  sandbox.refreshFromSource = async () => {};
  sandbox.refresh = () => {};

  return {
    reserva,
    abrir(modo: string) {
      (sandbox.openTopContatoPanel as (id: string, modo: string) => void)(RESERVA_ID, modo);
      byId["detail-top-contato-email"].value = "hospede@example.com";
      byId["detail-top-contato-whatsapp"].value = "5500000000000";
    },
    submeter: sandbox.submitDetailTopContatoPanel as () => Promise<void>,
    confirmar: sandbox.confirmarLiberacaoManualComPendencias as (r: unknown, d: unknown) => boolean,
    avaliar: sandbox.avaliarPoliticaCredenciaisReserva as Harness["avaliar"],
  };
}

function eventos(h: Harness): string[] {
  return (h.reserva.historicoOperacional || [])
    .filter((ev) => ev && ev.tipo === "liberacao_manual_com_pendencias")
    .map((ev) => String(ev.tipo));
}

async function main() {
  const clickStart = mvpSrc.indexOf(
    'const enviarSenhaBtn = detailBodyElement.querySelector("#detail-enviar-senha-btn")',
  );
  const click = mvpSrc.slice(clickStart, mvpSrc.indexOf("const pagarmeOpenBtn", clickStart));
  assert.match(click, /confirmarLiberacaoManualComPendencias/);
  assert.match(click, /openTopContatoPanel/);
  assert.doesNotMatch(click, /registrarLiberacaoManualComPendencias/);
  ok("o clique só confirma a intenção e abre o painel");

  {
    const h = load({});
    const decisao = h.avaliar({ origem: "manual", acaoSolicitada: "gerar_enviar" });
    assert.equal(decisao?.exigeConfirmacaoManual, true);
    assert.equal(h.confirmar(decisao), true);
    assert.deepEqual(eventos(h), []);
    ok("confirmação sem execução não grava evento");
  }

  {
    const h = load({ liberarOk: false });
    h.abrir("senha");
    await h.submeter();
    assert.deepEqual(eventos(h), []);
    ok("falha de provisionamento não grava liberação");
  }

  {
    const h = load({ enviarOk: false });
    h.abrir("senha");
    await h.submeter();
    assert.deepEqual(eventos(h), []);
    ok("falha de envio não grava liberação");
  }

  {
    const h = load({});
    h.abrir("senha");
    await h.submeter();
    assert.deepEqual(eventos(h), ["liberacao_manual_com_pendencias"]);
    h.abrir("senha");
    await h.submeter();
    assert.deepEqual(eventos(h), ["liberacao_manual_com_pendencias"]);
    ok("sucesso grava uma vez e o replay não duplica");
  }

  {
    const h = load({ pagamento: "pago" });
    h.abrir("senha");
    await h.submeter();
    assert.deepEqual(eventos(h), []);
    ok("liberação sem pendência não grava o evento");
  }

  {
    const h = load({});
    h.abrir("senha_reenviar");
    await h.submeter();
    assert.deepEqual(eventos(h), []);
    ok("reenvio não cria o evento de liberação com pendências");
  }

  console.log(`\nOK test-liberacao-manual-evento (${cases} casos)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
