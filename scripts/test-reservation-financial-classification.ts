/**
 * Testes do classificador financeiro HITS + estados Pago/Pendente/Pendente (comissionado).
 * Inclui Booking Engine vs Booking OTA e reserva manual HITS.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyCommissionFromHits,
  isBookingEngineChannel,
  isFinanceiramenteLiberadoParaAcesso,
  mapPaymentStatusFromBalanceDue,
  matchOtaExactToken,
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
      ? {
          classificacao: input.cls as "comissionada" | "nao_comissionada" | "desconhecida",
          reason: "forced" as const,
          matchedOtaId: null,
          originKind: "unknown" as const,
        }
      : classifyCommissionFromHits({
          channelManager: input.channelManager,
          salesChannel: input.salesChannel,
          companyName: input.companyName ?? input.salesChannel,
          integrator: input.channelManager,
        });
  const pay =
    input.pay ?? mapPaymentStatusFromBalanceDue(input.balance, "desconhecido");
  const status = resolveFinancialStatusVisible({
    pagamentoStatus: pay,
    balanceDue: input.balance,
    classificacao: classified.classificacao,
  });
  return { ...classified, pay, status };
}

// --- Defesa crítica: Booking Engine ≠ Booking OTA ---
assert.equal(isBookingEngineChannel("Booking Engine"), true);
assert.equal(matchOtaExactToken("Booking Engine"), null);
assert.equal(matchOtaExactToken("Booking"), "booking");
assert.equal(matchOtaExactToken("Booking.com"), "booking");
assert.notEqual(matchOtaExactToken("Booking Engine"), matchOtaExactToken("Booking"));

// Proibido padrão includes("booking") no código executável (ignora comentários)
{
  const stripComments = (s: string) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const src = stripComments(
    readFileSync(resolve("src/lib/domain/yes-hotel/reservation-financial-classification.ts"), "utf8"),
  );
  const ui = stripComments(readFileSync(resolve("ui/yes-reservation-financial.js"), "utf8"));
  assert.doesNotMatch(src, /\.includes\(\s*["']booking["']\s*\)/i);
  assert.doesNotMatch(src, /\/\\bbooking/i);
  assert.doesNotMatch(ui, /\.includes\(\s*["']booking["']\s*\)/i);
  assert.doesNotMatch(ui, /\/\\bbooking/i);
}

// 1. Booking OTA + saldo > 0 → Pendente (comissionado)
{
  const r = fin({ balance: 150, salesChannel: "Booking" });
  assert.equal(r.classificacao, "comissionada");
  assert.equal(r.status, "pendente_comissionado");
}
{
  const r = fin({ balance: 150, salesChannel: "Booking.com", channelManager: "Omnibees" });
  assert.equal(r.status, "pendente_comissionado");
}

// 2. Omnibees + Booking Engine + saldo > 0 → Pendente, não comissionada
{
  const r = fin({
    balance: 220,
    channelManager: "Omnibees",
    salesChannel: "Booking Engine",
  });
  assert.equal(r.classificacao, "nao_comissionada");
  assert.equal(r.reason, "booking_engine_direta");
  assert.equal(r.originKind, "booking_engine");
  assert.equal(r.status, "pendente");
  assert.equal(
    shouldCreatePagarmeCharge({
      pagamentoStatus: "pendente",
      balanceDue: 220,
      classificacao: "nao_comissionada",
    }).allowed,
    true,
  );
}

// 3. Booking Engine jamais casa com Booking OTA
{
  const engine = classifyCommissionFromHits({
    channelManager: "Omnibees",
    salesChannel: "Booking Engine",
  });
  const ota = classifyCommissionFromHits({
    channelManager: "Omnibees",
    salesChannel: "Booking",
  });
  assert.equal(engine.classificacao, "nao_comissionada");
  assert.equal(ota.classificacao, "comissionada");
  assert.notEqual(engine.classificacao, ota.classificacao);
}

// 4. B2B + qualquer canal → Pendente (comissionado)
{
  const r = fin({
    balance: 200,
    channelManager: "B2BRESERVAS",
    salesChannel: "tunibraco",
  });
  assert.equal(r.status, "pendente_comissionado");
}
{
  const r = fin({
    balance: 80,
    channelManager: "B2BRESERVAS",
    salesChannel: "Maringá Turismo",
  });
  assert.equal(r.status, "pendente_comissionado");
}

// 5. manager/channel vazios → Pendente normal (direta manual HITS)
{
  const r = fin({ balance: 90, channelManager: "", salesChannel: "" });
  assert.equal(r.classificacao, "nao_comissionada");
  assert.equal(r.reason, "manual_hits_direta");
  assert.equal(r.originKind, "manual_hits");
  assert.equal(r.status, "pendente");
}

// 6. Expedia/Hotels.com → Pendente (comissionado)
{
  const r = fin({ balance: 10, salesChannel: "Expedia/Hotels.com" });
  assert.equal(r.status, "pendente_comissionado");
}
for (const ch of ["Expedia", "Hotels.com", "Airbnb"]) {
  const r = fin({ balance: 10, salesChannel: ch });
  assert.equal(r.status, "pendente_comissionado", ch);
}

// 7. Motor de Reservas/Particular → Pendente
{
  const r = fin({
    balance: 300,
    salesChannel: "Motor de Reservas",
    companyName: "Particular - Sem documento",
  });
  assert.equal(r.classificacao, "nao_comissionada");
  assert.equal(r.status, "pendente");
}

// 8. desconhecido → Pendente normal
{
  const r = fin({
    balance: 50,
    channelManager: "CanalXpto",
    salesChannel: "ParceiroDesconhecido",
  });
  assert.equal(r.classificacao, "nao_comissionada");
  assert.equal(r.status, "pendente");
}

// 9. qualquer origem + saldo zero → Pago
{
  assert.equal(fin({ balance: 0, salesChannel: "Booking" }).status, "pago");
  assert.equal(
    fin({ balance: 0, channelManager: "Omnibees", salesChannel: "Booking Engine" }).status,
    "pago",
  );
  assert.equal(fin({ balance: 0, channelManager: "B2BRESERVAS", salesChannel: "x" }).status, "pago");
  assert.equal(fin({ balance: 0, channelManager: "", salesChannel: "" }).status, "pago");
  assert.equal(mapPaymentStatusFromBalanceDue(0), "pago");
}

// 10. comissionada não gera Pagar.me
{
  const gate = shouldCreatePagarmeCharge({
    pagamentoStatus: "pendente",
    balanceDue: 100,
    classificacao: "comissionada",
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "comissionada_bloqueada");
}

// 11. comissionada não bloqueia acesso
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

assert.equal(nextFinancialActionLabel("pendente"), "Gerar e enviar link de pagamento");
assert.equal(nextFinancialActionLabel("pendente_comissionado"), "Regularizar pagamento no HITS");
assert.equal(nextFinancialActionLabel("pago"), null);

console.log("ok: test-reservation-financial-classification");
