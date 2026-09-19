/**
 * Achado de auditoria: send-fnrh-links validava statusOperacionalLido so
 * contra "confirmado" (via .neq no compare-and-set antigo), nao contra
 * uma whitelist explicita dos estados que realmente permitem envio ou
 * reenvio. Um hospede fora do fluxo normal (ja confirmado, ou em
 * qualquer outro estado nao elegivel) ainda disparava tentativa de
 * e-mail/WhatsApp antes do compare-and-set final barrar so a escrita.
 *
 * Este teste e funcional: importa e executa o handler real do
 * Deno.serve de send-fnrh-links/index.ts (com Deno, fetch e o cliente
 * Supabase trocados por fakes) e invoca a requisicao HTTP de verdade,
 * reproduzindo a corrida ponta a ponta:
 *   1. fnrh_hospedes entra na lista como pendente;
 *   2. a consulta a operacional_hospedes devolve o hospede ja confirmado
 *      (ou em outro estado fora da whitelist);
 *   3. nenhum e-mail/WhatsApp e enviado (fetch nunca chamado, nenhum
 *      registro em operacional_comunicacao_envios);
 *   4. nenhum update para enviado ocorre (status_operacional intacto).
 *
 * Para rodar sob Node/tsx, o import de jsr: e substituido por uma
 * fabrica fake injetada via globalThis; o resto do arquivo real roda
 * sem alteracao nenhuma. O arquivo gerado fica ao lado do index.ts real
 * (imports relativos para _shared/ continuam funcionando) e e apagado
 * ao final do teste.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const ROOT = resolve(process.cwd());
const REAL_PATH = resolve(ROOT, "supabase/functions/send-fnrh-links/index.ts");
const HARNESS_PATH = resolve(ROOT, "supabase/functions/send-fnrh-links/index.test-harness.generated.ts");
const realSrc = readFileSync(REAL_PATH, "utf8");

type Row = Record<string, unknown>;
type FilterKind = "eq" | "in" | "is";
type Filter = [FilterKind, string, unknown];
type Call = { table: string; op: "select" | "insert" | "update"; payload?: Row; filters: Filter[] };

// --- Estatico: a whitelist existe (checagem por substring simples) ---
{
  const WHITELIST_LINE = 'const ESTADOS_QUE_PERMITEM_ENVIO_FNRH = new Set(["pronto_para_envio", "enviado"]);';
  assert.ok(realSrc.includes(WHITELIST_LINE), "whitelist explicita presente no arquivo real");
  assert.ok(realSrc.includes("skippedEstadoOperacionalNaoElegivel++;"), "contador de skip presente");
  ok("whitelist explicita e contador de skip presentes no arquivo real");
}

// --- Harness: substitui o import jsr por uma fabrica fake ---
const JSR_IMPORT = `import { createClient } from "jsr:@supabase/supabase-js@2";`;
const FAKE_IMPORT = "const { createClient } = globalThis.__sendFnrhLinksFakeSupabase__;";
if (!realSrc.includes(JSR_IMPORT)) {
  throw new Error("import jsr nao encontrado no arquivo real; harness precisa de ajuste");
}
const harnessSrc = realSrc.split(JSR_IMPORT).join(FAKE_IMPORT);
writeFileSync(HARNESS_PATH, harnessSrc, "utf8");

// --- Cliente Supabase falso em memoria ---
function makeFakeAdmin(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  function from(table: string) {
    const rows = (tables[table] ??= []);
    function applySelectFilters(filters: Filter[]) {
      return (r: Row) => filters.every(([kind, k, v]) => {
        if (kind === "in") return Array.isArray(v) && v.includes(r[k]);
        if (kind === "is") return (r[k] ?? null) === v;
        return r[k] === v;
      });
    }
    function makeSelectQuery() {
      const filters: Filter[] = [];
      const q = {
        eq(k: string, v: unknown) { filters.push(["eq", k, v]); return q; },
        in(k: string, v: unknown[]) { filters.push(["in", k, v]); return q; },
        maybeSingle() {
          const found = rows.filter(applySelectFilters(filters));
          return Promise.resolve({ data: found[0] ?? null, error: null });
        },
        then(onOk: (r: { data: Row[] | Row | null; error: null }) => unknown, onErr?: (e: unknown) => unknown) {
          const found = rows.filter(applySelectFilters(filters)).map((r) => ({ ...r }));
          return Promise.resolve({ data: found, error: null }).then(onOk, onErr);
        },
      };
      return q;
    }
    function makeUpdateQuery(payload: Row) {
      calls.push({ table, op: "update", payload, filters: [] });
      const call = calls[calls.length - 1];
      const q = {
        eq(k: string, v: unknown) { call.filters.push(["eq", k, v]); return q; },
        is(k: string, v: unknown) { call.filters.push(["is", k, v]); return q; },
        select() {
          return {
            then(onOk: (r: { data: Row[]; error: null }) => unknown, onErr?: (e: unknown) => unknown) {
              const applyF = applySelectFilters(call.filters);
              const matched = [];
              for (const r of rows) {
                if (applyF(r)) {
                  Object.assign(r, payload);
                  matched.push({ ...r });
                }
              }
              return Promise.resolve({ data: matched, error: null }).then(onOk, onErr);
            },
          };
        },
      };
      return q;
    }
    return {
      select() { calls.push({ table, op: "select", filters: [] }); return makeSelectQuery(); },
      insert(payload: Row) {
        calls.push({ table, op: "insert", payload, filters: [] });
        rows.push({ id: "gen-" + (rows.length + 1), ...payload });
        return Promise.resolve({ data: null, error: null });
      },
      update(payload: Row) { return makeUpdateQuery(payload); },
    };
  }
  return { client: { from }, calls, tables };
}

const RESERVA_ID = "reserva-1";
const GUEST_ID = "guest-1";
const FNRH_ID = "fnrh-1";

function baselineTables(hospedeOverrides: Row) {
  return {
    operacional_reservas: [{ id: RESERVA_ID, apartamento: "101", hospede_principal: "Hospede Teste", check_in_previsto: "2026-09-20" }],
    fnrh_hospedes: [{ id: FNRH_ID, reserva_id: RESERVA_ID, hospede_id: GUEST_ID, link_token: "tok-1", hospede_nome: "Hospede Teste", status: "pendente" }],
    operacional_hospedes: [{
      id: GUEST_ID,
      nome: "Hospede Teste",
      email: "hospede@example.com",
      whatsapp: "",
      tentativas_envio: 0,
      guest_role: "primary_adult",
      ...hospedeOverrides,
    }],
    operacional_comunicacao_envios: [],
    operacional_reserva_eventos: [],
  };
}

const fakeAdmin = makeFakeAdmin(baselineTables({}));
function resetScenario(hospedeOverrides: Row) {
  const fresh = baselineTables(hospedeOverrides);
  for (const key of Object.keys(fakeAdmin.tables)) delete fakeAdmin.tables[key];
  Object.assign(fakeAdmin.tables, fresh);
  fakeAdmin.calls.length = 0;
  fetchCalls.length = 0;
}

let capturedHandler: ((req: Request) => Promise<Response>) | null = null;
const fetchCalls: { url: string; init: unknown }[] = [];
(globalThis as unknown as { __sendFnrhLinksFakeSupabase__: unknown }).__sendFnrhLinksFakeSupabase__ = { createClient: () => fakeAdmin.client };
(globalThis as unknown as { Deno: unknown }).Deno = {
  env: {
    get(key: string) {
      const env = {
        SUPABASE_URL: "https://fake.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "fake-service-role",
        RESEND_API_KEY: "fake-resend-key",
      };
      return (env as Record<string, string>)[key];
    },
  },
  serve(handler: (req: Request) => Promise<Response>) {
    capturedHandler = handler;
  },
};
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: unknown) => {
  fetchCalls.push({ url: String(url), init });
  return new Response(JSON.stringify({ id: "resend-mock-id" }), { status: 200 });
};

async function main() {
  try {
    await import(pathToFileURL(HARNESS_PATH).href);
    assert.equal(typeof capturedHandler, "function", "Deno.serve capturou o handler real de send-fnrh-links");
    ok("harness carregado: handler real capturado via Deno.serve fake");

    async function postSend() {
      const req = new Request("http://localhost/send-fnrh-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reserva_id: RESERVA_ID }),
      });
      const res = await capturedHandler!(req);
      const json = await res.json();
      return { res, json };
    }

    console.log("");
    console.log("== 1. Hospede ja confirmado: nenhum envio, nenhum update ==");
    {
      resetScenario({ status_operacional: "confirmado", whatsapp: "5567999990000" });
      const { json } = await postSend();
      assert.equal(fetchCalls.length, 0, "nenhum fetch Resend foi disparado");
      assert.equal(
        fakeAdmin.calls.filter((c) => c.table === "operacional_comunicacao_envios" && c.op === "insert").length,
        0,
        "nenhum registro de envio foi criado",
      );
      assert.equal(
        fakeAdmin.calls.filter((c) => c.table === "operacional_hospedes" && c.op === "update").length,
        0,
        "nenhum UPDATE em operacional_hospedes foi tentado",
      );
      assert.equal(fakeAdmin.tables.operacional_hospedes[0].status_operacional, "confirmado", "status_operacional permanece confirmado");
      assert.equal(json.enviados, 0);
      assert.equal(json.skipped_estado_operacional, 1);
      assert.equal(json.ok, true, "skip por estado nao e tratado como falha do job");
      ok("fnrh_hospedes pendente mais operacional_hospedes ja confirmado: zero e-mail/WhatsApp, zero update");
    }

    console.log("");
    console.log("== 2. Outro estado nao permitido (aguardando_contato): mesma protecao ==");
    {
      resetScenario({ status_operacional: "aguardando_contato", whatsapp: "5567999990000" });
      const { json } = await postSend();
      assert.equal(fetchCalls.length, 0, "nenhum fetch Resend foi disparado");
      assert.equal(
        fakeAdmin.calls.filter((c) => c.table === "operacional_hospedes" && c.op === "update").length,
        0,
        "nenhum UPDATE em operacional_hospedes foi tentado",
      );
      assert.equal(fakeAdmin.tables.operacional_hospedes[0].status_operacional, "aguardando_contato");
      assert.equal(json.skipped_estado_operacional, 1);
      assert.equal(json.enviados, 0);
      ok("estado fora da whitelist alem de confirmado tambem e bloqueado antes do envio");
    }

    console.log("");
    console.log("== 3. Contraprova: estado elegivel pronto_para_envio continua enviando ==");
    {
      resetScenario({ status_operacional: "pronto_para_envio", whatsapp: "" });
      const { json } = await postSend();
      assert.equal(fetchCalls.length, 1, "e-mail e tentado quando o estado permite");
      assert.equal(fakeAdmin.tables.operacional_hospedes[0].status_operacional, "enviado", "status_operacional avanca para enviado");
      assert.equal(json.enviados, 1);
      assert.equal(json.skipped_estado_operacional, 0);
      ok("estado elegivel nao e bloqueado pela whitelist");
    }

    console.log("");
    console.log("OK test-send-fnrh-links-status-whitelist (" + cases + " casos)");
  } finally {
    try {
      unlinkSync(HARNESS_PATH);
    } catch {
      // arquivo gerado ja pode ter sido removido; nao e critico
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
