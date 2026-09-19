/**
 * Ciclo 1 FNRH/HITS — cadastro mestre (crm_guests) e cadastro operacional.
 *
 * O bloco CRM de `supabase/functions/fnrh-submit/index.ts` é extraído pelos
 * marcadores `crm-guests:begin/end`, transpilado e executado contra um cliente
 * Supabase falso em memória. Sem Deno, sem rede, sem banco. O resto do arquivo
 * (Parte A e a ordem em relação ao PUT HITS) é conferido estaticamente, como
 * já fazem os demais testes desta Edge.
 *
 * Nenhum dado real: CPFs abaixo são gerados pelo checksum, nomes são fictícios.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { resolveGuestIdentity } from "../src/lib/crm/identity.ts";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const ROOT = resolve(process.cwd());
const SUBMIT_PATH = resolve(ROOT, "supabase/functions/fnrh-submit/index.ts");
const submitSrc = readFileSync(SUBMIT_PATH, "utf8");

// ---------------------------------------------------------------------------
// Cliente Supabase falso — só o que o bloco usa: from().select().eq().maybeSingle(),
// from().insert(), from().update().eq(). Guarda cada chamada para inspeção.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;
type Call = { table: string; op: "select" | "insert" | "update"; payload?: Row; filters: Array<[string, unknown]> };

function makeFakeClient(opts: {
  tables?: Record<string, Row[]>;
  insertError?: { code: string; message: string } | null;
  selectError?: { code: string; message: string } | null;
  updateError?: { code: string; message: string } | null;
  insertErrorOnce?: boolean;
} = {}) {
  const tables: Record<string, Row[]> = opts.tables ?? {};
  const calls: Call[] = [];
  let insertErrorArmed = opts.insertError ?? null;

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
    builder.insert = async (payload: Row) => {
      calls.push({ table, op: "insert", payload, filters });
      if (insertErrorArmed) {
        const err = insertErrorArmed;
        if (opts.insertErrorOnce) insertErrorArmed = null;
        return { data: null, error: err };
      }
      rows.push({ id: `id-${rows.length + 1}`, ...payload });
      return { data: null, error: null };
    };
    builder.update = (payload: Row) => {
      const call: Call = { table, op: "update", payload, filters };
      calls.push(call);
      const upd = {
        eq(k: string, v: unknown) {
          filters.push([k, v]);
          return upd;
        },
        then(onOk: (r: { data: null; error: unknown }) => unknown, onErr?: (e: unknown) => unknown) {
          return Promise.resolve()
            .then(() => {
              if (opts.updateError) return { data: null, error: opts.updateError };
              for (const r of rows) if (applyFilters(r)) Object.assign(r, payload);
              return { data: null, error: null };
            })
            .then(onOk, onErr);
        },
      };
      return upd;
    };
    return builder;
  }
  return { client: { from }, calls, tables };
}

// ---------------------------------------------------------------------------
// Extração e execução do bloco CRM real.
// ---------------------------------------------------------------------------
type CrmModule = {
  upsertCrmGuestFromFnrh: (client: unknown, input: { source: Row; now: string }) => Promise<Row>;
  registrarFalhaCrmGuest: (client: unknown, reservaId: string, code: string) => Promise<void>;
  buildCrmGuestAttributes: (src: Row) => Record<string, string>;
  resolveCrmIdentity: (src: Row) => Row | null;
};

function loadCrmBlock(logSink: unknown[][]): CrmModule {
  const begin = submitSrc.indexOf("// --- crm-guests:begin ---");
  const end = submitSrc.indexOf("// --- crm-guests:end ---");
  assert.ok(begin > -1 && end > begin, "marcadores crm-guests:begin/end presentes");
  const block = submitSrc.slice(begin, end);
  const source =
    block +
    "\nmodule.exports = { upsertCrmGuestFromFnrh, registrarFalhaCrmGuest, buildCrmGuestAttributes, resolveCrmIdentity };\n";
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  assert.equal((out.diagnostics ?? []).length, 0, "bloco CRM transpila sem erro de sintaxe");
  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
    console: {
      warn: (...args: unknown[]) => logSink.push(args),
      log: (...args: unknown[]) => logSink.push(args),
      error: (...args: unknown[]) => logSink.push(args),
    },
    resolveGuestIdentity,
    Promise,
    JSON,
    String,
    Date,
    Object,
    isNaN,
  };
  vm.createContext(sandbox);
  vm.runInContext(out.outputText, sandbox);
  const raw = (sandbox.module as { exports: CrmModule }).exports;
  // Objetos nascem no realm do vm: normaliza para comparar com deepEqual.
  const plain = <T,>(v: T): T => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    upsertCrmGuestFromFnrh: async (c, i) => plain(await raw.upsertCrmGuestFromFnrh(c, i)),
    registrarFalhaCrmGuest: (c, r, code) => raw.registrarFalhaCrmGuest(c, r, code),
    buildCrmGuestAttributes: (s) => plain(raw.buildCrmGuestAttributes(s)),
    resolveCrmIdentity: (s) => plain(raw.resolveCrmIdentity(s)),
  };
}

const NOW = "2026-09-17T12:00:00.000Z";
const LATER = "2026-09-18T09:30:00.000Z";
// CPF sintético com dígitos verificadores válidos (não pertence a pessoa real).
const CPF_VALIDO = "52998224725";
const CPF_INVALIDO = "52998224700";

function fonteAdulto(partial: Row = {}): Row {
  return {
    hospede_nome: "Hospede Civil Teste",
    nome_social: "Nome Social Teste",
    documento_tipo: "cpf",
    documento_numero: "529.982.247-25",
    nacionalidade: "Brasileira",
    data_nascimento: "1990-01-15",
    email: "hospede.teste@example.com",
    telefone: "5567999990000",
    cidade: "Campo Grande",
    uf: "MS",
    pais: "Brasil",
    is_minor: false,
    ...partial,
  };
}

function stringifyAll(v: unknown): string {
  return JSON.stringify(v) ?? "";
}

async function main() {
  const logs: unknown[][] = [];
  const crm = loadCrmBlock(logs);

  console.log("\n== Edge inteira: sintaxe ==");
  {
    // Sem Deno na máquina: pelo menos a transpilação sintática do arquivo todo.
    const out = ts.transpileModule(submitSrc, {
      reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    const diags = (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.deepEqual(diags, [], "fnrh-submit/index.ts sem erro de sintaxe");
    ok("supabase/functions/fnrh-submit/index.ts transpila sem diagnóstico sintático");
  }

  console.log("\n== CPF válido: cria crm_guests ==");
  {
    const fake = makeFakeClient();
    const r = await crm.upsertCrmGuestFromFnrh(fake.client, { source: fonteAdulto(), now: NOW });
    assert.deepEqual(r, { status: "created" });
    const rows = fake.tables.crm_guests;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.match_key, `cpf:${CPF_VALIDO}`);
    assert.equal(row.document_type, "cpf");
    assert.equal(row.document_number_normalized, CPF_VALIDO);
    assert.equal(row.country_code, "BR");
    assert.equal(row.full_name, "Hospede Civil Teste");
    assert.equal(row.birth_date, "1990-01-15");
    assert.equal(row.email, "hospede.teste@example.com");
    assert.equal(row.phone, "5567999990000");
    assert.equal(row.city, "Campo Grande");
    assert.equal(row.state, "MS");
    assert.equal(row.country, "Brasil");
    assert.equal(row.first_seen_at, NOW);
    assert.equal(row.last_seen_at, NOW);
    ok("insert com match_key, documento normalizado e atributos confirmados");

    assert.equal(stringifyAll(row).includes("Nome Social Teste"), false, "nome social não entra");
    assert.equal(row.full_name, "Hospede Civil Teste");
    ok("nome social nunca vira full_name");

    const inserted = fake.calls.find((c) => c.op === "insert")!;
    const colunas = Object.keys(inserted.payload!).sort();
    const permitidas = [
      "birth_date", "city", "country", "country_code", "document_number_normalized", "document_type",
      "email", "first_seen_at", "full_name", "last_seen_at", "match_key", "phone", "state", "updated_at",
    ];
    for (const c of colunas) assert.ok(permitidas.includes(c), `coluna inesperada no insert: ${c}`);
    ok("insert só usa colunas já existentes em crm_guests");
  }

  console.log("\n== Registro existente: mantém first_seen_at, atualiza last_seen_at ==");
  {
    const fake = makeFakeClient({
      tables: {
        crm_guests: [{
          id: "g-1",
          match_key: `cpf:${CPF_VALIDO}`,
          document_type: "cpf",
          document_number_normalized: CPF_VALIDO,
          full_name: "Nome Antigo",
          email: "antigo@example.com",
          phone: "5567988880000",
          city: "Dourados",
          first_seen_at: NOW,
          last_seen_at: NOW,
        }],
      },
    });
    const r = await crm.upsertCrmGuestFromFnrh(fake.client, { source: fonteAdulto(), now: LATER });
    assert.deepEqual(r, { status: "updated" });
    const row = fake.tables.crm_guests[0]!;
    assert.equal(row.first_seen_at, NOW, "first_seen_at preservado");
    assert.equal(row.last_seen_at, LATER, "last_seen_at atualizado");
    assert.equal(row.full_name, "Hospede Civil Teste");
    assert.equal(row.city, "Campo Grande");
    assert.equal(fake.calls.filter((c) => c.op === "insert").length, 0, "sem insert duplicado");
    const upd = fake.calls.find((c) => c.op === "update")!;
    assert.equal("first_seen_at" in upd.payload!, false, "patch não toca first_seen_at");
    assert.equal("match_key" in upd.payload!, false, "patch não reescreve a identidade");
    ok("update preserva first_seen_at, atualiza last_seen_at e dados confirmados");
  }

  console.log("\n== Valores vazios não apagam dados existentes ==");
  {
    const fake = makeFakeClient({
      tables: {
        crm_guests: [{
          id: "g-1",
          match_key: `cpf:${CPF_VALIDO}`,
          document_type: "cpf",
          document_number_normalized: CPF_VALIDO,
          full_name: "Nome Existente",
          birth_date: "1980-05-05",
          email: "existente@example.com",
          phone: "5567977770000",
          city: "Dourados",
          state: "MS",
          country: "Brasil",
          first_seen_at: NOW,
          last_seen_at: NOW,
        }],
      },
    });
    const r = await crm.upsertCrmGuestFromFnrh(fake.client, {
      source: fonteAdulto({
        email: "",
        telefone: "   ",
        cidade: null,
        uf: undefined,
        pais: "",
        data_nascimento: "",
        hospede_nome: "  ",
      }),
      now: LATER,
    });
    assert.deepEqual(r, { status: "updated" });
    const row = fake.tables.crm_guests[0]!;
    assert.equal(row.full_name, "Nome Existente");
    assert.equal(row.birth_date, "1980-05-05");
    assert.equal(row.email, "existente@example.com");
    assert.equal(row.phone, "5567977770000");
    assert.equal(row.city, "Dourados");
    assert.equal(row.state, "MS");
    assert.equal(row.country, "Brasil");
    assert.equal(row.last_seen_at, LATER);
    const upd = fake.calls.find((c) => c.op === "update")!;
    assert.deepEqual(Object.keys(upd.payload!).sort(), ["last_seen_at", "updated_at"]);
    ok("string vazia, espaços, null e undefined ficam fora do patch");
  }

  console.log("\n== Sem identidade forte: nada no CRM, confirmação segue ==");
  {
    const fake = makeFakeClient();
    const r = await crm.upsertCrmGuestFromFnrh(fake.client, {
      source: fonteAdulto({ documento_tipo: "rg", documento_numero: "1234567" }),
      now: NOW,
    });
    assert.deepEqual(r, { status: "skipped", reason: "no_strong_identity" });
    assert.equal(fake.calls.length, 0, "nenhuma chamada ao banco");
    ok("RG + telefone + e-mail não criam identidade nem registro fraco");

    const fake2 = makeFakeClient();
    const r2 = await crm.upsertCrmGuestFromFnrh(fake2.client, {
      source: fonteAdulto({ documento_tipo: "", documento_numero: "", nacionalidade: "" }),
      now: NOW,
    });
    assert.deepEqual(r2, { status: "skipped", reason: "no_strong_identity" });
    assert.equal(fake2.calls.length, 0);
    ok("só e-mail/telefone: sem chave, sem gravação");

    const fake3 = makeFakeClient();
    const r3 = await crm.upsertCrmGuestFromFnrh(fake3.client, {
      source: fonteAdulto({ documento_tipo: "cpf", documento_numero: CPF_INVALIDO }),
      now: NOW,
    });
    assert.deepEqual(r3, { status: "skipped", reason: "no_strong_identity" });
    assert.equal(fake3.calls.length, 0);
    ok("CPF com dígito inválido não vira identidade (nem passaporte 'sugerido')");

    assert.equal(crm.resolveCrmIdentity(fonteAdulto({ documento_tipo: "", nacionalidade: "Argentina", documento_numero: "AB123456" })), null);
    ok("passaporte só com tipo declarado — sugestão por nacionalidade não basta");
  }

  console.log("\n== Passaporte declarado ==");
  {
    const fake = makeFakeClient();
    const r = await crm.upsertCrmGuestFromFnrh(fake.client, {
      source: fonteAdulto({ documento_tipo: "passport", documento_numero: "ab-123456", nacionalidade: "Argentina", pais: "Argentina" }),
      now: NOW,
    });
    assert.deepEqual(r, { status: "created" });
    const row = fake.tables.crm_guests[0]!;
    assert.equal(row.match_key, "passport:AB123456");
    assert.equal(row.document_type, "passport");
    assert.equal(row.document_number_normalized, "AB123456");
    assert.equal(row.country_code, null);
    ok("passaporte normalizado conforme identity.ts; country_code só é afirmado para CPF");
  }

  console.log("\n== Menor: contato do responsável não entra no cadastro do menor ==");
  {
    const attrs = crm.buildCrmGuestAttributes(fonteAdulto({ is_minor: true }));
    assert.equal("email" in attrs, false);
    assert.equal("phone" in attrs, false);
    assert.equal(attrs.full_name, "Hospede Civil Teste");
    ok("is_minor exclui email/phone, mantém nome civil e nascimento");
  }

  console.log("\n== Corrida: insert 23505 vira update ==");
  {
    const fake = makeFakeClient({ insertError: { code: "23505", message: "duplicate key" }, insertErrorOnce: true });
    fake.tables.crm_guests = [{ id: "g-9", match_key: `cpf:${CPF_VALIDO}`, first_seen_at: NOW, last_seen_at: NOW }];
    // O select inicial não vê a linha (simula inserção concorrente entre select e insert).
    const origFrom = fake.client.from;
    let selects = 0;
    fake.client.from = (table: string) => {
      const b = origFrom(table) as Record<string, unknown>;
      const origSelect = b.select as () => Record<string, unknown>;
      b.select = () => {
        const sel = origSelect();
        if (selects++ === 0) sel.maybeSingle = async () => ({ data: null, error: null });
        return sel;
      };
      return b;
    };
    const r = await crm.upsertCrmGuestFromFnrh(fake.client, { source: fonteAdulto(), now: LATER });
    assert.deepEqual(r, { status: "updated" });
    assert.equal(fake.tables.crm_guests[0]!.first_seen_at, NOW);
    assert.equal(fake.tables.crm_guests[0]!.last_seen_at, LATER);
    ok("conflito de chave única não duplica nem falha: atualiza o existente");
  }

  console.log("\n== Falha técnica: erro sem PII, confirmação não depende ==");
  {
    const fake = makeFakeClient({ insertError: { code: "42501", message: `permission denied for Key (match_key)=(cpf:${CPF_VALIDO})` } });
    const r = await crm.upsertCrmGuestFromFnrh(fake.client, { source: fonteAdulto(), now: NOW });
    assert.deepEqual(r, { status: "error", code: "42501" });
    ok("erro de banco devolve só o código");

    logs.length = 0;
    await crm.registrarFalhaCrmGuest(fake.client, "reserva-1", "42501");
    const evento = fake.calls.find((c) => c.table === "operacional_reserva_eventos" && c.op === "insert")!;
    assert.ok(evento, "evento operacional registrado");
    assert.equal(evento.payload!.tipo, "crm_guest_upsert");
    const textoEvento = stringifyAll(evento.payload);
    const textoLog = stringifyAll(logs);
    for (const pii of [CPF_VALIDO, "Hospede Civil Teste", "hospede.teste@example.com", "5567999990000", "permission denied"]) {
      assert.equal(textoEvento.includes(pii), false, `evento não pode conter ${pii}`);
      assert.equal(textoLog.includes(pii), false, `log não pode conter ${pii}`);
    }
    assert.ok(textoLog.includes("42501"));
    ok("log e evento carregam só o código do erro — sem CPF, nome, contato ou mensagem do banco");

    const fakeSel = makeFakeClient({ selectError: { code: "PGRST000", message: "boom" } });
    const rs = await crm.upsertCrmGuestFromFnrh(fakeSel.client, { source: fonteAdulto(), now: NOW });
    assert.deepEqual(rs, { status: "error", code: "PGRST000" });
    assert.equal(fakeSel.calls.filter((c) => c.op !== "select").length, 0, "sem escrita após falha de leitura");
    ok("falha de leitura não tenta escrever");

    const fakeThrow = { from: () => { throw new Error(`boom ${CPF_VALIDO}`); } };
    const rt = await crm.upsertCrmGuestFromFnrh(fakeThrow, { source: fonteAdulto(), now: NOW });
    assert.deepEqual(rt, { status: "error", code: "exception" });
    ok("exceção inesperada vira resultado interno, não estoura a confirmação");
  }

  console.log("\n== Parte A — operacional_hospedes no confirm v2 (estático) ==");
  {
    const i0 = submitSrc.indexOf("async function confirmV2Guest(");
    const i1 = submitSrc.indexOf("Deno.serve(");
    const confirmBlock = submitSrc.slice(i0, i1);
    assert.match(confirmBlock, /status_operacional:\s*"confirmado"/);
    assert.match(confirmBlock, /if \(input\.draft\.email\) hospedeUpdate\.email = input\.draft\.email;/);
    assert.match(confirmBlock, /if \(input\.draft\.telefone\) hospedeUpdate\.whatsapp = input\.draft\.telefone;/);
    ok("status_operacional, email e whatsapp continuam como antes");

    assert.match(confirmBlock, /const nomeCivilConfirmado = crmText\(input\.draft\.hospede_nome\);/);
    assert.match(confirmBlock, /if \(nomeCivilConfirmado\) hospedeUpdate\.nome = nomeCivilConfirmado;/);
    assert.match(confirmBlock, /const nascimentoConfirmado = crmDate\(input\.draft\.data_nascimento\);/);
    assert.match(confirmBlock, /if \(nascimentoConfirmado\) hospedeUpdate\.data_nascimento = nascimentoConfirmado;/);
    ok("nome e data_nascimento entram só quando confirmados e não vazios");

    assert.equal(/hospedeUpdate\.nome\s*=\s*[^;]*nome_social/.test(confirmBlock), false);
    ok("nome social nunca é gravado no nome civil");

    assert.equal(confirmBlock.includes('.from("operacional_reservas")'), false, "confirm não escreve na reserva");
    ok("dados da reserva não são alterados no confirm");

    // CRM: chamado depois do update operacional, antes do sync; erro não interrompe.
    const iHosp = confirmBlock.indexOf("aplicarUpdateEspelhoOperacional(admin, input.guestId");
    const iCrm = confirmBlock.indexOf("await upsertCrmGuestFromFnrh(admin,");
    const iErr = confirmBlock.indexOf('if (crm.status === "error")');
    const iSync = confirmBlock.indexOf("await syncFnrhToHits(admin, input.fnrhId");
    assert.ok(iHosp > -1 && iCrm > iHosp && iErr > iCrm && iSync > iErr, "ordem: hóspede → CRM → sync");
    const errBlock = confirmBlock.slice(iErr, confirmBlock.indexOf("}", iErr));
    assert.equal(/return/.test(errBlock), false, "falha do CRM não retorna cedo");
    assert.match(errBlock, /registrarFalhaCrmGuest\(admin, input\.reservaId, crm\.code\)/);
    assert.match(confirmBlock, /return \{ ok: true, crm \};/);
    ok("falha do CRM: registra, preserva a FNRH confirmada e segue para um único sync HITS");

    assert.equal((confirmBlock.match(/syncFnrhToHits\(/g) || []).length, 1, "um único sync por confirm");
    ok("PUT HITS não é repetido por causa do CRM");

    // Falha ao gravar operacional_hospedes: capturada via helper único
    // (aplicarUpdateEspelhoOperacional), não interrompe CRM/auditoria/sync,
    // e não é confundida com sucesso pleno. A cobertura comportamental do
    // helper (erro -> falha; zero linhas -> falha; uma linha -> sucesso)
    // está em scripts/test-fnrh-status-operacional-retry.ts.
    assert.match(
      confirmBlock,
      /const mirrorConfirm = await aplicarUpdateEspelhoOperacional\(admin, input\.guestId, hospedeUpdate\);/,
    );
    assert.match(confirmBlock, /hospedeMirrorError: "Falha ao gravar operacional_hospedes\.status_operacional\."/);
    ok("falha ao espelhar status_operacional é sinalizada via o helper único, não escondida");
  }


  console.log("\n== PUT HITS intocado ==");
  {
    const sync = submitSrc.slice(submitSrc.indexOf("async function syncFnrhToHits"));
    assert.equal((sync.match(/method: "PUT"/g) || []).length, 1);
    assert.match(sync, /const res = await fetch\(`\$\{gatewayUrl\}\/v1\/guests`, \{\s*method: "PUT",/);
    assert.match(sync, /body: JSON\.stringify\(mapped\.dto\),/);
    assert.match(sync, /const mapped = buildHitsGuestPutFromFnrh\(\{\s*idEntity,\s*idReservation,\s*fnrh: fnrh as Record<string, unknown>,\s*\}\);/);
    assert.equal(sync.includes("crm_guests"), false, "sync não sabe do CRM");
    assert.equal(sync.includes("crm"), false);
    ok("payload e destino do PUT continuam vindo do mapper; sync não toca crm_guests");
  }

  console.log(`\nOK test-fnrh-crm-guests-upsert (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
