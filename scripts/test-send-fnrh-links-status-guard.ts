/**
 * Defeito: send-fnrh-links gravava operacional_hospedes.status_operacional =
 * "enviado" incondicionalmente sempre que a mensagem era entregue — mesmo se
 * o hóspede já tivesse avançado de estado (confirmado a FNRH, ou qualquer
 * outra transição) durante o mesmo envio, regredindo-o de volta.
 *
 * `marcarEnviadoSeStatusOperacionalNaoMudou`, de
 * supabase/functions/send-fnrh-links/index.ts, é um compare-and-set exato:
 * só escreve se status_operacional ainda for, no momento do UPDATE, o mesmo
 * valor lido pelo job no início do processamento. Qualquer mudança
 * concorrente — para "confirmado" ou para qualquer outro estado — faz o
 * UPDATE não bater com nenhuma linha (rowsAffected 0), e error nulo não
 * basta: só rowsAffected === 1 é sucesso real.
 *
 * A função é extraída pelos marcadores `fnrh-links-status-guard:begin/end`
 * (mesma convenção de scripts/test-fnrh-crm-guests-upsert.ts) e executada
 * contra um cliente Supabase falso em memória cujos filtros (.eq/.is) são
 * aplicados no momento da execução do UPDATE — como faz o Postgres real —
 * para provar que não há janela entre ler e escrever. Sem Deno, sem rede,
 * sem banco.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const ROOT = resolve(process.cwd());
const LINKS_PATH = resolve(ROOT, "supabase/functions/send-fnrh-links/index.ts");
const linksSrc = readFileSync(LINKS_PATH, "utf8");

// ---------------------------------------------------------------------------
// Cliente Supabase falso — from().update(patch).eq()/.is().select(), com os
// filtros aplicados só na hora de executar (então uma mudança de estado feita
// "por fora", entre a montagem da query e o await, é o que decide se a linha
// bate ou não — exatamente a corrida que o compare-and-set precisa vencer).
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter = ["eq" | "is", string, unknown];
type Call = { table: string; payload: Row; filters: Filter[] };

function makeFakeClient(opts: {
  tables?: Record<string, Row[]>;
  updateError?: { code: string; message: string } | null;
  onBeforeApply?: () => void;
} = {}) {
  const tables: Record<string, Row[]> = opts.tables ?? {};
  const calls: Call[] = [];

  function from(table: string) {
    const rows = (tables[table] ??= []);
    const filters: Filter[] = [];
    const applyFilters = (r: Row) =>
      filters.every(([kind, k, v]) => (kind === "eq" ? r[k] === v : (r[k] ?? null) === v));

    const builder: Record<string, unknown> = {};
    builder.update = (payload: Row) => {
      const call: Call = { table, payload, filters };
      calls.push(call);
      const upd: Record<string, unknown> = {
        eq(k: string, v: unknown) {
          filters.push(["eq", k, v]);
          return upd;
        },
        is(k: string, v: unknown) {
          filters.push(["is", k, v]);
          return upd;
        },
        select(_cols?: string) {
          return {
            then(onOk: (r: { data: Row[] | null; error: unknown }) => unknown, onErr?: (e: unknown) => unknown) {
              return Promise.resolve()
                .then(() => {
                  opts.onBeforeApply?.();
                  if (opts.updateError) return { data: null, error: opts.updateError };
                  const matched: Row[] = [];
                  for (const r of rows) {
                    if (applyFilters(r)) {
                      Object.assign(r, payload);
                      matched.push({ ...r });
                    }
                  }
                  return { data: matched, error: null };
                })
                .then(onOk, onErr);
            },
          };
        },
      };
      return upd;
    };
    return builder;
  }
  return { client: { from }, calls, tables };
}

// ---------------------------------------------------------------------------
// Extração e execução do bloco de guarda real.
// ---------------------------------------------------------------------------
type GuardModule = {
  marcarEnviadoSeStatusOperacionalNaoMudou: (
    client: unknown,
    hospedeId: string,
    statusLidoNoJob: string | null,
    patch: Row,
  ) => Promise<{ ok: boolean; rowsAffected: number; error?: string }>;
};

function loadGuardBlock(): GuardModule {
  const begin = linksSrc.indexOf("// --- fnrh-links-status-guard:begin ---");
  const end = linksSrc.indexOf("// --- fnrh-links-status-guard:end ---");
  assert.ok(begin > -1 && end > begin, "marcadores fnrh-links-status-guard:begin/end presentes");
  const block = linksSrc.slice(begin, end);
  const source = block + "\nmodule.exports = { marcarEnviadoSeStatusOperacionalNaoMudou };\n";
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.equal((out.diagnostics ?? []).length, 0, "bloco de guarda transpila sem erro de sintaxe");
  const sandbox: Record<string, unknown> = { module: { exports: {} }, exports: {}, Promise };
  vm.createContext(sandbox);
  vm.runInContext(out.outputText, sandbox);
  const raw = (sandbox.module as { exports: GuardModule }).exports;
  // Objetos nascem no realm do vm: normaliza para comparar com deepEqual.
  const plain = <T,>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    marcarEnviadoSeStatusOperacionalNaoMudou: async (c, id, s, p) =>
      plain(await raw.marcarEnviadoSeStatusOperacionalNaoMudou(c, id, s, p)),
  };
}

const GUEST_ID = "guest-1";

function patchEnviado(): Row {
  return { status_operacional: "enviado", ultimo_envio_canal: "email", updated_at: "2026-09-18T12:00:00.000Z" };
}

async function main() {
  const guard = loadGuardBlock();

  console.log("\n== Edge inteira: sintaxe ==");
  {
    const out = ts.transpileModule(linksSrc, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    const diags = (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.deepEqual(diags, [], "send-fnrh-links/index.ts sem erro de sintaxe");
    ok("supabase/functions/send-fnrh-links/index.ts transpila sem diagnóstico sintático");
  }

  console.log("\n== Caminho normal: status lido ainda bate no momento do UPDATE ==");
  {
    const fake = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "pendente" }] },
    });
    const r = await guard.marcarEnviadoSeStatusOperacionalNaoMudou(fake.client, GUEST_ID, "pendente", patchEnviado());
    assert.deepEqual(r, { ok: true, rowsAffected: 1 });
    assert.equal(fake.tables.operacional_hospedes[0]!.status_operacional, "enviado");
    ok("estado lido ('pendente') ainda bate: escreve 'enviado' normalmente");

    const fake2 = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
    });
    const r2 = await guard.marcarEnviadoSeStatusOperacionalNaoMudou(fake2.client, GUEST_ID, "enviado", patchEnviado());
    assert.deepEqual(r2, { ok: true, rowsAffected: 1 });
    ok("reenvio (lido e atual 'enviado'): compare-and-set bate, escreve normalmente");
  }

  console.log("\n== Compare-and-set concorrente: estado mudou para 'confirmado' antes do UPDATE ==");
  {
    // Simula a corrida real: entre o job ler o estado e o UPDATE executar,
    // fnrh-submit confirma o hóspede. O filtro roda dentro do próprio UPDATE
    // (sem SELECT prévio no momento da escrita), então não há janela.
    const fake = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
      onBeforeApply: () => {
        fake.tables.operacional_hospedes[0]!.status_operacional = "confirmado";
      },
    });
    const r = await guard.marcarEnviadoSeStatusOperacionalNaoMudou(fake.client, GUEST_ID, "enviado", patchEnviado());
    assert.deepEqual(r, { ok: false, rowsAffected: 0 }, "0 linhas afetadas: CAS perdeu a corrida, não é erro de banco");
    assert.equal(
      fake.tables.operacional_hospedes[0]!.status_operacional,
      "confirmado",
      "confirmação concorrente não foi sobrescrita",
    );
    ok("confirmação ocorrida durante o envio vence: compare-and-set afeta zero linhas");
  }

  console.log("\n== Outro estado diferente de 'confirmado' também não é regredido ==");
  {
    // Não é só "confirmado" que trava a escrita: qualquer mudança concorrente
    // (aqui, um operador reclassificando o hóspede) também derruba o CAS,
    // porque o UPDATE exige o valor exato lido, não apenas "não confirmado".
    const fake = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
      onBeforeApply: () => {
        fake.tables.operacional_hospedes[0]!.status_operacional = "aguardando_contato";
      },
    });
    const r = await guard.marcarEnviadoSeStatusOperacionalNaoMudou(fake.client, GUEST_ID, "enviado", patchEnviado());
    assert.deepEqual(r, { ok: false, rowsAffected: 0 });
    assert.equal(
      fake.tables.operacional_hospedes[0]!.status_operacional,
      "aguardando_contato",
      "estado concorrente (não 'confirmado') também não é sobrescrito para 'enviado'",
    );
    ok("mudança concorrente para um estado qualquer, não só 'confirmado', também barra a regressão");
  }

  console.log("\n== Estado mais avançado, já confirmado desde antes do job, não regride ==");
  {
    const fake = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "confirmado", updated_at: "old" }] },
    });
    // O job leu "confirmado" (não deveria nem tentar reenviar, mas o guard
    // por si só também barra: o patch pede "enviado", o CAS exige o valor
    // lido — "confirmado" — e o patch some com esse próprio valor).
    const r = await guard.marcarEnviadoSeStatusOperacionalNaoMudou(fake.client, GUEST_ID, "confirmado", patchEnviado());
    assert.deepEqual(r, { ok: true, rowsAffected: 1 });
    ok("nota: CAS confere só o valor lido — a responsabilidade de nunca ler/reenviar um 'confirmado' é do chamador (pendentes filtra por fnrh_hospedes.status)");
  }

  console.log("\n== Zero linhas por id inexistente não vira sucesso falso ==");
  {
    const fake = makeFakeClient({ tables: { operacional_hospedes: [] } });
    const r = await guard.marcarEnviadoSeStatusOperacionalNaoMudou(fake.client, "id-fantasma", "pendente", patchEnviado());
    assert.deepEqual(r, { ok: false, rowsAffected: 0 });
    ok("hóspede inexistente: rowsAffected 0, ok:false — não mascarado como sucesso");
  }

  console.log("\n== Falha técnica não é silenciada ==");
  {
    const fake = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
      updateError: { code: "42501", message: "permission denied" },
    });
    const r = await guard.marcarEnviadoSeStatusOperacionalNaoMudou(fake.client, GUEST_ID, "enviado", patchEnviado());
    assert.equal(r.ok, false);
    assert.equal(r.rowsAffected, 0);
    assert.match(String(r.error), /permission denied/);
    ok("erro de banco é propagado, distinto de uma corrida (tem .error, CAS-miss não tem)");
  }

  console.log("\n== Estático: o UPDATE real usa o guard renomeado, com comparação exata ==");
  {
    assert.equal(linksSrc.includes("marcarEnviadoSeAindaNaoConfirmado"), false, "nome antigo não existe mais");
    assert.equal(linksSrc.includes('.update({\n          status_operacional: "enviado"'), false, "update antigo, incondicional, foi removido");
    assert.match(linksSrc, /marcarEnviadoSeStatusOperacionalNaoMudou\(\s*admin,\s*p\.hospede_id,\s*statusOperacionalLido,\s*patch,?\s*\)/);
    assert.equal(linksSrc.includes('.neq("status_operacional", "confirmado")'), false, "comparação por exclusão (.neq confirmado) foi removida");
    assert.match(linksSrc, /base\.eq\("status_operacional", statusLidoNoJob\)/);
    assert.match(linksSrc, /\.is\("status_operacional", null\)/);
    ok("Deno.serve usa o compare-and-set exato, não mais a exclusão de 'confirmado'");

    assert.match(linksSrc, /status_operacional\?: string \| null;/, "select de hospedes inclui status_operacional");
    assert.match(linksSrc, /const statusOperacionalLido = hospede\?\.status_operacional \?\? null;/);
    ok("estado lido no início do job é capturado por hóspede antes do envio");
  }

  console.log(`\nOK test-send-fnrh-links-status-guard (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
