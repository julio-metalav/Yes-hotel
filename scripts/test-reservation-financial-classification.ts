/**
 * Testes do classificador financeiro HITS + estados Pago/Pendente/Pendente (comissionado).
 */
import assert from "node:assert/strict";
import {
  classifyCommissionFromHits,
  isFinanceiramenteLiberadoParaAcesso,
  mapPaymentStatusFromBalanceDue,
  nextFinancialActionLabel,
  resolveFinancialStatusVisible,
  shouldCreatePagarmeCharge,
} from "../src/lib/domain/yes-hotel/reservation-financial-classification.ts";

function fin(input: {
  balance?: number | null;
  pay?: string;
  cls?: string;
  channelManager?: string;
  salesChannel?: string;
  companyName?: string;
}) {
  const classified =
    input.cls != null
      ? { classificacao: input.cls as "comissionada" | "nao_comissionada" | "desconhecida" }
      : classifyCommissionFromHits({
          channelManager: input.channelManager,
          salesChannel: input.salesChannel,
          companyName: input.companyName ?? input.salesChannel,
          integrator: input.channelManager,
        });
  const pay =
    input.pay ??
    mapPaymentStatusFromBalanceDue(input.balance, "desconhecido");
  const status = resolveFinancialStatusVisible({
    pagamentoStatus: pay,
    balanceDue: input.balance,
    classificacao: classified.classificacao,
  });
  return { ...classified, pay, status };
}

// 1. saldo zero + Booking → Pago
{
  const r = fin({ balance: 0, salesChannel: "Booking", channelManager: "Omnibees" });
  assert.equal(r.status, "pago");
  assert.equal(r.classificacao, "comissionada");
}

// 2. saldo > 0 + Booking → Pendente (comissionado)
{
  const r = fin({ balance: 150, salesChannel: "Booking" });
  assert.equal(r.status, "pendente_comissionado");
}

// 3–5 OTAs
for (const ch of ["Expedia", "Hotels.com", "Airbnb"]) {
  const r = fin({ balance: 10, salesChannel: ch });
  assert.equal(r.status, "pendente_comissionado", ch);
}

// Expedia/Hotels.com composto
{
  const r = fin({ balance: 10, salesChannel: "Expedia/Hotels.com" });
  assert.equal(r.status, "pendente_comissionado");
}

// 6. B2B / tunibraco
{
  const r = fin({
    balance: 200,
    channelManager: "B2BRESERVAS",
    salesChannel: "tunibraco",
  });
  assert.equal(r.classificacao, "comissionada");
  assert.equal(r.status, "pendente_comissionado");
}

// 7. B2B / Maringá
{
  const r = fin({
    balance: 80,
    channelManager: "B2BRESERVAS",
    salesChannel: "Maringá Turismo",
  });
  assert.equal(r.status, "pendente_comissionado");
}

// 8. Motor / Particular → Pendente
{
  const r = fin({
    balance: 300,
    salesChannel: "Motor de Reservas",
    companyName: "Particular - Sem documento",
  });
  assert.equal(r.classificacao, "nao_comissionada");
  assert.equal(r.status, "pendente");
}

// 9. saldo zero + B2B → Pago
{
  const r = fin({
    balance: 0,
    channelManager: "B2BRESERVAS",
    salesChannel: "tunibraco",
  });
  assert.equal(r.status, "pago");
}

// 10. desconhecido + saldo > 0 → Pendente normal
{
  const r = fin({
    balance: 50,
    channelManager: "CanalXpto",
    salesChannel: "ParceiroDesconhecido",
  });
  assert.equal(r.classificacao, "nao_comissionada");
  assert.equal(r.status, "pendente");
}

// 11. Pendente comissionado não bloqueia acesso
{
  assert.equal(
    isFinanceiramenteLiberadoParaAcesso({
      pagamentoStatus: "pendente",
      balanceDue: 100,
      classificacao: "comissionada",
    }),
    true,
  );
}

// 12. Pendente comissionado não gera Pagar.me
{
  const gate = shouldCreatePagarmeCharge({
    pagamentoStatus: "pendente",
    balanceDue: 100,
    classificacao: "comissionada",
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "comissionada_bloqueada");
}

// 13. Pendente normal preserva cobrança
{
  const gate = shouldCreatePagarmeCharge({
    pagamentoStatus: "pendente",
    balanceDue: 100,
    classificacao: "nao_comissionada",
  });
  assert.equal(gate.allowed, true);
  assert.equal(
    isFinanceiramenteLiberadoParaAcesso({
      pagamentoStatus: "pendente",
      balanceDue: 100,
      classificacao: "nao_comissionada",
    }),
    false,
  );
}

// 14. saldo → zero na sync → Pago
{
  const before = fin({ balance: 90, salesChannel: "Booking" });
  assert.equal(before.status, "pendente_comissionado");
  const after = fin({ balance: 0, salesChannel: "Booking" });
  assert.equal(after.status, "pago");
  assert.equal(mapPaymentStatusFromBalanceDue(0), "pago");
}

assert.equal(nextFinancialActionLabel("pendente"), "Gerar e enviar link de pagamento");
assert.equal(nextFinancialActionLabel("pendente_comissionado"), "Regularizar pagamento no HITS");
assert.equal(nextFinancialActionLabel("pago"), null);

console.log("ok: test-reservation-financial-classification");
