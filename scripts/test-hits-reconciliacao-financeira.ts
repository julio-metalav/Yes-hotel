/**
 * Reconciliação financeira contínua HITS → Yes.
 *
 * Caso que originou isto: reserva 3281, apto 022. O HITS informa
 * reservationBalanceDue = 0 e creditState "Total" desde 25/09, mas o Yes
 * mostrava "não pago". Causa: o backfill financeiro da materialização só age
 * enquanto `reservation_balance_due` é nulo, então qualquer quitação posterior
 * à materialização nunca chegava.
 *
 * O que estes testes protegem, acima de tudo: a reconciliação é de MÃO ÚNICA.
 * Promove para pago; nunca rebaixa; nunca aumenta um saldo que o Pagar.me já
 * reduziu.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COLUNAS_FINANCEIRAS_RECONCILIAVEIS,
  decidirReconciliacaoFinanceiraHits,
  financeiroLocalQuitado,
  patchSomenteFinanceiro,
  type FinanceiroHits,
  type FinanceiroLocal,
} from "../src/lib/domain/yes-hotel/reservation-financial-reconciliation.ts";
import {
  reconciliarFinanceiroDaReserva,
  type SupabaseAdminLike,
} from "../src/lib/integrations/hits/hits-materializar.ts";
import { mapPaymentStatusFromBalanceDue } from "../src/lib/domain/yes-hotel/reservation-financial-classification.ts";
import type { SyncedReservation } from "../src/lib/domain/yes-hotel/synced-reservation.ts";

function ok(label: string) {
  console.log(`  OK  ${label}`);
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const semComentarios = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const EXTERNO = "3281";
const VALOR = 1069.5;

const local = (patch: Partial<FinanceiroLocal> = {}): FinanceiroLocal => ({
  pagamentoStatus: "pendente",
  reservationBalanceDue: VALOR,
  reservationTotalAmount: VALOR,
  classificacaoComissionamento: "nao_comissionada",
  classificacaoComissionamentoOrigem: "hits_campo",
  ...patch,
});

const hits = (patch: Partial<FinanceiroHits> = {}): FinanceiroHits => ({
  reservationBalanceDue: 0,
  reservationTotalAmount: VALOR,
  classificacaoComissionamento: "nao_comissionada",
  ...patch,
});

const decidir = (l: Partial<FinanceiroLocal>, h: Partial<FinanceiroHits>) =>
  decidirReconciliacaoFinanceiraHits({ local: local(l), hits: hits(h) });

// ---------------------------------------------------------------------------
// Banco falso: só operacional_reservas, que é a única tabela que a
// reconciliação financeira pode tocar. Qualquer outra tabela explode.
// ---------------------------------------------------------------------------
function fakeDb(reservaInicial: Record<string, unknown> | null) {
  const reservas: Array<Record<string, unknown>> = reservaInicial
    ? [{ id: "res-1", origem_externa: "hits", external_reservation_id: EXTERNO, ...reservaInicial }]
    : [];
  const writes: Array<{ table: string; op: string; payload?: unknown }> = [];
  const tabelasTocadas = new Set<string>();

  function query(table: string) {
    tabelasTocadas.add(table);
    if (table !== "operacional_reservas") {
      throw new Error("a reconciliação financeira tocou tabela proibida: " + table);
    }
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let mode: "select" | "update" = "select";
    let payload: Record<string, unknown> | null = null;
    let single = false;
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (k: string, v: unknown) => { filters.push((r) => r[k] === v); return q; };
    q.is = (k: string, v: unknown) => { filters.push((r) => r[k] == v); return q; };
    q.maybeSingle = () => { single = true; return q; };
    q.single = () => { single = true; return q; };
    q.update = (p: Record<string, unknown>) => { mode = "update"; payload = p; return q; };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      let out: { data: unknown; error: unknown };
      if (mode === "update") {
        const alvo = reservas.filter((r) => filters.every((f) => f(r)));
        alvo.forEach((r) => Object.assign(r, payload));
        writes.push({ table, op: "update", payload });
        out = { data: alvo.map((r) => ({ id: r.id })), error: null };
      } else {
        // Leitura devolve CÓPIA, como o banco real: quem leu não enxerga
        // alterações posteriores da linha. É o que torna observável a corrida.
        const found = reservas.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
        out = { data: single ? (found[0] ?? null) : found, error: null };
      }
      return Promise.resolve(out).then(res, rej);
    };
    return q;
  }

  const admin: SupabaseAdminLike = { from: (t: string) => query(t) };
  return { admin, reservas, writes, tabelasTocadas };
}

const synced = (patch: Partial<SyncedReservation> = {}): SyncedReservation =>
  ({
    externalReservationId: EXTERNO,
    apartmentCode: "022",
    mainGuestName: "Hospede Exemplo",
    checkIn: "2026-09-25",
    checkOut: "2026-09-28",
    totalGuests: 1,
    mealPlanDesc: "Café da Manhã",
    paymentStatus: "pago",
    reservationBalanceDue: 0,
    reservationTotalAmount: VALOR,
    classificacaoComissionamento: "nao_comissionada",
    guests: [],
    ...patch,
  }) as unknown as SyncedReservation;

console.log("\n== A. Local pendente 1069,50 + HITS 0 → pago com saldo 0 ==");
{
  const d = decidir({}, {});
  assert.equal(d.atualiza, true);
  assert.equal(d.motivo, "hits_quitou_promove_pago");
  assert.equal(d.patch.pagamento_status, "pago");
  assert.equal(d.patch.reservation_balance_due, 0);
  assert.equal(patchSomenteFinanceiro(d.patch), true);
  // É exatamente a regra oficial já existente, não uma regra nova.
  assert.equal(mapPaymentStatusFromBalanceDue(0), "pago");
  ok("A. promoção acontece e usa a regra oficial de saldo");
}

console.log("\n== B. Local pendente + HITS negativo (crédito) → pago ==");
{
  const d = decidir({}, { reservationBalanceDue: -120.75 });
  assert.equal(d.atualiza, true);
  assert.equal(d.patch.pagamento_status, "pago");
  assert.equal(d.patch.reservation_balance_due, -120.75);
  assert.equal(mapPaymentStatusFromBalanceDue(-120.75), "pago");
  ok("B. saldo negativo também promove, e o crédito é preservado");
}

console.log("\n== C. Local pago 0 + HITS 1069,50 → NÃO rebaixa ==");
{
  const d = decidir(
    { pagamentoStatus: "pago", reservationBalanceDue: 0 },
    { reservationBalanceDue: VALOR },
  );
  assert.equal(d.atualiza, false);
  assert.equal(d.motivo, "hits_com_saldo_positivo_nao_sobrescreve");
  assert.deepEqual(d.patch, {});
  // Nem mesmo quando o local está pago sem saldo registrado.
  const semSaldo = decidir(
    { pagamentoStatus: "pago", reservationBalanceDue: null },
    { reservationBalanceDue: VALOR },
  );
  assert.equal(semSaldo.atualiza, false);
  ok("C. HITS com saldo positivo nunca rebaixa um local pago");
}

console.log("\n== D. Local 500 reduzido por Pagar.me + HITS 1069,50 → NÃO aumenta ==");
{
  const d = decidir(
    { pagamentoStatus: "pendente", reservationBalanceDue: 500 },
    { reservationBalanceDue: VALOR },
  );
  assert.equal(d.atualiza, false);
  assert.deepEqual(d.patch, {});
  ok("D. saldo parcial local não volta ao valor cheio do HITS");
}

console.log("\n== E. Local pendente 1069,50 + HITS 500 → não sobrescreve nesta fase ==");
{
  const d = decidir({}, { reservationBalanceDue: 500 });
  assert.equal(d.atualiza, false);
  assert.equal(d.motivo, "hits_com_saldo_positivo_nao_sobrescreve");
  assert.deepEqual(d.patch, {});
  // Nem mesmo descendo: qualquer saldo positivo do HITS é ignorado por ora.
  const descendo = decidir({ reservationBalanceDue: 900 }, { reservationBalanceDue: 500 });
  assert.equal(descendo.atualiza, false);
  ok("E. saldo positivo do HITS não sobrescreve o financeiro local");
}

console.log("\n== Saldo ausente e saldo que não desce ==");
{
  // Ausência de dado nunca vira pendente nem apaga nada.
  const semDado = decidir({}, { reservationBalanceDue: null });
  assert.equal(semDado.atualiza, false);
  assert.equal(semDado.motivo, "hits_sem_saldo_informado");
  assert.equal(mapPaymentStatusFromBalanceDue(null), "desconhecido");

  // Local com crédito de -50 e HITS em 0: promove o status, mas NÃO sobe o
  // saldo de -50 para 0 — isso seria aumentar saldo.
  const credito = decidir(
    { pagamentoStatus: "pendente", reservationBalanceDue: -50 },
    { reservationBalanceDue: 0 },
  );
  assert.equal(credito.atualiza, true);
  assert.equal(credito.patch.pagamento_status, "pago");
  assert.equal(credito.patch.reservation_balance_due, undefined, "saldo não sobe de -50 para 0");
  ok("saldo ausente não faz nada; saldo local menor que o do HITS é preservado");
}

console.log("\n== Comissionamento: campo derivado cede à classificação humana ==");
{
  const manual = decidir(
    {
      classificacaoComissionamento: "comissionada",
      classificacaoComissionamentoOrigem: "manual_operador",
    },
    { classificacaoComissionamento: "nao_comissionada" },
  );
  assert.equal(manual.atualiza, true, "ainda promove o pagamento");
  assert.equal(manual.patch.pagamento_status, "pago");
  assert.equal(manual.patch.classificacao_comissionamento, undefined, "não sobrescreve classificação manual");
  assert.equal(manual.patch.classificacao_comissionamento_origem, undefined);

  const derivado = decidir(
    {
      classificacaoComissionamento: "comissionada",
      classificacaoComissionamentoOrigem: "hits_campo",
    },
    { classificacaoComissionamento: "nao_comissionada" },
  );
  assert.equal(derivado.patch.classificacao_comissionamento, "nao_comissionada");
  assert.equal(derivado.patch.classificacao_comissionamento_origem, "hits_campo");

  const semClassifHits = decidir({}, { classificacaoComissionamento: null });
  assert.equal(semClassifHits.patch.classificacao_comissionamento, undefined);
  ok("classificação manual vence; derivada acompanha o HITS; nula não apaga");
}

console.log("\n== F. Idempotência ==");
{
  // Estado já coerente: nada a escrever.
  const coerente = decidir(
    { pagamentoStatus: "pago", reservationBalanceDue: 0, reservationTotalAmount: VALOR },
    {},
  );
  assert.equal(coerente.atualiza, false);
  assert.equal(coerente.motivo, "local_ja_coerente");
  assert.deepEqual(coerente.patch, {});
  assert.equal(financeiroLocalQuitado(local({ pagamentoStatus: "pago", reservationBalanceDue: 0 })), true);
  ok("F1. decisão pura é idempotente quando o estado já bate");
}

async function blocoEscritaReal() {
  console.log("\n== G. Escrita real: só o financeiro, e uma vez só ==");
    const db = fakeDb({
      pagamento_status: "pendente",
      reservation_balance_due: VALOR,
      reservation_total_amount: VALOR,
      classificacao_comissionamento: "nao_comissionada",
      classificacao_comissionamento_origem: "hits_campo",
      // Colunas que não podem ser tocadas de jeito nenhum.
      hospede_principal: "Hospede Exemplo",
      meal_plan_desc: "Café da Manhã",
      acesso_liberado: false,
      pagamento_presencial_diferido_efetivado: false,
    });

    const r1 = await reconciliarFinanceiroDaReserva({
      admin: db.admin,
      externalId: EXTERNO,
      synced: synced(),
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.atualizado, true);
    assert.equal(r1.motivo, "hits_quitou_promove_pago");

    const reserva = db.reservas[0]!;
    assert.equal(reserva.pagamento_status, "pago");
    assert.equal(reserva.reservation_balance_due, 0);
    assert.equal(reserva.reservation_total_amount, VALOR);

    // G. Nenhuma escrita fora do financeiro, e nenhuma outra tabela tocada.
    assert.deepEqual([...db.tabelasTocadas], ["operacional_reservas"]);
    for (const w of db.writes) {
      assert.equal(w.op, "update");
      assert.equal(
        patchSomenteFinanceiro(w.payload as Record<string, unknown>),
        true,
        "patch escapou do financeiro: " + JSON.stringify(Object.keys(w.payload as object)),
      );
    }
    // Colunas sensíveis intactas.
    assert.equal(reserva.hospede_principal, "Hospede Exemplo");
    assert.equal(reserva.meal_plan_desc, "Café da Manhã");
    assert.equal(reserva.acesso_liberado, false);
    assert.equal(reserva.pagamento_presencial_diferido_efetivado, false);
    ok("G. gravou só colunas financeiras, só em operacional_reservas");

    // F2. Segunda passada no mesmo estado: nada a escrever.
    const writesAntes = db.writes.length;
    const r2 = await reconciliarFinanceiroDaReserva({
      admin: db.admin,
      externalId: EXTERNO,
      synced: synced(),
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.atualizado, false);
    assert.equal(r2.motivo, "local_ja_coerente");
    assert.equal(db.writes.length, writesAntes, "segunda passada não escreveu nada");
    ok("F2. rodar de novo não gera escrita — idempotente de ponta a ponta");
}

async function blocoNaoMaterializada() {
  console.log("\n== Reserva ainda não materializada não é assunto desta função ==");
    const db = fakeDb(null);
    const r = await reconciliarFinanceiroDaReserva({
      admin: db.admin,
      externalId: EXTERNO,
      synced: synced(),
    });
    assert.equal(r.ok, true);
    assert.equal(r.atualizado, false);
    assert.equal(r.motivo, "reserva_nao_materializada");
    assert.equal(db.writes.length, 0);
    ok("sem linha local, nenhuma escrita e nenhum erro");
}

async function blocoCorrida() {
  console.log("\n== Corrida com o Pagar.me: a versão local vence ==");
    // O update leva `.eq("reservation_balance_due", <valor lido>)`. Simulamos o
    // Pagar.me alterando o saldo entre a leitura e a escrita: o filtro não casa.
    const db = fakeDb({
      pagamento_status: "pendente",
      reservation_balance_due: VALOR,
    });
    // O Pagar.me reduz o saldo DEPOIS que a reconciliação já leu o estado:
    // interceptamos a resolução da leitura, não a montagem da query.
    const originalFrom = db.admin.from;
    let jaInterferiu = false;
    (db.admin as { from: (t: string) => unknown }).from = (t: string) => {
      const q = originalFrom(t) as Record<string, unknown>;
      const thenOriginal = q.then as (r: (v: unknown) => unknown, j?: unknown) => unknown;
      q.then = (res: (v: unknown) => unknown, rej?: unknown) =>
        thenOriginal.call(
          q,
          (valor: unknown) => {
            if (!jaInterferiu) {
              jaInterferiu = true;
              db.reservas[0]!.reservation_balance_due = 300;
            }
            return res(valor);
          },
          rej,
        );
      return q;
    };

    const r = await reconciliarFinanceiroDaReserva({
      admin: db.admin,
      externalId: EXTERNO,
      synced: synced(),
    });
    assert.equal(r.ok, true);
    assert.equal(r.atualizado, false);
    assert.equal(r.motivo, "corrida_saldo_mudou");
    assert.equal(db.reservas[0]!.reservation_balance_due, 300, "saldo do Pagar.me preservado");
    assert.equal(db.reservas[0]!.pagamento_status, "pendente", "status local não foi forçado");
    ok("trava otimista impede sobrescrever redução concorrente");
}

console.log("\n== Ciclo: reconciliação usa o detalhe já lido, sem GET extra ==");
{
  const ciclo = read("src/lib/integrations/hits/hits-contato-sync.ts");
  const codigo = semComentarios(ciclo);

  // A fase financeira roda sobre ja_locais, com detalhes.get(id) — o mesmo
  // Map que o ciclo já preencheu na leitura do snapshot.
  assert.match(
    codigo,
    /for \(const id of plano\.ja_locais\) \{[\s\S]{0,1200}reconciliarFinanceiroDaReserva\(\{ admin, externalId: id, synced, log \}\)/,
    "financeiro deve rodar dentro do loop de ja_locais",
  );
  // Nenhuma busca nova ao HITS na fase financeira.
  const faseFinanceira = codigo.slice(
    codigo.indexOf("out.financeiro.avaliadas"),
    codigo.indexOf("// 3."),
  );
  assert.doesNotMatch(faseFinanceira, /buscarGuestRevenues|fetch|fetchHits/, "sem GET extra");
  assert.match(codigo, /financeiro: \{ avaliadas: 0, atualizadas: 0, erros: 0 \}/);
  ok("fase financeira reaproveita o detalhe do ciclo, sem rede");
}

console.log("\n== Escopo: nada além do financeiro ==");
{
  const dominio = semComentarios(read("src/lib/domain/yes-hotel/reservation-financial-reconciliation.ts"));
  const helperCompleto = read("src/lib/integrations/hits/hits-materializar.ts");
  const helper = semComentarios(
    helperCompleto.slice(helperCompleto.indexOf("export async function reconciliarFinanceiroDaReserva")),
  );

  // A lista de colunas gravaveis é fechada e é só financeiro.
  assert.deepEqual([...COLUNAS_FINANCEIRAS_RECONCILIAVEIS], [
    "pagamento_status",
    "reservation_balance_due",
    "reservation_total_amount",
    "classificacao_comissionamento",
    "classificacao_comissionamento_origem",
  ]);
  assert.equal(patchSomenteFinanceiro({ pagamento_status: "pago" }), true);
  assert.equal(patchSomenteFinanceiro({ acesso_liberado: true }), false);
  assert.equal(patchSomenteFinanceiro({ pagamento_status: "pago", hospede_principal: "x" }), false);

  const proibidos = [
    /fnrh/i,
    /link_token/i,
    /senha/i,
    /ttlock/i,
    /\btag\b/i,
    /acesso_liberado/i,
    /operacional_hospedes/,
    /meal_plan_desc/,
    /whatsapp/i,
    /pagamento_presencial_diferido/,
    /cobranca|pagarme/i,
    /cron\.schedule/,
  ];
  for (const padrao of proibidos) {
    assert.doesNotMatch(dominio, padrao, `domínio toca ${padrao}`);
    assert.doesNotMatch(helper, padrao, `helper toca ${padrao}`);
  }
  // Nenhum envio, nenhuma chamada de rede, nenhuma escrita no HITS.
  for (const padrao of [/fetch\(/, /send-/, /digisac/i, /resend/i, /\.post\(/, /method: "P/]) {
    assert.doesNotMatch(helper, padrao, `helper faz saída de rede: ${padrao}`);
  }
  // Única tabela tocada.
  const tabelas = [...helper.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tabelas)], ["operacional_reservas"]);
  ok("nem FNRH, nem senha, nem TTLock, nem TAG, nem contato, nem hóspedes, nem Pagar.me");

  // O backfill one-shot original continua de pé: ele resolve a criação, e a
  // reconciliação resolve o depois. Um não substitui o outro.
  assert.match(
    semComentarios(helperCompleto),
    /\.update\(financeiroHits\)[\s\S]{0,120}\.is\("reservation_balance_due", null\)/,
    "backfill de materialização preservado",
  );
  ok("backfill original intacto: a reconciliação é adição, não substituição");
}

async function bloco3281() {
  console.log("\n== Caso real 3281: ponta a ponta ==");
    // Números conferidos por mim no gateway PROD, GET /v1/reservations/3281:
    // reservationBalanceDue = 0, reservationTotalAmount = 1069.50, crédito total.
    const db = fakeDb({
      pagamento_status: "pendente",
      reservation_balance_due: VALOR,
      reservation_total_amount: VALOR,
      classificacao_comissionamento: "nao_comissionada",
      classificacao_comissionamento_origem: "hits_campo",
    });
    const r = await reconciliarFinanceiroDaReserva({
      admin: db.admin,
      externalId: EXTERNO,
      synced: synced({ reservationBalanceDue: 0, reservationTotalAmount: VALOR }),
    });
    assert.equal(r.atualizado, true);
    assert.equal(db.reservas[0]!.pagamento_status, "pago");
    assert.equal(db.reservas[0]!.reservation_balance_due, 0);
    assert.equal(db.reservas[0]!.reservation_total_amount, VALOR);
    ok("3281 passa de pendente para pago com saldo 0 e total 1069,50");
}

async function main() {
  await blocoEscritaReal();
  await blocoNaoMaterializada();
  await blocoCorrida();
  await bloco3281();
}

main()
  .then(() => {
    console.log("\nReconciliação financeira HITS: todos os testes passaram.\n");
  })
  .catch((erro) => {
    console.error(erro);
    process.exitCode = 1;
  });
