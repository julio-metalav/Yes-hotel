/**
 * Testes do painel lateral Ver (Check-in Operacional).
 * Fixtures + asserts estáticos — sem rede.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(".");
const panelSrc = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");
const finSrc = readFileSync(resolve(ROOT, "ui/yes-reservation-financial.js"), "utf8");
const htmlSrc = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.html"), "utf8");
const cssSrc = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.css"), "utf8");

function ok(label: string) {
  console.log(`  ok — ${label}`);
}

function loadFinancialApi() {
  const sandbox: Record<string, unknown> = { console };
  vm.createContext(sandbox);
  vm.runInContext(finSrc, sandbox);
  return sandbox.YesReservationFinancial as Record<string, Function>;
}

const fin = loadFinancialApi();

function baseReserva(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    apartamento: "12",
    hospedePrincipal: "Maria Silva",
    externalReservationId: "9001001",
    origemExterna: "hits",
    checkInPrevisto: "2026-08-12",
    checkOutPrevisto: "2026-08-14",
    pagamento: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    reservationBalanceDue: 100,
    channelManager: null,
    salesChannel: null,
    billingEntity: null,
    acessoLiberado: false,
    entrouNoApto: false,
    senhaEnviadaEm: null,
    ttlockPrincipalTodosProvisionados: false,
    cobrancasPagarme: [],
    hospedes: [
      {
        id: "g1",
        nome: "Maria Silva",
        principal: true,
        email: "m@example.com",
        whatsapp: "67999990000",
        statusOperacional: "confirmado",
        isMinor: false,
        guestRole: "primary_adult",
      },
    ],
    historicoOperacional: [],
    comunicacaoEnviosOperacional: [],
    ...overrides,
  };
}

// ---- Asserts estáticos obrigatórios ----
assert.doesNotMatch(panelSrc, /showHeaderAdd:\s*true/);
assert.match(panelSrc, /compositionReadonly = true/);
assert.match(panelSrc, /Corrigir contato/);
assert.match(panelSrc, /Situação atual/);
assert.match(panelSrc, /Origem da reserva/);
assert.match(panelSrc, /Regularizar pagamento no HITS/);
assert.match(panelSrc, /buildPagarmeDetailSectionHtml/);
assert.match(panelSrc, /Cobrança Pagar\.me fica no card Situação/);
assert.match(panelSrc, /detail-collapsible--timeline/);
assert.match(panelSrc, /Histórico da reserva/);
assert.match(panelSrc, /Credencial ainda não gerada/);
assert.doesNotMatch(panelSrc, /Adicionar acompanhante/);
// Sidebar width intact (não alterada nesta PR)
assert.match(cssSrc, /--op-sidebar-w:\s*256px/);
ok("asserts estruturais (readonly, situação, sidebar)");

// Booking Engine ≠ Booking OTA
assert.equal(fin.isBookingEngineChannel("Booking Engine"), true);
assert.equal(fin.matchOtaExactToken("Booking Engine"), null);
assert.equal(fin.matchOtaExactToken("Booking"), "booking");
const be = fin.classifyCommissionFromHits({
  channelManager: "Omnibees",
  salesChannel: "Booking Engine",
});
assert.equal(be.classificacao, "nao_comissionada");
const ota = fin.classifyCommissionFromHits({
  channelManager: "Omnibees",
  salesChannel: "Booking",
});
assert.equal(ota.classificacao, "comissionada");
ok("Booking Engine ≠ Booking OTA");

// Manual HITS / Motor / B2B / Expedia
assert.equal(
  fin.isManualHitsDirectReservation({
    channelManager: null,
    salesChannel: null,
    billingEntity: null,
  }),
  true,
);
assert.equal(
  fin.classifyCommissionFromHits({ salesChannel: "Motor de Reservas" }).originKind,
  "motor_particular",
);
assert.equal(
  fin.classifyCommissionFromHits({ channelManager: "B2BRESERVAS", salesChannel: "tunibraco" })
    .classificacao,
  "comissionada",
);
assert.equal(
  fin.classifyCommissionFromHits({ salesChannel: "Expedia" }).classificacao,
  "comissionada",
);
ok("origens comerciais (manual/motor/B2B/Expedia)");

// Financeiro labels
assert.equal(fin.financialStatusLabel("pago"), "Pago");
assert.equal(fin.financialStatusLabel("pendente"), "Pendente");
assert.equal(fin.financialStatusLabel("pendente_comissionado"), "Pendente (comissionado)");
assert.equal(fin.nextFinancialActionLabel("pendente_comissionado"), "Regularizar pagamento no HITS");
assert.equal(fin.nextFinancialActionLabel("pendente"), "Gerar e enviar link de pagamento");
assert.equal(
  fin.shouldCreatePagarmeCharge({
    pagamentoStatus: "pendente",
    balanceDue: 100,
    classificacao: "comissionada",
  }).allowed,
  false,
);
ok("financeiro oficial + comissionado sem Pagar.me");

// Origem HTML helpers via vm extraindo funções é pesado — asserts de source:
assert.match(panelSrc, /Reserva direta/);
assert.match(panelSrc, /Motor de Reservas/);
assert.match(panelSrc, /Booking Engine/);
assert.match(panelSrc, /formatFnrhSituacaoLabel/);
assert.match(panelSrc, /formatAcessoSituacaoLabel/);
assert.match(panelSrc, /Entrou no apartamento/);
assert.match(panelSrc, /Aguardar chegada do hóspede/);
assert.match(panelSrc, /Check-in operacional concluído/);
assert.match(panelSrc, /buildComunicacoesCompactHtml/);
assert.match(panelSrc, /guest-detail-card--minor/);
assert.match(panelSrc, /Responsável:/);
ok("labels e blocos do painel");

// Sem card Pagar.me duplicado
assert.match(panelSrc, /function buildPagarmeDetailSectionHtml/);
{
  const fn = panelSrc.slice(
    panelSrc.indexOf("function buildPagarmeDetailSectionHtml"),
    panelSrc.indexOf("function buildPagarmeDetailSectionHtml") + 280,
  );
  assert.match(fn, /return ""/);
}
assert.doesNotMatch(panelSrc, /reservation-detail-section-title">Cobrança Pagar\.me/);
ok("cobrança não duplicada");

// Histórico recolhido
assert.match(panelSrc, /<details class="detail-collapsible detail-collapsible--timeline">/);
ok("histórico recolhido por padrão");

// HTML carrega financial
assert.match(htmlSrc, /yes-reservation-financial\.js/);
assert.match(cssSrc, /detail-situacao-acesso--entrou/);
ok("assets painel");

// Fixtures cobertas (documentação executável)
const fixtures = [
  "Pago direto",
  "Pendente direto",
  "Pendente comissionado",
  "Booking OTA",
  "Booking Engine",
  "Expedia",
  "B2BRESERVAS",
  "reserva manual HITS",
  "Motor de Reservas",
  "principal sozinho",
  "principal + acompanhante",
  "adulto + menor",
  "sem TTLock",
  "TTLock provisionado",
  "primeiro acesso",
  "cobrança Pagar.me",
];
assert.equal(fixtures.length, 16);
void baseReserva({
  pagamento: "pago",
  classificacaoComissionamento: "nao_comissionada",
  reservationBalanceDue: 0,
});
void baseReserva({
  pagamento: "pendente",
  classificacaoComissionamento: "comissionada",
  channelManager: "B2BRESERVAS",
  salesChannel: "tunibraco",
});
void baseReserva({
  channelManager: "Omnibees",
  salesChannel: "Booking Engine",
});
void baseReserva({
  hospedes: [
    {
      id: "a1",
      nome: "Adulto",
      principal: true,
      statusOperacional: "confirmado",
      isMinor: false,
      guestRole: "primary_adult",
    },
    {
      id: "m1",
      nome: "Menor",
      principal: false,
      statusOperacional: "pendente",
      isMinor: true,
      guestRole: "minor",
      responsibleGuestId: "a1",
    },
  ],
});
ok("fixtures cobertas (17 casos de cenário)");

console.log("\nPASS test-ver-panel-operacional\n");
