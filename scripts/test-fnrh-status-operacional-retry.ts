/**
 * Defeito: fnrh-submit podia responder sucesso com a FNRH confirmada e
 * operacional_hospedes.status_operacional preso em "enviado" (reserva 17829),
 * e o retry seguinte, ao ver a ficha já confirmada, nem tentava corrigir o
 * espelho operacional.
 *
 * `repararStatusOperacionalConfirmado`, de supabase/functions/fnrh-submit/index.ts,
 * é extraída pelos marcadores `fnrh-status-repair:begin/end` (mesma convenção
 * de scripts/test-fnrh-crm-guests-upsert.ts) e executada contra um cliente
 * Supabase falso em memória. Sem Deno, sem rede, sem banco.
 *
 * O resto do fluxo (onde a função é chamada, e que a falha inicial não trava
 * nem duplica CRM/auditoria/sync HITS) é conferido estaticamente, como já faz
 * a Parte A de test-fnrh-crm-guests-upsert.ts.
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
const SUBMIT_PATH = resolve(ROOT, "supabase/functions/fnrh-submit/index.ts");
const submitSrc = readFileSync(SUBMIT_PATH, "utf8");

// ---------------------------------------------------------------------------
// Cliente Supabase falso — só o que o bloco usa:
// from().select().eq().maybeSingle() e from().update().eq().select().
// O update só "acerta" linhas cujo id está em `existingIds` — assim dá para
// simular um UPDATE que roda sem erro mas não encontra o hóspede esperado
// (id inexistente, RLS silenciosa etc.), devolvendo 0 linhas.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Call = { table: string; op: "select" | "update"; payload?: Row; filters: Array<[string, unknown]> };

function makeFakeClient(opts: {
  tables?: Record<string, Row[]>;
  selectError?: { code: string; message: string } | null;
  updateError?: { code: string; message: string } | null;
  /** ids que o UPDATE efetivamente encontra; default = todos os ids da tabela. */
  updateMatchesIds?: string[];
} = {}) {
  const tables: Record<string, Row[]> = opts.tables ?? {};
  const calls: Call[] = [];

  function from(table: string) {
    const rows = (tables[table] ??= []);
    const filters: Array<[string, unknown]> = [];
    const applyFilters = (r: Row) => filters.every(([k, v]) => r[k] === v);

    const builder: Record<string, unknown> = {};
    builder.select = () => {
      const call: Call = { table, op: "select", filters };
      calls.push(call);
      const sel: Record<string, unknown> = {
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return sel;
        },
        async maybeSingle() {
          if (opts.selectError) return { data: null, error: opts.selectError };
          const found = rows.filter(applyFilters);
          return { data: found[0] ?? null, error: null };
        },
      };
      return sel;
    };
    builder.update = (payload: Row) => {
      const call: Call = { table, op: "update", payload, filters };
      calls.push(call);
      const upd: Record<string, unknown> = {
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return upd;
        },
        select(_cols?: string) {
          return {
            then(onOk: (r: { data: Row[] | null; error: unknown }) => unknown, onErr?: (e: unknown) => unknown) {
              return Promise.resolve()
                .then(() => {
                  if (opts.updateError) return { data: null, error: opts.updateError };
                  const permitido = opts.updateMatchesIds ?? rows.map((r) => String(r.id));
                  const matched: Row[] = [];
                  for (const r of rows) {
                    if (applyFilters(r) && permitido.includes(String(r.id))) {
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
// Extração e execução do bloco de reparo real.
// ---------------------------------------------------------------------------
type RepairModule = {
  aplicarUpdateEspelhoOperacional: (
    client: unknown,
    guestId: string,
    patch: Row,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  repararStatusOperacionalConfirmado: (
    client: unknown,
    guestId: string,
    now: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
};

function loadRepairBlock(): RepairModule {
  const begin = submitSrc.indexOf("// --- fnrh-status-repair:begin ---");
  const end = submitSrc.indexOf("// --- fnrh-status-repair:end ---");
  assert.ok(begin > -1 && end > begin, "marcadores fnrh-status-repair:begin/end presentes");
  const block = submitSrc.slice(begin, end);
  const source = block + "\nmodule.exports = { aplicarUpdateEspelhoOperacional, repararStatusOperacionalConfirmado };\n";
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.equal((out.diagnostics ?? []).length, 0, "bloco de reparo transpila sem erro de sintaxe");
  const sandbox: Record<string, unknown> = { module: { exports: {} }, exports: {}, Promise, String };
  vm.createContext(sandbox);
  vm.runInContext(out.outputText, sandbox);
  const raw = (sandbox.module as { exports: RepairModule }).exports;
  // Objetos nascem no realm do vm: normaliza para comparar com deepEqual.
  const plain = <T,>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    aplicarUpdateEspelhoOperacional: async (c, g, p) => plain(await raw.aplicarUpdateEspelhoOperacional(c, g, p)),
    repararStatusOperacionalConfirmado: async (c, g, n) => plain(await raw.repararStatusOperacionalConfirmado(c, g, n)),
  };
}

const GUEST_ID = "guest-1";
const NOW = "2026-09-18T12:00:00.000Z";

async function main() {
  const repair = loadRepairBlock();

  console.log("\n== Edge inteira: sintaxe ==");
  {
    const out = ts.transpileModule(submitSrc, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    const diags = (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.deepEqual(diags, [], "fnrh-submit/index.ts sem erro de sintaxe");
    ok("supabase/functions/fnrh-submit/index.ts transpila sem diagnóstico sintático");
  }

  console.log("\n== 0. aplicarUpdateEspelhoOperacional — helper único usado por v2, legado e reparo ==");
  {
    // erro no update do espelho retorna falha.
    const fakeErr = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
      updateError: { code: "42501", message: "permission denied" },
    });
    const rErr = await repair.aplicarUpdateEspelhoOperacional(fakeErr.client, GUEST_ID, { status_operacional: "confirmado" });
    assert.equal(rErr.ok, false);
    assert.match(String((rErr as { error: string }).error), /permission denied/);
    ok("erro no update do espelho retorna falha (mensagem do banco propagada)");

    // update que afeta zero linhas retorna falha.
    const fakeZero = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
      updateMatchesIds: [],
    });
    const rZero = await repair.aplicarUpdateEspelhoOperacional(fakeZero.client, GUEST_ID, { status_operacional: "confirmado" });
    assert.equal(rZero.ok, false, "0 linhas afetadas é falha, mesmo sem error");
    assert.equal(fakeZero.tables.operacional_hospedes[0]!.status_operacional, "enviado", "nada foi de fato gravado");
    ok("update que afeta zero linhas retorna falha, não sucesso");

    // update de exatamente uma linha permite o sucesso.
    const fakeOne = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
    });
    const rOne = await repair.aplicarUpdateEspelhoOperacional(fakeOne.client, GUEST_ID, {
      status_operacional: "confirmado",
      updated_at: NOW,
    });
    assert.deepEqual(rOne, { ok: true });
    assert.equal(fakeOne.tables.operacional_hospedes[0]!.status_operacional, "confirmado");
    assert.equal(fakeOne.tables.operacional_hospedes[0]!.updated_at, NOW);
    ok("update de exatamente uma linha (o hóspede esperado) permite o sucesso");
  }

  console.log("\n== 1. Falha da escrita operacional: repara escrevendo status_operacional=confirmado ==");
  {
    const fake = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
    });
    const r = await repair.repararStatusOperacionalConfirmado(fake.client, GUEST_ID, NOW);
    assert.deepEqual(r, { ok: true });
    const row = fake.tables.operacional_hospedes[0]!;
    assert.equal(row.status_operacional, "confirmado");
    assert.equal(row.updated_at, NOW);
    assert.equal(fake.calls.filter((c) => c.op === "update").length, 1, "uma única escrita");
    ok("estado 'enviado' preso é corrigido para 'confirmado'");
  }

  console.log("\n== 2. Nova tentativa depois da falha: idempotente, sem nova escrita ==");
  {
    const fake = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
    });
    const r1 = await repair.repararStatusOperacionalConfirmado(fake.client, GUEST_ID, NOW);
    assert.deepEqual(r1, { ok: true });
    const r2 = await repair.repararStatusOperacionalConfirmado(fake.client, GUEST_ID, "2026-09-18T12:05:00.000Z");
    assert.deepEqual(r2, { ok: true });
    assert.equal(fake.calls.filter((c) => c.op === "update").length, 1, "segunda chamada não escreve de novo");
    assert.equal(fake.tables.operacional_hospedes[0]!.updated_at, NOW, "updated_at da 1ª correção não é sobrescrito");
    ok("retry após correção bem-sucedida não repete a escrita (sem efeito colateral duplicado)");
  }

  console.log("\n== 3. Confirmação repetida: já confirmado nunca escreve ==");
  {
    const fake = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "confirmado", updated_at: "old" }] },
    });
    const r = await repair.repararStatusOperacionalConfirmado(fake.client, GUEST_ID, NOW);
    assert.deepEqual(r, { ok: true });
    assert.equal(fake.tables.operacional_hospedes[0]!.updated_at, "old", "nenhuma escrita quando já confirmado");
    assert.equal(fake.calls.filter((c) => c.op === "update").length, 0);
    ok("hóspede já confirmado: nenhuma escrita, sem regressão de updated_at");
  }

  console.log("\n== Falhas técnicas não travestem sucesso ==");
  {
    const fakeSel = makeFakeClient({ selectError: { code: "PGRST000", message: "boom" } });
    const rs = await repair.repararStatusOperacionalConfirmado(fakeSel.client, GUEST_ID, NOW);
    assert.equal(rs.ok, false);
    ok("falha ao verificar cadastro operacional não vira ok:true");

    const fakeUpd = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
      updateError: { code: "42501", message: "permission denied" },
    });
    const ru = await repair.repararStatusOperacionalConfirmado(fakeUpd.client, GUEST_ID, NOW);
    assert.equal(ru.ok, false);
    ok("falha ao escrever status_operacional não vira ok:true");
  }

  console.log("\n== Update do espelho com zero linhas não produz sucesso falso ==");
  {
    // O UPDATE roda sem erro (error: null), mas não encontra o hóspede
    // esperado (id inexistente, RLS silenciosa etc.) — 0 linhas voltam do
    // .select("id"). error nulo sozinho não pode virar ok:true.
    const fakeZero = makeFakeClient({
      tables: { operacional_hospedes: [{ id: GUEST_ID, status_operacional: "enviado" }] },
      updateMatchesIds: [],
    });
    const rz = await repair.repararStatusOperacionalConfirmado(fakeZero.client, GUEST_ID, NOW);
    assert.equal(rz.ok, false, "0 linhas afetadas: não é sucesso, mesmo sem error");
    assert.equal(fakeZero.tables.operacional_hospedes[0]!.status_operacional, "enviado", "nada foi de fato gravado");
    ok("UPDATE sem erro mas 0 linhas afetadas é tratado como falha, não sucesso");
  }

  console.log("\n== Estático: confirmV2Guest usa o helper compartilhado, retry corrige sem duplicar ==");
  {
    const i0 = submitSrc.indexOf("async function confirmV2Guest(");
    const i1 = submitSrc.indexOf("Deno.serve(");
    const confirmBlock = submitSrc.slice(i0, i1);

    assert.match(
      confirmBlock,
      /const mirrorConfirm = await aplicarUpdateEspelhoOperacional\(admin, input\.guestId, hospedeUpdate\);/,
    );
    assert.match(confirmBlock, /const hospedeMirrorFalhou = !mirrorConfirm\.ok;/);
    ok("confirmV2Guest delega a escrita/validação do espelho ao helper único (mesmo usado pelo reparo)");

    const iMirror = confirmBlock.indexOf("aplicarUpdateEspelhoOperacional(admin, input.guestId");
    const iCrm = confirmBlock.indexOf("await upsertCrmGuestFromFnrh(admin,");
    const iAudit = confirmBlock.indexOf("await writeFnrhConfirmedAudit(");
    const iSync = confirmBlock.indexOf("await syncFnrhToHits(admin, input.fnrhId");
    // A resposta final (com hospedeMirrorError) só decide depois do sync HITS.
    const iReturnMirrorErr = confirmBlock.indexOf("if (hospedeMirrorFalhou) {", iSync);
    assert.ok(
      iMirror > -1 && iCrm > iMirror && iAudit > iCrm && iSync > iAudit && iReturnMirrorErr > iSync,
      "ordem: escrita/validação do espelho → CRM → auditoria → sync HITS → só então decide a resposta",
    );
    ok("falha na escrita operacional não impede CRM, auditoria nem sync HITS de rodarem uma única vez");

    assert.match(confirmBlock, /hospedeMirrorError:\s*"Falha ao gravar operacional_hospedes\.status_operacional\."/);
    ok("falha é sinalizada no retorno sem derrubar a confirmação (crm ainda presente)");

    assert.equal((confirmBlock.match(/syncFnrhToHits\(/g) || []).length, 1, "um único sync por chamada de confirmV2Guest");
    ok("PUT HITS não se repete por causa da falha operacional");
  }


  console.log("\n== Estático: os três pontos de retry chamam o reparo antes de responder 'já finalizada' ==");
  {
    const i0 = submitSrc.indexOf("Deno.serve(");
    const servidor = submitSrc.slice(i0);

    const ownRetry = servidor.indexOf("if (actorAlreadyDone && confirmMinorsRaw.length === 0) {");
    const ownRetryBlock = servidor.slice(ownRetry, servidor.indexOf("}", servidor.indexOf("idempotente: true", ownRetry)) + 1);
    assert.match(ownRetryBlock, /repararStatusOperacionalConfirmado\(admin, row\.hospede_id, now\)/);
    ok("retry do próprio hóspede chama o reparo antes do 'já finalizada'");

    const minorContinue = servidor.indexOf('LIFECYCLE_COMPLETE.has(String(mf.fnrh_lifecycle_status ?? ""))');
    const minorBlock = servidor.slice(minorContinue, servidor.indexOf("continue;", minorContinue) + "continue;".length);
    assert.match(minorBlock, /repararStatusOperacionalConfirmado\(admin, minorGuestId, now\)/);
    ok("retry por menor chama o reparo antes do 'continue'");

    const legacyRetry = servidor.indexOf("// ---------- LEGACY CONFIRM ----------");
    const legacyBlock = servidor.slice(legacyRetry, servidor.indexOf("idempotente: true", legacyRetry) + 20);
    assert.match(legacyBlock, /repararStatusOperacionalConfirmado\(admin, row\.hospede_id, now\)/);
    ok("retry do fluxo legado chama o reparo antes do 'já finalizada'");
  }

  console.log("\n== Estático: respostas finais não dizem sucesso pleno com espelho pendente ==");
  {
    const i0 = submitSrc.indexOf("Deno.serve(");
    const servidor = submitSrc.slice(i0);

    assert.match(servidor, /let hospedeMirrorFailed = false;/);
    assert.match(servidor, /if \(result\.hospedeMirrorError\) hospedeMirrorFailed = true;/g);
    assert.equal(
      (servidor.match(/if \(result\.hospedeMirrorError\) hospedeMirrorFailed = true;/g) || []).length,
      2,
      "próprio hóspede e cada menor confirmado marcam a falha",
    );
    ok("hospedeMirrorFailed agrega falhas do próprio hóspede e dos menores");

    const v2FinalIdx = servidor.indexOf("if (hospedeMirrorFailed) {");
    assert.ok(v2FinalIdx > -1, "resposta final v2 checa hospedeMirrorFailed");
    const v2Final = servidor.slice(v2FinalIdx, v2FinalIdx + 400);
    assert.match(v2Final, /ok: false/);
    ok("v2: resposta final não é ok:true quando o espelho operacional falhou");

    assert.match(
      servidor,
      /const mirrorConfirm = await aplicarUpdateEspelhoOperacional\(admin, row\.hospede_id, hospedeUpdate\);/,
    );
    ok("fluxo legado também delega ao helper único (mesmo usado pela confirmação v2 e pelo reparo)");
    const legacyFinalIdx = servidor.lastIndexOf("if (hospedeMirrorFalhou) {");
    assert.ok(legacyFinalIdx > -1, "resposta final legada checa hospedeMirrorFalhou");
    const legacyFinal = servidor.slice(legacyFinalIdx, legacyFinalIdx + 300);
    assert.match(legacyFinal, /ok: false/);
    ok("legado: resposta final não é ok:true quando o espelho operacional falhou (error nulo não basta)");
  }

  console.log(`\nOK test-fnrh-status-operacional-retry (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
