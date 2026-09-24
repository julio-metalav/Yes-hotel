/**
 * Testes: reservas HITS (snapshot local) alimentando a listagem operacional.
 * Somente leitura — nenhuma ação operacional pode ser oferecida.
 * Determinísticos, sem rede (supabase-js stub), sem browser (node:vm).
 *
 * A UI não consulta mais o HITS ao vivo: lê public.hits_reservas_snapshot e
 * public.hits_snapshot_sync_state pelo cliente Supabase do usuário. Qualquer
 * fetch() aqui é falha de teste.
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

type SyncInfo = {
  status: string;
  level: string;
  message: string;
  lastSuccessAt: Date | null;
  failedCount: number;
  ageMinutes: number | null;
};

type CycleResult = {
  ok: boolean;
  raw: unknown[];
  rows: unknown[];
  sync: SyncInfo | null;
  error?: string;
};

type PreviewApi = {
  toReservaOperacional: (row: Record<string, unknown>) => Record<string, unknown>;
  describeSync: (state: Record<string, unknown> | null, now?: Date) => SyncInfo;
  isReadOnlyId: (id: string) => boolean;
  fetchReservasOperacionais: (options?: {
    force?: boolean;
    reuseOnly?: boolean;
    dateFrom?: string;
    dateTo?: string;
  }) => Promise<Array<Record<string, unknown>>>;
  onCycle: (fn: (result: CycleResult) => void) => void;
  loadCycle: (options?: { force?: boolean; reuseOnly?: boolean }) => Promise<CycleResult>;
  load: () => Promise<CycleResult>;
  READ_ONLY_ID_PREFIX: string;
  SNAPSHOT_STALE_MINUTES: number;
};

type TablePlan = { data?: unknown; error?: { code?: string; message?: string } | null };

/**
 * Cliente Supabase falso: `.from(tabela)` devolve uma cadeia que resolve com o
 * plano da tabela. Conta os SELECTs por tabela e as colunas pedidas.
 */
function fakeSupabase(plan: Record<string, TablePlan>) {
  const selects: Array<{ table: string; columns: string }> = [];
  const client = {
    from(table: string) {
      const p = plan[table] ?? { data: null, error: { code: "42P01", message: "sem plano" } };
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = (columns: string) => {
        selects.push({ table, columns });
        return chain;
      };
      chain.order = self;
      chain.limit = self;
      chain.eq = self;
      chain.maybeSingle = () => Promise.resolve({ data: p.data ?? null, error: p.error ?? null });
      chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve({ data: p.data ?? null, error: p.error ?? null }).then(res, rej);
      return chain;
    },
  };
  return { client, selects };
}

/** Carrega o módulo de UI num contexto isolado, com document/auth stubados. */
function loadPreview(
  supabase?: { client: unknown } | null,
  opts: { withoutAuth?: boolean } = {},
): { api: PreviewApi; fetchCalls: number } {
  const src = readFileSync(resolve(ROOT, "ui/yes-hits-sandbox-preview.js"), "utf8");
  const counter = { fetchCalls: 0 };
  const sandbox: Record<string, unknown> = {
    console,
    Date,
    // querySelector devolve null para o painel → o módulo não faz binding de DOM,
    // mas ainda expõe a API. Um elemento basta para passar do early return.
    document: {
      querySelector: (sel: string) =>
        sel === "#op-hits-sandbox-panel" ? { classList: { toggle() {} } } : null,
      createElement: () => ({ appendChild() {}, classList: { toggle() {} } }),
    },
    YES_HOTEL_SUPABASE_CONFIG: { url: "https://homo.example.supabase.co" },
    YesHotelAuthApp: opts.withoutAuth
      ? undefined
      : {
          getSupabaseClient: () => (supabase ? supabase.client : null),
          // Qualquer uso deste header é leitura ao vivo — proibido no modo snapshot.
          getEdgeFunctionFetchHeaders: async () => {
            throw new Error("getEdgeFunctionFetchHeaders não deve ser usado");
          },
        },
    fetch: async () => {
      counter.fetchCalls += 1;
      throw new Error("fetch() não deve ser chamado: a UI lê o snapshot local");
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = (sandbox as { YesHotelHitsSandboxPreview: PreviewApi }).YesHotelHitsSandboxPreview;
  return {
    api,
    get fetchCalls() {
      return counter.fetchCalls;
    },
  };
}

/**
 * Carrega o painel operacional num contexto isolado e devolve
 * `resolveHitsReadWindow` (mantida para rollback/testes de virada do dia).
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

/** Linha como vem do banco (PostgREST): datas em YYYY-MM-DD. */
const ROW = {
  external_reservation_id: "17613",
  apartamento: "07",
  hospede_principal: "Hospede Sintetico",
  check_in: "2026-09-20",
  check_out: "2026-09-23",
  status_reserva: "ativa",
  ciclo_hits: "confirmada",
  total_hospedes: 2,
};

const NOW = new Date("2026-09-24T15:10:00Z");
const STATE_OK = {
  last_started_at: "2026-09-24T15:00:05Z",
  last_finished_at: "2026-09-24T15:02:45Z",
  last_status: "ok",
  last_error: null,
  last_rows_count: 1,
  last_failed_count: 0,
  last_success_at: "2026-09-24T15:02:45Z",
};

function plano(rows: unknown[] | null, state: unknown, rowsError?: { code: string; message: string }) {
  return {
    hits_reservas_snapshot: rowsError ? { data: null, error: rowsError } : { data: rows, error: null },
    hits_snapshot_sync_state: { data: state, error: null },
  };
}

async function main() {
  console.log("\n== Mapeamento snapshot → listagem operacional ==");
  {
    const { api } = loadPreview();
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
    const { api } = loadPreview();
    const semApto = api.toReservaOperacional({ ...ROW, apartamento: "" });
    assert.equal(semApto.apartamento, "");
    const semPax = api.toReservaOperacional({ ...ROW, total_hospedes: 0 });
    assert.equal(semPax.totalHospedesHits, 1);
    const cancelada = api.toReservaOperacional({ ...ROW, status_reserva: "cancelada" });
    assert.equal(cancelada.statusReserva, "cancelada");
    ok("apartamento ausente fica vazio (a tela mostra —), sem inventar valor");
  }
  {
    const { api } = loadPreview();
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
    const { api } = loadPreview();
    assert.equal(api.toReservaOperacional({ ...ROW, ciclo_hits: "hospedada" }).entrouNoApto, true);
    assert.equal(api.toReservaOperacional({ ...ROW, ciclo_hits: "confirmada" }).entrouNoApto, false);
    // Acesso é credencial do Yes/TTLock: o HITS não concede.
    assert.equal(api.toReservaOperacional({ ...ROW, ciclo_hits: "hospedada" }).acessoLiberado, false);
    ok("ciclo_hits=hospedada vira entrouNoApto, sem liberar acesso");
  }

  console.log("\n== Leitura do snapshot local (sem Edge, sem fetch) ==");
  {
    const sb = fakeSupabase(plano([ROW, { ...ROW, external_reservation_id: "17614" }], STATE_OK));
    const loaded = loadPreview(sb);
    const out = await loaded.api.fetchReservasOperacionais();
    assert.equal(out.length, 2);
    assert.equal(loaded.fetchCalls, 0, "nenhum fetch(): nada de Edge/HITS ao vivo");
    assert.deepEqual(
      sb.selects.map((s) => s.table).sort(),
      ["hits_reservas_snapshot", "hits_snapshot_sync_state"],
    );
    const cols = sb.selects.find((s) => s.table === "hits_reservas_snapshot")!.columns;
    assert.doesNotMatch(cols, /telefone|phone|email|documento|cpf|balance|pagamento|\*/);
    ok("dois SELECTs locais (snapshot + estado), colunas explícitas, zero requisições ao HITS");
  }
  {
    // Painel + grade + KPIs consomem o mesmo ciclo: uma leitura, não duas.
    const sb = fakeSupabase(plano([ROW], STATE_OK));
    const { api } = loadPreview(sb);
    const [a, b] = await Promise.all([
      api.fetchReservasOperacionais(),
      api.fetchReservasOperacionais(),
    ]);
    assert.equal(sb.selects.length, 2, "chamadas concorrentes compartilham a promise");
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);

    await api.fetchReservasOperacionais();
    assert.equal(sb.selects.length, 2, "sem force, reusa o resultado do ciclo");

    await api.fetchReservasOperacionais({ reuseOnly: true });
    assert.equal(sb.selects.length, 2, "reuseOnly nunca abre SELECT novo");

    await api.fetchReservasOperacionais({ force: true });
    assert.equal(sb.selects.length, 4, "force relê o snapshot (barato: SELECT local)");

    await api.load();
    assert.equal(sb.selects.length, 6, "botão do painel relê o snapshot local");
    ok("uma única leitura por ciclo, compartilhada; force/painel releem só o banco local");
  }
  {
    // Janela (dateFrom/dateTo) era da leitura ao vivo: agora é ignorada, sem quebrar.
    const sb = fakeSupabase(plano([ROW], STATE_OK));
    const loaded = loadPreview(sb);
    const out = await loaded.api.fetchReservasOperacionais({
      dateFrom: "2026-09-15",
      dateTo: "2026-10-15",
    });
    assert.equal(out.length, 1);
    assert.equal(loaded.fetchCalls, 0);
    ok("opções de janela legadas são ignoradas: o snapshot é a janela do scheduler");
  }
  {
    // Regressão: o ciclo passou a entregar só o shape transformado e o painel
    // técnico, que lê o shape bruto, esvaziou idReservation/nome/datas.
    const sb = fakeSupabase(plano([ROW], STATE_OK));
    const { api } = loadPreview(sb);
    const cycle = await api.loadCycle();
    assert.equal(sb.selects.length, 2, "uma leitura só");

    // raw = shape da Edge/snapshot, para o painel técnico
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
    ok("um ciclo entrega raw (painel) e rows (grade), sem segunda leitura");
  }
  {
    const js = readFileSync(resolve(ROOT, "ui/yes-hits-sandbox-preview.js"), "utf8");
    assert.match(js, /renderRows\(result\.raw/, "painel precisa renderizar o raw");
    assert.doesNotMatch(js, /renderRows\(result\.rows\)/, "renderRows não pode receber o shape transformado");
    ok("renderCycle alimenta o painel com o shape correto");
  }
  {
    const sb = fakeSupabase(plano(null, STATE_OK, { code: "42501", message: "permission denied" }));
    const { api } = loadPreview(sb);
    const cycle = await api.loadCycle();
    assert.equal(cycle.ok, false);
    assert.equal(cycle.error, "42501");
    assert.equal((await api.fetchReservasOperacionais()).length, 0);
    ok("SELECT negado (RLS) → ok:false com o código, lista vazia, a tela não quebra");
  }
  {
    const { api } = loadPreview(null);
    const cycle = await api.loadCycle();
    assert.equal(cycle.ok, false);
    assert.equal(cycle.error, "supabase_nao_configurado");
    ok("sem cliente Supabase → ok:false explícito, sem exceção");
  }
  {
    const sb = fakeSupabase(plano([{ ...ROW, external_reservation_id: "" }], STATE_OK));
    const { api } = loadPreview(sb);
    assert.equal((await api.fetchReservasOperacionais()).length, 0);
    ok("linha sem idReservation é descartada");
  }
  {
    // Abrir a tela N vezes = N módulos novos: nenhum fetch, nunca.
    let fetches = 0;
    for (let i = 0; i < 5; i++) {
      const sb = fakeSupabase(plano([ROW], STATE_OK));
      const loaded = loadPreview(sb);
      await loaded.api.fetchReservasOperacionais({ force: true });
      fetches += loaded.fetchCalls;
    }
    assert.equal(fetches, 0);
    ok("5 aberturas da tela → 0 chamadas de rede à Edge/gateway HITS");
  }

  console.log("\n== Saúde do snapshot (describeSync) ==");
  {
    const { api } = loadPreview();
    const semEstado = api.describeSync(null, NOW);
    assert.equal(semEstado.status, "sem_snapshot");
    assert.equal(semEstado.level, "error");
    const nuncaOk = api.describeSync({ last_status: "error", last_error: "x", last_success_at: null }, NOW);
    assert.equal(nuncaOk.status, "sem_snapshot", "erro sem nenhum sucesso anterior = sem snapshot");
    ok("sem sync bem-sucedido → 'dados ainda não sincronizados' (nunca '0 reservas')");

    const okRecente = api.describeSync(STATE_OK, NOW);
    assert.equal(okRecente.status, "ok");
    assert.equal(okRecente.level, "ok");
    assert.equal(okRecente.ageMinutes, 7);
    assert.match(okRecente.message, /^sincronizado \d{2}:\d{2}$/);
    ok("sync recente e completo → ok com a hora");

    const falhou = api.describeSync(
      { ...STATE_OK, last_status: "error", last_error: "gateway_read_failed" },
      NOW,
    );
    assert.equal(falhou.status, "falhou");
    assert.equal(falhou.level, "warn");
    assert.match(falhou.message, /falhou — exibindo dados de \d{2}:\d{2}/);
    assert.ok(falhou.lastSuccessAt instanceof Date, "fotografia anterior continua referenciada");
    ok("último ciclo falhou com fotografia anterior → aviso + dados antigos");

    const velho = api.describeSync(
      { ...STATE_OK, last_success_at: "2026-09-24T14:00:00Z" },
      NOW,
    );
    assert.equal(velho.status, "desatualizado");
    assert.equal(velho.level, "warn");
    assert.equal(velho.ageMinutes, 70);
    assert.ok(70 > api.SNAPSHOT_STALE_MINUTES);
    ok("último sucesso além do limiar → desatualizado");

    const parcial = api.describeSync({ ...STATE_OK, last_status: "partial", last_failed_count: 2 }, NOW);
    assert.equal(parcial.status, "parcial");
    assert.equal(parcial.level, "ok");
    assert.match(parcial.message, /2 reservas sem detalhe/);
    ok("parcial → ok com contagem de reservas sem detalhe");

    const rodando = api.describeSync({ ...STATE_OK, last_status: "running" }, NOW);
    assert.equal(rodando.status, "ok", "ciclo em andamento não invalida a fotografia atual");
    ok("running mantém a fotografia válida");
  }
  {
    const sb = fakeSupabase(plano([ROW], { ...STATE_OK, last_status: "error", last_error: "boom" }));
    const { api } = loadPreview(sb);
    const cycle = await api.loadCycle();
    assert.equal(cycle.ok, true);
    assert.equal(cycle.rows.length, 1, "dados antigos continuam na grade");
    assert.equal(cycle.sync!.status, "falhou");
    ok("falha de sync com snapshot anterior: grade mantém os dados, barra avisa");
  }
  {
    const sb = fakeSupabase(plano([], { last_status: null, last_success_at: null }));
    const { api } = loadPreview(sb);
    const cycle = await api.loadCycle();
    assert.equal(cycle.ok, true);
    assert.equal(cycle.rows.length, 0);
    assert.equal(cycle.sync!.status, "sem_snapshot");
    ok("snapshot vazio e nunca sincronizado é distinguível de '0 reservas'");
  }

  console.log("\n== Universo operacional = snapshot HITS (o Yes só enriquece) ==");
  {
    type Reserva = Record<string, unknown>;
    const sb = loadPainelSandbox() as {
      aplicarUniversoHits: (base: Reserva[], universo: unknown) => Reserva[];
      aplicarUniversoHitsChegadas: (items: Reserva[], universo: unknown) => Reserva[];
      universoHitsVazio: () => { gate: boolean; ids: Set<string>; rows: Reserva[]; raw: unknown[] };
      getResumoFunil: (lista: Reserva[]) => { chegadasHoje: number };
      filtrarReservas: (lista: Reserva[], filtro: string) => Reserva[];
      buildArrivalsInputFromInternal: (r: Reserva) => Reserva;
      todayStr: () => string;
    };
    const hoje = sb.todayStr();
    const { api: preview } = loadPreview();
    const hitsRow = (ext: string, apto: string, checkIn = hoje) =>
      preview.toReservaOperacional({
        external_reservation_id: ext, apartamento: apto, hospede_principal: "H " + ext,
        check_in: checkIn, check_out: "2026-12-31", status_reserva: "ativa", ciclo_hits: "confirmada", total_hospedes: 2,
      });
    const local = (ext: string | null, apto: string, checkIn = hoje, extra: Reserva = {}) => ({
      id: "uuid-" + (ext || "manual-" + apto), externalReservationId: ext, origemExterna: ext ? "hits" : "manual",
      apartamento: apto, hospedePrincipal: "Local " + apto, checkInPrevisto: checkIn, checkOutPrevisto: "2026-12-31",
      statusReserva: "ativa", pagamento: "pendente", acessoLiberado: false, entrouNoApto: false,
      hospedes: [{ nome: "A" }, { nome: "B" }], historicoOperacional: [], fnrhStatusAgregado: "fnrh_pendente", ...extra,
    });
    // Snapshot PROD (universo ativo): 3407 (apto 02), 3316 (07) e 3427 (09) chegam hoje.
    const snap = [hitsRow("3407", "02"), hitsRow("3316", "07"), hitsRow("3427", "09")];
    const universo = { gate: true, ids: new Set(snap.map((r) => String(r.externalReservationId))), rows: snap, raw: [] };
    // Banco: 3407 e 3316 materializadas (enriquecidas); fantasmas HOMO 17656/17820; manual sem id.
    const l3407 = local("3407", "2", hoje, { pagamento: "pago" });          // apto local desatualizado: "2"
    const l3316 = local("3316", "07");
    const fantasma1 = local("17656", "102");
    const fantasma2 = local("17820", "107");
    const manual = local(null, "05");
    const base = [l3407, l3316, fantasma1, fantasma2, manual];

    const universoOp = sb.aplicarUniversoHits(base, universo);
    const ids = universoOp.map((r) => String(r.externalReservationId));
    assert.deepEqual([...ids].sort(), ["3316", "3407", "3427"]);
    ok("linha local fora do snapshot (fantasmas 17656/17820) e manual sem id NÃO entram na operação");

    const r3407 = universoOp.find((r) => r.externalReservationId === "3407")!;
    assert.equal(r3407.id, "uuid-3407", "linha local (enriquecida) permanece, não a só-HITS");
    assert.equal(r3407.pagamento, "pago", "enriquecimento local preservado");
    assert.equal((r3407.hospedes as unknown[]).length, 2);
    assert.equal(r3407.apartamento, "02", "apartamento vem do HITS (fonte da verdade)");
    assert.equal(r3407.checkInPrevisto, hoje);
    ok("linha local + snapshot: aparece enriquecida, com apto/datas do HITS");

    const r3427 = universoOp.find((r) => r.externalReservationId === "3427")!;
    assert.equal(r3427.somenteLeituraHits, true);
    assert.equal(r3427.apartamento, "09");
    ok("reserva só no snapshot (apto 09) entra como HITS · leitura");

    // KPI "Chegadas hoje" e chip "Chegando hoje": 3, não 5 (fantasmas fora).
    assert.equal(sb.getResumoFunil(universoOp).chegadasHoje, 3);
    assert.equal(sb.filtrarReservas(universoOp, "chegando_hoje").length, 3);
    assert.equal(sb.getResumoFunil(base).chegadasHoje, 5, "sem o gate, o banco contava fantasmas");
    ok("KPIs e contadores calculam sobre o universo (3), sem fantasmas");

    // Exceções percorrem `reservas`: fantasma não está lá → não gera exceção nem ação.
    assert.equal(universoOp.some((r) => String(r.externalReservationId).startsWith("17")), false);
    ok("Exceções não podem ver o fantasma: ele não existe em `reservas`");

    // Chegadas: mesmo universo — 3/3 (02 e 07 locais enriquecidos, 09 só-HITS).
    const itensBanco = base.map((r) => sb.buildArrivalsInputFromInternal(r));
    const chegadas = sb.aplicarUniversoHitsChegadas(itensBanco, universo);
    assert.deepEqual(chegadas.map((c) => String(c.apartamento)).sort(), ["02", "07", "09"]);
    assert.equal(chegadas.filter((c) => String(c.check_in_previsto) === hoje).length, 3);
    assert.equal(chegadas.find((c) => c.external_reservation_id === "3407")!.pagamento_status, "pago", "chegada local enriquecida");
    assert.equal(chegadas.find((c) => c.external_reservation_id === "3427")!.total_hospedes, 2, "só-HITS usa total do HITS");
    ok("Chegadas: 3 reservas do snapshot com check_in hoje → 3 na lista (02/07/09), fantasmas fora");

    // Cancelada no HITS: a incremental a remove do snapshot → some da operação.
    const semCancelada = { ...universo, ids: new Set(["3316", "3427"]), rows: snap.filter((r) => r.externalReservationId !== "3407") };
    const depois = sb.aplicarUniversoHits(base, semCancelada);
    assert.equal(depois.some((r) => r.externalReservationId === "3407"), false);
    assert.equal(sb.getResumoFunil(depois).chegadasHoje, 2);
    ok("reserva removida do snapshot (cancelada) desaparece da operação e dos contadores");

    // Snapshot indisponível/nunca sincronizado: sem gate → banco mantido (a barra avisa).
    const semGate = sb.aplicarUniversoHits(base, sb.universoHitsVazio());
    assert.equal(semGate.length, 5);
    ok("sem universo válido (gate=false) a tela não apaga o banco: fail-open com aviso");

    // Fonte do universo: só snapshot ok e já sincronizado dá gate.
    const src = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");
    assert.match(src, /ciclo\.sync\.status === "sem_snapshot"\) return universoHitsVazio\(\)/);
    assert.match(src, /if \(!ciclo \|\| ciclo\.ok !== true\) return universoHitsVazio\(\)/);
    assert.match(src, /arrivalsDatasetCache = aplicarUniversoHitsChegadas\(loaded\.items \|\| \[\], universo\)/);
    assert.match(src, /reservas = aplicarUniversoHits\(reservas, universo\)/);
    assert.match(src, /return aplicarUniversoHits\(base, universo\)/);
    ok("Reservas, Chegadas, Exceções e KPIs partem do mesmo universo mesclado");
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

    assert.match(src, /async function carregarUniversoHits/);
    assert.match(src, /function aplicarUniversoHits/);
    assert.match(src, /jaNoBanco/);
    ok("universo HITS + merge em memória com dedupe por external_reservation_id");

    // Regressão: o init travava no await da leitura HITS e nunca chegava a
    // registrar os listeners — grade vazia e botão Atualizar inerte.
    const initLoad = src.indexOf("reservas = (await loadReservasOperacionaisFromProvider()) || []");
    assert.ok(initLoad > -1, "init deve carregar o banco sem esperar o HITS");
    const depoisDoInit = src.slice(initLoad, initLoad + 400);
    assert.match(depoisDoInit, /aplicarLeituraHitsQuandoPronta\(\)/, "init precisa disparar a leitura HITS sem bloquear");
    ok("boot carrega o banco e aplica o snapshot sem bloquear o init");

    assert.match(src, /async function refreshFromSource[\s\S]{0,200}force: true/);
    ok("recarga pós-ação (refreshFromSource) relê o snapshot (SELECT local)");

    // O botão Atualizar da listagem relê o banco e reaproveita o último ciclo.
    const listagem = src.slice(src.indexOf("async function refreshListagem("));
    const listagemBody = listagem.slice(0, listagem.search(/\r?\n\}\r?\n/) + 3);
    assert.match(listagemBody, /reuseOnly: true/);
    assert.doesNotMatch(listagemBody, /force: true/);
    assert.match(src, /opRefreshBtn\?\.addEventListener\("click", \(\) => \{\s*refreshListagem\(\)/);
    ok("Atualizar da listagem reaproveita a última leitura do snapshot");

    // Reconciliação de canceladas pelo detalhe ao vivo fica desligada no modo snapshot.
    assert.match(src, /const HITS_RECONCILIAR_CANCELADAS_AO_VIVO = false;/);
    assert.match(src, /HITS_RECONCILIAR_CANCELADAS_AO_VIVO &&[\s\S]{0,160}await reconciliarCanceladasHits/);
    const carga = src.slice(src.indexOf("async function carregarUniversoHits"));
    const cargaBody = carga.slice(0, carga.search(/\r?\n\}\r?\n/) + 3);
    assert.doesNotMatch(cargaBody, /dateFrom|resolveHitsReadWindow|fetch\(|functions\/v1/, "sem janela e sem Edge: o snapshot é do scheduler");
    assert.match(cargaBody, /api\.loadCycle\(/, "universo vem do ciclo compartilhado do snapshot");
    ok("tela não dispara GET de reconciliação ao gateway; universo sem janela/Edge");

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

  console.log("\n== Janela do dia operacional (mantida para rollback) ==");
  {
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

  console.log("\n== Reservas canceladas no HITS: reconciliação pelo detalhe (código mantido) ==");
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
    const a104 = mk("17820", "hits");
    const b105 = mk("17821", "hits");
    const cMan = mk(null, "manual");
    const dJa = mk("17822", "hits", "cancelada");
    const e107 = mk("17823", "hits");
    const base = [a104, b105, cMan, dJa, e107];
    const feed = [{ externalReservationId: "17823" }];

    const ids = [...sb.selecionarCandidatasCancelamentoHits(base, feed)];
    assert.deepEqual(ids, ["17820", "17821"]);
    ok("candidatas = banco+hits, ativas, fora do feed; manual e já cancelada ficam de fora");

    const confirmadas = [
      ...sb.selecionarCanceladasConfirmadasHits(base, [
        { external_reservation_id: "17820", status_reserva: "cancelada" },
        { external_reservation_id: "17821", status_reserva: "ativa" },
      ]),
    ];
    assert.deepEqual(confirmadas, [a104]);
    assert.equal(a104.statusReserva, "ativa", "seleção não muta: banco ainda não confirmou");
    ok("detalhe confirma cancelada → selecionada, mas ainda ativa em memória");

    const f = mk("17824", "hits");
    assert.deepEqual([...sb.selecionarCanceladasConfirmadasHits([f], [])], []);
    ok("sumiu do feed mas o detalhe não confirmou → não é marcada cancelada");

    const fakeSupabase = (plano: { updateError?: boolean; updateRows?: number; statusAtual?: string }) => {
      const chain = (kind: "update" | "select" | "insert") => {
        const q: Record<string, unknown> = {};
        const self = () => q;
        q.eq = self;
        q.maybeSingle = () =>
          Promise.resolve({ data: { status_reserva: plano.statusAtual ?? "ativa" }, error: null });
        q.select = () =>
          Promise.resolve(
            plano.updateError
              ? { data: null, error: { message: "boom" } }
              : { data: Array.from({ length: plano.updateRows ?? 1 }, () => ({ id: "x" })), error: null },
          );
        if (kind === "insert") return Promise.resolve({ error: null });
        return q;
      };
      return {
        from: () => ({
          update: () => chain("update"),
          select: () => chain("select"),
          insert: () => chain("insert"),
        }),
      };
    };

    const rFalha = mk("17830", "hits");
    const resFalha = await sb.persistirCancelamentoHits(fakeSupabase({ updateError: true }), rFalha.id, "2026-09-16T00:00:00Z");
    assert.equal(resFalha, "falha");
    assert.equal(sb.aplicarResultadoCancelamentoHits(rFalha, resFalha), false);
    assert.equal(rFalha.statusReserva, "ativa");
    ok("UPDATE falhou → reserva segue ativa em memória e sem evento");

    const rOk = mk("17831", "hits");
    const resOk = await sb.persistirCancelamentoHits(fakeSupabase({ updateRows: 1 }), rOk.id, "2026-09-16T00:00:00Z");
    assert.equal(resOk, "cancelada");
    assert.equal(sb.aplicarResultadoCancelamentoHits(rOk, resOk), true);
    assert.deepEqual([...(sb.filtrarReservasOperacionaisAtivas([rOk]) as unknown[])], []);
    ok("UPDATE confirmou → some da grade e gera evento");

    const rJa = mk("17832", "hits");
    const resJa = await sb.persistirCancelamentoHits(fakeSupabase({ updateRows: 0, statusAtual: "cancelada" }), rJa.id, "2026-09-16T00:00:00Z");
    assert.equal(resJa, "ja_cancelada");
    assert.equal(sb.aplicarResultadoCancelamentoHits(rJa, resJa), false);
    ok("segunda execução / outro processo: reconciliada sem evento duplicado");

    const muitas = Array.from({ length: 30 }, (_, i) => mk(String(30000 + i), "hits"));
    assert.equal(sb.selecionarCandidatasCancelamentoHits(muitas, []).length, 20);
    ok("teto de 20 ids por ciclo protege o rate limit do gateway (quando religado)");
  }
  {
    // Guardas estáticas do trecho que escreve no banco (mantido para rollback).
    const src = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");
    const bloco = src.slice(
      src.indexOf("function selecionarCanceladasConfirmadasHits"),
      src.indexOf("function universoHitsVazio"),
    );
    assert.match(bloco, /\.update\(\{ status_reserva: "cancelada", updated_at: nowIso \}\)/);
    assert.match(bloco, /\.eq\("status_reserva", "ativa"\)/, "só marca quem ainda estava ativa");
    const iPersist = bloco.indexOf("await persistirCancelamentoHits(supabase, r.id, nowIso)");
    const iAplica = bloco.indexOf("aplicarResultadoCancelamentoHits(r, resultado)");
    const iEvento = bloco.indexOf('tipo: "hits_reserva_cancelada"');
    assert.ok(iPersist > -1 && iAplica > iPersist && iEvento > iAplica, "banco → memória → evento");
    assert.equal(/\.delete\(/.test(bloco), false, "nada é apagado");
    assert.equal(/operacional_hospedes|fnrh_hospedes/.test(bloco), false, "hóspedes e FNRH intocados");
    ok("escrita restrita a status_reserva + evento; sem delete, sem tocar hóspedes/FNRH");
  }

  console.log("\n== Painel compacto ==");
  {
    const html = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.html"), "utf8");

    for (const id of [
      "op-hits-sandbox-badge",
      "op-hits-sandbox-count",
      "op-hits-sandbox-updated",
      "op-hits-sandbox-toggle",
      "op-hits-sandbox-details",
    ]) {
      assert.ok(html.includes(`id="${id}"`), `faltou ${id}`);
    }
    ok("barra compacta traz badge, contagem, hora e diagnóstico");

    assert.ok(!html.includes('id="op-hits-sandbox-refresh"'), "botão manual Atualizar HITS removido");
    assert.doesNotMatch(html, />\s*Atualizar HITS\s*</);
    assert.doesNotMatch(html, /Leitura direta via API HITS/);
    assert.doesNotMatch(html, /class="op-hits-bar__title">\s*HITS Sandbox/);
    ok("faixa operacional sem Atualizar HITS, sem ambiente e sem texto técnico");

    const details = html.slice(html.indexOf('id="op-hits-sandbox-details"'));
    assert.match(details.slice(0, 120), /class="op-hits-details hidden"/, "diagnóstico deve nascer recolhido");
    const toggle = html.slice(html.indexOf('id="op-hits-sandbox-toggle"'));
    assert.match(toggle.slice(0, 200), /aria-expanded="false"/);
    assert.match(toggle.slice(0, 200), /aria-controls="op-hits-sandbox-details"/);
    ok("tabela técnica recolhida por padrão, com aria correto");

    for (const col of ["idReservation", "Apto", "Hóspede", "Entrada", "Saída", "Status"]) {
      assert.ok(details.includes(col), `coluna ${col} sumiu do diagnóstico`);
    }
    ok("colunas técnicas preservadas dentro do diagnóstico");

    assert.match(html, /yes-hits-sandbox-preview\.js\?v=5/, "cache-bust do módulo do snapshot");
    ok("HTML aponta para a versão do módulo que lê o snapshot");

    const js = readFileSync(resolve(ROOT, "ui/yes-hits-sandbox-preview.js"), "utf8");
    assert.match(js, /function setDetailsOpen/);
    assert.match(js, /setDetailsOpen\(!isDetailsOpen\(\)\)/, "toggle abre e fecha");
    assert.match(js, /setDetailsOpen\(false\)/, "estado inicial recolhido");
    assert.match(js, /function renderResumo/);
    assert.doesNotMatch(js, /op-hits-sandbox-refresh/, "sem referência ao botão manual removido");
    assert.match(js, /op-hits-bar__count--warn/, "estado de aviso na barra");
    ok("toggle alterna e o resumo alimenta a barra, com estado de aviso");
  }

  console.log(`\nOK test-hits-sandbox-operacional-ui (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
