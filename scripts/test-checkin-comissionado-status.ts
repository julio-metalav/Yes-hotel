/**
 * Regressão: STATUS da lista para pago / pendente / pendente comissionado.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  financialStatusLabel,
  resolveFinancialStatusVisible,
} from "../src/lib/domain/yes-hotel/reservation-financial-classification.ts";

const panelSrc = readFileSync(resolve("ui/checkin-operacional-mvp.js"), "utf8");
const cssSrc = readFileSync(resolve("ui/checkin-operacional-mvp.css"), "utf8");

/** Espelha a prioridade de derivarStatusOperacional (trecho financeiro). */
function statusFromFinancial(finStatus: string): { label: string; type: string } {
  if (finStatus === "pendente_comissionado") {
    return { label: "Pendente (comissionado)", type: "pendente-comissionado" };
  }
  if (finStatus === "pendente") {
    return { label: "Pendente pagamento", type: "pendente-pagamento" };
  }
  if (finStatus === "pago") {
    // Após o trecho financeiro, o painel segue FNRH/acesso; label "Pago" vem do financeiro.
    return { label: financialStatusLabel("pago"), type: "pago" };
  }
  return { label: "—", type: "neutral" };
}

{
  const pago = resolveFinancialStatusVisible({
    pagamentoStatus: "pago",
    balanceDue: 0,
    classificacao: "nao_comissionada",
  });
  assert.equal(pago, "pago");
  assert.equal(statusFromFinancial(pago).label, "Pago");
}

{
  const pend = resolveFinancialStatusVisible({
    pagamentoStatus: "pendente",
    balanceDue: 10,
    classificacao: "nao_comissionada",
  });
  assert.equal(pend, "pendente");
  assert.deepEqual(statusFromFinancial(pend), {
    label: "Pendente pagamento",
    type: "pendente-pagamento",
  });
}

{
  const com = resolveFinancialStatusVisible({
    pagamentoStatus: "pendente",
    balanceDue: 10,
    classificacao: "comissionada",
  });
  assert.equal(com, "pendente_comissionado");
  assert.deepEqual(statusFromFinancial(com), {
    label: "Pendente (comissionado)",
    type: "pendente-comissionado",
  });
  assert.equal(financialStatusLabel(com), "Pendente (comissionado)");
}

// Fonte do painel: comissionado antes do badge vermelho de cobrança.
const idxFn = panelSrc.indexOf("function derivarStatusOperacional");
assert.ok(idxFn > 0);
const slice = panelSrc.slice(idxFn, idxFn + 900);
assert.match(slice, /pendente_comissionado/);
assert.match(slice, /Pendente \(comissionado\)/);
assert.match(slice, /pendente-comissionado/);
const idxCom = slice.indexOf('pendente_comissionado');
const idxPagLabel = slice.indexOf("Pendente pagamento");
assert.ok(idxCom >= 0 && idxPagLabel > idxCom, "comissionado deve preceder Pendente pagamento");

assert.match(cssSrc, /op-badge--pend-comiss/);
assert.match(panelSrc, /op-badge--pend-comiss/);
assert.doesNotMatch(
  panelSrc,
  /isPagarmeDirectPaymentBadgeType[\s\S]{0,80}pendente-comissionado/,
);

console.log("ok: test-checkin-comissionado-status");
