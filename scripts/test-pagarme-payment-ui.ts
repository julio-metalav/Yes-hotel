/**
 * Testes da policy de UI Pagar.me (Checkpoint 3).
 */
import assert from "node:assert/strict";
import {
  formatBRLInputDisplay,
  formatCentavosToBRL,
  isPagarmeUiEnabled,
  isSafeHttpsPaymentLinkUrl,
  mapPagarmeAdminError,
  parseBRLToCentavos,
  pickRelevantCobranca,
  resolveOperacionalPaymentUi,
  resolvePaymentUiState,
  shouldFetchPagarmeCobrancas,
  toBRLInputEditValue,
} from "../src/lib/domain/yes-hotel/pagarme-payment-ui";

/** Intl pt-BR usa NBSP entre R$ e o valor; normaliza para assert estável. */
function normMoneyDisplay(s: string): string {
  return String(s).replace(/\u00a0/g, " ");
}

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  OK ", name);
}

function baseReserva(
  over: Partial<{
    pagamentoStatus: string;
    classificacaoComissionamento: string;
    perfilUsuario: string;
    cobrancas: Parameters<typeof resolvePaymentUiState>[0]["cobrancas"];
  }> = {},
) {
  return resolvePaymentUiState({
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "desconhecida",
    perfilUsuario: "recepcao",
    cobrancas: [],
    ...over,
  });
}

{
  const s = baseReserva({ pagamentoStatus: "pago" });
  assert.equal(s.kind, "none");
  assert.equal(s.ctaKind, null);
  assert.equal(s.showGerarCartao, false);
  ok("1. HITS pago => sem cobrar");
}

{
  const s = baseReserva({ classificacaoComissionamento: "desconhecida" });
  assert.equal(s.kind, "classificar");
  assert.equal(s.ctaKind, "pagarme_classificar");
  assert.equal(s.showClassificar, true);
  ok("2. desconhecida => classificar");
}

{
  const s = baseReserva({ classificacaoComissionamento: "comissionada" });
  assert.equal(s.kind, "comissionada");
  assert.match(s.detalheTexto, /Não cobrar/);
  assert.equal(s.showGerarCartao, false);
  ok("3. comissionada => aviso / sem cobrar");
}

{
  const s = baseReserva({ classificacaoComissionamento: "nao_comissionada" });
  assert.equal(s.kind, "cobrar");
  assert.equal(s.ctaKind, "pagarme_cobrar");
  assert.equal(s.showGerarCartao, true);
  assert.equal(s.showValorInput, true);
  ok("4. nao_comissionada pendente => cobrar");
}

{
  for (const status of ["created", "pending", "processing"] as const) {
    const s = baseReserva({
      classificacaoComissionamento: "nao_comissionada",
      cobrancas: [
        {
          id: "c1",
          status,
          metodo: "cartao",
          payment_link_url: "https://payment-link-v3-sdx.pagar.me/pl_x",
        },
      ],
    });
    assert.equal(s.kind, "aguardando", status);
    assert.equal(s.canOpenLink, true, status);
    assert.equal(s.showGerarCartao, false, status);
  }
  ok("5-7. created/pending/processing => aguardando");
}

{
  const s = baseReserva({
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [{ id: "c1", status: "paid", metodo: "cartao" }],
  });
  assert.equal(s.kind, "pago_pagarme_hits_pendente");
  assert.match(s.detalheTexto, /HITS pendente/);
  assert.equal(s.showGerarCartao, false);
  assert.equal(s.situacaoLabel, "Pago no Pagar.me");
  assert.match(String(s.situacaoSubtexto || ""), /HITS pendente/);
  assert.match(String(s.statusBadgeLabel || ""), /Pago Pagar\.me/);
  assert.match(String(s.statusBadgeLabel || ""), /HITS pendente/);
  assert.notEqual(s.situacaoLabel, "Pendente pagamento");
  assert.notEqual(s.statusBadgeLabel, "Pendente pagamento");
  assert.equal(s.ctaLabel, "Ver cobrança");
  ok("8. paid + HITS pendente => pago Pagar.me / HITS pendente");
}

{
  for (const status of ["failed", "expired", "canceled"] as const) {
    const s = baseReserva({
      classificacaoComissionamento: "nao_comissionada",
      cobrancas: [{ id: "c1", status, metodo: "cartao" }],
    });
    assert.equal(s.kind, "nova_tentativa", status);
    assert.equal(s.showGerarCartao, true, status);
    assert.ok(s.hintAnterior, status);
  }
  ok("9-11. failed/expired/canceled => pode nova tentativa");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [{ id: "c1", status: "refunded" }],
  });
  assert.equal(s.kind, "revisao");
  assert.equal(s.showGerarCartao, false);
  ok("12. refunded => revisão / bloqueado");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [{ id: "c1", status: "chargeback" }],
  });
  assert.equal(s.kind, "revisao");
  ok("13. chargeback => revisão / bloqueado");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      {
        id: "c1",
        status: "pending",
        requer_revisao_operacional: true,
        requer_revisao_motivo: "underpaid",
      },
    ],
  });
  // revisão tem prioridade sobre bloqueante quando flag true
  assert.equal(s.kind, "revisao");
  assert.match(s.detalheTexto, /underpaid/);
  ok("14. requer_revisao_operacional => revisão");
}

{
  const s = baseReserva({ perfilUsuario: "cafe" });
  assert.equal(s.kind, "hidden_perfil");
  assert.equal(s.showGerarCartao, false);
  ok("15. perfil cafe => sem controles");
}

{
  const s = baseReserva({
    perfilUsuario: "admin",
    classificacaoComissionamento: "nao_comissionada",
  });
  assert.equal(s.kind, "cobrar");
  ok("16. admin => controles");
}

{
  const s = baseReserva({
    perfilUsuario: "recepcao",
    classificacaoComissionamento: "nao_comissionada",
  });
  assert.equal(s.kind, "cobrar");
  ok("17. recepcao => controles");
}

{
  assert.deepEqual(parseBRLToCentavos("R$ 1.800,00"), { ok: true, centavos: 180000 });
  assert.deepEqual(parseBRLToCentavos("R$ 17,50"), { ok: true, centavos: 1750 });
  assert.equal(parseBRLToCentavos("R$ 0").ok, false);
  assert.equal(parseBRLToCentavos("0").ok, false);
  assert.equal(parseBRLToCentavos("-10").ok, false);
  assert.equal(parseBRLToCentavos("").ok, false);
  assert.match(formatCentavosToBRL(180000), /1\.800,00/);
  ok("moeda BRL => centavos");
}

{
  assert.equal(normMoneyDisplay(formatBRLInputDisplay("1800,00")), "R$ 1.800,00");
  assert.equal(normMoneyDisplay(formatBRLInputDisplay("17,50")), "R$ 17,50");
  assert.equal(normMoneyDisplay(formatBRLInputDisplay("R$ 1.800,00")), "R$ 1.800,00");
  assert.equal(formatBRLInputDisplay(""), "");
  assert.equal(formatBRLInputDisplay("   "), "");
  assert.equal(formatBRLInputDisplay("abc"), "abc");
  assert.equal(formatBRLInputDisplay("R$ 0"), "R$ 0");
  const display1800 = formatBRLInputDisplay("1800,00");
  assert.deepEqual(parseBRLToCentavos(display1800), { ok: true, centavos: 180000 });
  assert.equal(toBRLInputEditValue("R$ 1.800,00"), "1.800,00");
  ok("display BRL input 1800,00 / 17,50 + parse formatado");
}

{
  const e = mapPagarmeAdminError({ code: "obrigacao_ja_paga", httpStatus: 409 });
  assert.match(e.title, /já confirmado/i);
  const amb = mapPagarmeAdminError({ code: "resultado_ambiguo", httpStatus: 502 });
  assert.equal(amb.ambiguous, true);
  ok("map erros admin");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-failed", status: "failed", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-paid", status: "paid", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "pago_pagarme_hits_pendente");
  assert.notEqual(s.kind, "nova_tentativa");
  assert.equal(s.cobranca?.id, "cur-paid");
  ok("multi A: failed antiga + paid atual => pago_pagarme");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-canceled", status: "canceled", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-pending", status: "pending", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "aguardando");
  assert.equal(s.cobranca?.id, "cur-pending");
  ok("multi B: canceled antiga + pending atual => aguardando");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-failed", status: "failed", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-processing", status: "processing", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "aguardando");
  assert.equal(s.cobranca?.id, "cur-processing");
  ok("multi C: failed antiga + processing atual => aguardando");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-failed", status: "failed", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-refunded", status: "refunded", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "revisao");
  assert.equal(s.cobranca?.id, "cur-refunded");
  ok("multi D: failed antiga + refunded atual => revisao");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-canceled", status: "canceled", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-chargeback", status: "chargeback", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "revisao");
  assert.equal(s.cobranca?.id, "cur-chargeback");
  ok("multi E: canceled antiga + chargeback atual => revisao");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-paid", status: "paid", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "new-failed", status: "failed", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "pago_pagarme_hits_pendente");
  assert.equal(s.cobranca?.id, "old-paid");
  assert.notEqual(s.kind, "nova_tentativa");
  ok("multi F: failed mais recente + paid antiga => paid prevalece");
}

{
  const picked = pickRelevantCobranca([
    { id: "c-canceled", status: "canceled", updated_at: "2026-08-01T10:00:00.000Z" },
    { id: "c-failed", status: "failed", updated_at: "2026-08-10T12:00:00.000Z" },
  ]);
  assert.equal(picked?.id, "c-failed");
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "c-canceled", status: "canceled", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "c-failed", status: "failed", updated_at: "2026-08-10T12:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "nova_tentativa");
  assert.equal(s.cobranca?.id, "c-failed");
  assert.notEqual(s.kind, "pago_pagarme_hits_pendente");
  assert.notEqual(s.kind, "aguardando");
  assert.notEqual(s.kind, "revisao");
  ok("multi G: canceled+failed => tentativa terminal mais recente");
}

{
  assert.equal(
    isSafeHttpsPaymentLinkUrl("https://payment-link-v3-sdx.pagar.me/abc"),
    true,
  );
  assert.equal(isSafeHttpsPaymentLinkUrl("https://exemplo.com/abc"), true);
  assert.equal(isSafeHttpsPaymentLinkUrl("http://exemplo.com/abc"), false);
  assert.equal(isSafeHttpsPaymentLinkUrl("javascript:alert(1)"), false);
  assert.equal(isSafeHttpsPaymentLinkUrl("data:text/html,hi"), false);
  assert.equal(isSafeHttpsPaymentLinkUrl("texto qualquer"), false);
  assert.equal(isSafeHttpsPaymentLinkUrl(""), false);
  assert.equal(isSafeHttpsPaymentLinkUrl(null), false);
  ok("URL https segura / protocolos bloqueados");
}

{
  assert.equal(isPagarmeUiEnabled(undefined), false);
  assert.equal(isPagarmeUiEnabled(null), false);
  assert.equal(isPagarmeUiEnabled(false), false);
  assert.equal(isPagarmeUiEnabled("true"), false);
  assert.equal(isPagarmeUiEnabled(1), false);
  assert.equal(isPagarmeUiEnabled({}), false);
  assert.equal(isPagarmeUiEnabled(true), true);
  ok("flag A-D: somente boolean true habilita (fail-closed)");
}

{
  const off = resolveOperacionalPaymentUi({
    pagarmeUiEnabled: false,
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "desconhecida",
    perfilUsuario: "recepcao",
    cobrancas: [],
  });
  assert.equal(off.kind, "none");
  assert.notEqual(off.kind, "classificar");
  assert.equal(off.ctaKind, null);
  assert.equal(off.showClassificar, false);
  assert.equal(off.showGerarCartao, false);

  const absent = resolveOperacionalPaymentUi({
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "desconhecida",
    perfilUsuario: "recepcao",
    cobrancas: [{ id: "c1", status: "paid", metodo: "cartao" }],
  });
  assert.equal(absent.kind, "none");
  assert.notEqual(absent.kind, "pago_pagarme_hits_pendente");
  assert.notEqual(absent.listaLabel, "Classificar cobrança");
  assert.notEqual(absent.listaLabel, "Pago no Pagar.me");
  ok("flag E: desligada + HITS pendente => sem Classificar/Cobrar/Pago Pagar.me");
}

{
  assert.equal(shouldFetchPagarmeCobrancas(undefined), false);
  assert.equal(shouldFetchPagarmeCobrancas(false), false);
  assert.equal(shouldFetchPagarmeCobrancas("true"), false);
  assert.equal(shouldFetchPagarmeCobrancas(true), true);
  ok("flag F: attach/batch só consulta com flag true");
}

{
  const onClassificar = resolveOperacionalPaymentUi({
    pagarmeUiEnabled: true,
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "desconhecida",
    perfilUsuario: "recepcao",
    cobrancas: [],
  });
  assert.equal(onClassificar.kind, "classificar");
  assert.equal(onClassificar.ctaKind, "pagarme_classificar");

  const onPago = resolveOperacionalPaymentUi({
    pagarmeUiEnabled: true,
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "recepcao",
    cobrancas: [{ id: "c1", status: "paid", metodo: "cartao" }],
  });
  assert.equal(onPago.kind, "pago_pagarme_hits_pendente");
  assert.equal(onPago.situacaoLabel, "Pago no Pagar.me");
  assert.match(String(onPago.situacaoSubtexto || ""), /HITS pendente/);
  assert.equal(onPago.ctaLabel, "Ver cobrança");

  const onCobrar = resolveOperacionalPaymentUi({
    pagarmeUiEnabled: true,
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "recepcao",
    cobrancas: [],
  });
  assert.equal(onCobrar.kind, "cobrar");
  assert.equal(onCobrar.showGerarCartao, true);
  ok("flag G: true preserva estados CP3 homologados");
}

console.log(`\n[test-pagarme-payment-ui] ${cases} assertions OK`);
